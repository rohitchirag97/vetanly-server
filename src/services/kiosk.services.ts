import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { branchesTable, kioskDevicesTable, organizationsTable } from "@/drizzle/schema";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import { del, get, getAndDelete, set, setIfAbsent } from "@/utils/redis";
import type {
  createKioskSchema,
  updateKioskSchema,
} from "@/validator/kiosk-attendance.validator";

const columns = {
  id: kioskDevicesTable.id,
  deviceIdentifier: kioskDevicesTable.deviceIdentifier,
  name: kioskDevicesTable.name,
  locationName: kioskDevicesTable.locationName,
  branchId: kioskDevicesTable.branchId,
  isActive: kioskDevicesTable.isActive,
  lastSeenAt: kioskDevicesTable.lastSeenAt,
  createdAt: kioskDevicesTable.createdAt,
  // Only whether a device holds a key; the hash itself never leaves the server.
  paired: sql<boolean>`${kioskDevicesTable.apiKeyHash} is not null`,
};

type Kiosk = {
  id: string;
  deviceIdentifier: string;
  name: string;
  locationName: string | null;
  branchId: string | null;
  isActive: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  paired: boolean;
};

/** A kiosk may only be placed in one of this organization's active branches. */
const branchBelongs = async (organizationId: string, branchId: string | null | undefined) => {
  if (!branchId) return true;
  const [branch] = await db
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.organizationId, organizationId), eq(branchesTable.isActive, true)))
    .limit(1);
  return !!branch;
};

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const generateKey = () => randomBytes(32).toString("hex");

export const listKiosks = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<Kiosk[]>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  return ok(
    await db
      .select(columns)
      .from(kioskDevicesTable)
      .where(eq(kioskDevicesTable.organizationId, organizationId))
      .orderBy(kioskDevicesTable.name),
  );
};

export const createKiosk = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createKioskSchema>,
): Promise<ServiceResult<Kiosk & { apiKey: string }>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  if (!(await branchBelongs(organizationId, input.branchId))) return fail("invalid", "Branch not found or closed");

  const apiKey = generateKey();
  try {
    const [kiosk] = await db
      .insert(kioskDevicesTable)
      .values({ organizationId, ...input, apiKeyHash: hashKey(apiKey) })
      .returning(columns);
    return ok({ ...kiosk, apiKey });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("conflict", "A kiosk with this device identifier already exists");
    }
    throw error;
  }
};

export const updateKiosk = async (
  organizationId: string,
  requesterId: string,
  kioskId: string,
  input: z.infer<typeof updateKioskSchema>,
): Promise<ServiceResult<Kiosk>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  if (!(await branchBelongs(organizationId, input.branchId))) return fail("invalid", "Branch not found or closed");
  const [kiosk] = await db
    .update(kioskDevicesTable)
    .set({
      ...input,
      faceMatchThreshold:
        input.faceMatchThreshold === undefined || input.faceMatchThreshold === null
          ? input.faceMatchThreshold
          : input.faceMatchThreshold.toFixed(4),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(kioskDevicesTable.id, kioskId),
        eq(kioskDevicesTable.organizationId, organizationId),
      ),
    )
    .returning(columns);
  return kiosk ? ok(kiosk) : fail("not-found", "Kiosk not found");
};

export const rotateKioskKey = async (
  organizationId: string,
  requesterId: string,
  kioskId: string,
): Promise<ServiceResult<{ id: string; apiKey: string }>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const apiKey = generateKey();
  const [kiosk] = await db
    .update(kioskDevicesTable)
    .set({ apiKeyHash: hashKey(apiKey), updatedAt: new Date() })
    .where(
      and(
        eq(kioskDevicesTable.id, kioskId),
        eq(kioskDevicesTable.organizationId, organizationId),
      ),
    )
    .returning({ id: kioskDevicesTable.id });
  return kiosk ? ok({ id: kiosk.id, apiKey }) : fail("not-found", "Kiosk not found");
};

/** Drops the kiosk's key; the device is refused on its next request and returns to its pairing screen. */
export const unpairKiosk = async (
  organizationId: string,
  requesterId: string,
  kioskId: string,
): Promise<ServiceResult<{ id: string }>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [kiosk] = await db
    .update(kioskDevicesTable)
    .set({ apiKeyHash: null, updatedAt: new Date() })
    .where(and(eq(kioskDevicesTable.id, kioskId), eq(kioskDevicesTable.organizationId, organizationId)))
    .returning({ id: kioskDevicesTable.id });
  if (!kiosk) return fail("not-found", "Kiosk not found");
  // A manager session opened before unpairing must not outlive it.
  await del(enrollmentSessionKey(kiosk.id));
  return ok(kiosk);
};

const KIOSK_CODE_TTL_SECONDS = 600;
const ENROLLMENT_SESSION_SECONDS = 15 * 60;
type KioskCodeKind = "pair" | "enroll";
const codeKey = (kind: KioskCodeKind, code: string) => `kiosk-${kind}:${code}`;
const enrollmentSessionKey = (kioskId: string) => `kiosk-enroll-session:${kioskId}`;

/**
 * A short-lived 6-digit code a manager reads off the dashboard and types into the kiosk:
 * "pair" signs the device in, "enroll" unlocks face enrollment on an already paired kiosk.
 */
export const createKioskCode = async (
  organizationId: string,
  requesterId: string,
  kioskId: string,
  kind: KioskCodeKind,
): Promise<ServiceResult<{ code: string; expiresInSeconds: number }>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [kiosk] = await db
    .select({ id: kioskDevicesTable.id })
    .from(kioskDevicesTable)
    .where(
      and(
        eq(kioskDevicesTable.id, kioskId),
        eq(kioskDevicesTable.organizationId, organizationId),
        eq(kioskDevicesTable.isActive, true),
      ),
    )
    .limit(1);
  if (!kiosk) return fail("not-found", "Kiosk not found or inactive");

  // Codes are global, so retry on the rare collision with another live code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (await setIfAbsent(codeKey(kind, code), kiosk.id, KIOSK_CODE_TTL_SECONDS)) {
      return ok({ code, expiresInSeconds: KIOSK_CODE_TTL_SECONDS });
    }
  }
  throw new Error("Could not allocate a kiosk code");
};

/** Opens a 15-minute enrollment window on this kiosk when the code was issued for it. */
export const unlockEnrollment = async (
  kiosk: AuthenticatedKiosk,
  code: string,
): Promise<ServiceResult<{ expiresInSeconds: number }>> => {
  const key = codeKey("enroll", code);
  // Only consume the code when it belongs to this kiosk, so a wrong kiosk cannot burn it.
  if ((await get(key)) !== kiosk.id) return fail("invalid", "Invalid or expired enrollment code");
  await del(key);
  await set(enrollmentSessionKey(kiosk.id), "1", ENROLLMENT_SESSION_SECONDS);
  return ok({ expiresInSeconds: ENROLLMENT_SESSION_SECONDS });
};

export const isEnrollmentUnlocked = async (kioskId: string) =>
  (await get(enrollmentSessionKey(kioskId))) !== null;

/** Swaps a pairing code for fresh credentials. Rotating the key unpairs any device that held the old one. */
export const claimPairingCode = async (
  code: string,
): Promise<ServiceResult<{ kioskId: string; name: string; apiKey: string }>> => {
  const kioskId = await getAndDelete(codeKey("pair", code));
  if (!kioskId) return fail("invalid", "Invalid or expired pairing code");
  const apiKey = generateKey();
  const [kiosk] = await db
    .update(kioskDevicesTable)
    .set({ apiKeyHash: hashKey(apiKey), updatedAt: new Date() })
    .where(and(eq(kioskDevicesTable.id, kioskId), eq(kioskDevicesTable.isActive, true)))
    .returning({ id: kioskDevicesTable.id, name: kioskDevicesTable.name });
  return kiosk
    ? ok({ kioskId: kiosk.id, name: kiosk.name, apiKey })
    : fail("invalid", "Invalid or expired pairing code");
};

export type AuthenticatedKiosk = {
  id: string;
  organizationId: string;
  faceMatchThreshold: number | null;
  requireLiveness: boolean;
};

export const authenticateKiosk = async (
  kioskId: string,
  apiKey: string,
): Promise<AuthenticatedKiosk | null> => {
  const [kiosk] = await db
    .select({
      id: kioskDevicesTable.id,
      organizationId: kioskDevicesTable.organizationId,
      apiKeyHash: kioskDevicesTable.apiKeyHash,
      faceMatchThreshold: kioskDevicesTable.faceMatchThreshold,
      requireLiveness: kioskDevicesTable.requireLiveness,
    })
    .from(kioskDevicesTable)
    .innerJoin(
      organizationsTable,
      eq(organizationsTable.id, kioskDevicesTable.organizationId),
    )
    .where(
      and(
        eq(kioskDevicesTable.id, kioskId),
        eq(kioskDevicesTable.isActive, true),
        eq(organizationsTable.isActive, true),
        eq(organizationsTable.status, "active"),
      ),
    )
    .limit(1);
  if (!kiosk?.apiKeyHash) return null;

  const expected = Buffer.from(kiosk.apiKeyHash, "hex");
  const actual = Buffer.from(hashKey(apiKey), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  await db
    .update(kioskDevicesTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(kioskDevicesTable.id, kiosk.id));
  return {
    id: kiosk.id,
    organizationId: kiosk.organizationId,
    faceMatchThreshold:
      kiosk.faceMatchThreshold === null ? null : Number(kiosk.faceMatchThreshold),
    requireLiveness: kiosk.requireLiveness,
  };
};
