import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { kioskDevicesTable, organizationsTable } from "@/drizzle/schema";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type {
  createKioskSchema,
  updateKioskSchema,
} from "@/validator/kiosk-attendance.validator";

const columns = {
  id: kioskDevicesTable.id,
  deviceIdentifier: kioskDevicesTable.deviceIdentifier,
  name: kioskDevicesTable.name,
  locationName: kioskDevicesTable.locationName,
  isActive: kioskDevicesTable.isActive,
  lastSeenAt: kioskDevicesTable.lastSeenAt,
  createdAt: kioskDevicesTable.createdAt,
};

type Kiosk = {
  id: string;
  deviceIdentifier: string;
  name: string;
  locationName: string | null;
  isActive: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
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
