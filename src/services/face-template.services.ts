import { and, eq, gt } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeFaceTemplatesTable,
  kioskDevicesTable,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";
import {
  getEmployeeMembership,
  MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import { type AuthenticatedKiosk, isEnrollmentUnlocked } from "@/services/kiosk.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  enrollFaceTemplateSchema,
  kioskDeviceInfoSchema,
  syncFaceTemplatesQuerySchema,
} from "@/validator/face-template.validator";

const MAX_ACTIVE_TEMPLATES_PER_EMPLOYEE = 5;

type SyncedTemplate = {
  id: string;
  employeeId: string;
  embedding: number[];
  modelName: string;
  modelVersion: string;
  isActive: boolean;
  updatedAt: Date;
};

export const enrollFaceTemplate = async (
  kiosk: AuthenticatedKiosk,
  input: z.infer<typeof enrollFaceTemplateSchema>,
): Promise<ServiceResult<{ id: string }>> => {
  if (!(await isEnrollmentUnlocked(kiosk.id))) {
    return fail("forbidden", "Enrollment is locked. Enter a manager's enrollment code on the kiosk.");
  }
  const membership = await getEmployeeMembership(kiosk.organizationId, input.employeeId);
  if (!membership || !membership.isActive) {
    return fail("not-found", "Employee not found in this organization");
  }

  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: employeeFaceTemplatesTable.id })
      .from(employeeFaceTemplatesTable)
      .where(
        and(
          eq(employeeFaceTemplatesTable.userOrganizationId, membership.id),
          eq(employeeFaceTemplatesTable.isActive, true),
        ),
      )
      .orderBy(employeeFaceTemplatesTable.createdAt);

    // Keep a bounded set per employee by retiring the oldest templates.
    const excess = active.length - MAX_ACTIVE_TEMPLATES_PER_EMPLOYEE + 1;
    for (const old of active.slice(0, Math.max(0, excess))) {
      await tx
        .update(employeeFaceTemplatesTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(employeeFaceTemplatesTable.id, old.id));
    }

    const [created] = await tx
      .insert(employeeFaceTemplatesTable)
      .values({
        organizationId: kiosk.organizationId,
        userOrganizationId: membership.id,
        embedding: input.embedding,
        embeddingDimension: input.embedding.length,
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        qualityScore: input.qualityScore?.toFixed(4),
        enrolledByKioskId: kiosk.id,
      })
      .returning({ id: employeeFaceTemplatesTable.id });
    return ok(created);
  });
};

export const syncFaceTemplates = async (
  kiosk: AuthenticatedKiosk,
  query: z.infer<typeof syncFaceTemplatesQuerySchema>,
): Promise<ServiceResult<{ templates: SyncedTemplate[]; syncedAt: Date }>> => {
  const syncedAt = new Date();
  const conditions = [
    eq(employeeFaceTemplatesTable.organizationId, kiosk.organizationId),
    eq(userOrganizationsTable.isActive, true),
  ];
  // Incremental sync also returns deactivated rows so the kiosk can drop them.
  if (query.since) {
    conditions.push(gt(employeeFaceTemplatesTable.updatedAt, new Date(query.since)));
  } else {
    conditions.push(eq(employeeFaceTemplatesTable.isActive, true));
  }

  const templates = await db
    .select({
      id: employeeFaceTemplatesTable.id,
      employeeId: userOrganizationsTable.userId,
      embedding: employeeFaceTemplatesTable.embedding,
      modelName: employeeFaceTemplatesTable.modelName,
      modelVersion: employeeFaceTemplatesTable.modelVersion,
      isActive: employeeFaceTemplatesTable.isActive,
      updatedAt: employeeFaceTemplatesTable.updatedAt,
    })
    .from(employeeFaceTemplatesTable)
    .innerJoin(
      userOrganizationsTable,
      eq(userOrganizationsTable.id, employeeFaceTemplatesTable.userOrganizationId),
    )
    .where(and(...conditions));

  await db
    .update(kioskDevicesTable)
    .set({ lastTemplateSyncAt: syncedAt })
    .where(eq(kioskDevicesTable.id, kiosk.id));
  return ok({ templates, syncedAt });
};

/** Active employees of the kiosk's organization, so it can pick whom to enroll and greet matches by name. */
export const listKioskEmployees = async (
  kiosk: AuthenticatedKiosk,
): Promise<ServiceResult<{ id: string; name: string; employeeCode: string | null }[]>> => {
  const rows = await db
    .select({
      id: userOrganizationsTable.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: userOrganizationsTable.employeeCode,
    })
    .from(userOrganizationsTable)
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(
      and(
        eq(userOrganizationsTable.organizationId, kiosk.organizationId),
        eq(userOrganizationsTable.isActive, true),
      ),
    )
    .orderBy(usersTable.fname, usersTable.lname);
  return ok(
    rows.map((row) => ({
      id: row.id,
      name: `${row.fname} ${row.lname}`.trim(),
      employeeCode: row.employeeCode,
    })),
  );
};

export const updateKioskDeviceInfo = async (
  kiosk: AuthenticatedKiosk,
  input: z.infer<typeof kioskDeviceInfoSchema>,
) => {
  await db
    .update(kioskDevicesTable)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(kioskDevicesTable.id, kiosk.id));
};

export type FaceEnrollmentSummary = {
  employeeId: string;
  activeTemplates: number;
};

export const listEmployeeTemplates = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<
  ServiceResult<
    {
      id: string;
      modelName: string;
      modelVersion: string;
      qualityScore: string | null;
      isActive: boolean;
      createdAt: Date;
    }[]
  >
> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const membership = await getEmployeeMembership(organizationId, employeeId);
  if (!membership) return fail("not-found", "Employee not found");
  return ok(
    await db
      .select({
        id: employeeFaceTemplatesTable.id,
        modelName: employeeFaceTemplatesTable.modelName,
        modelVersion: employeeFaceTemplatesTable.modelVersion,
        qualityScore: employeeFaceTemplatesTable.qualityScore,
        isActive: employeeFaceTemplatesTable.isActive,
        createdAt: employeeFaceTemplatesTable.createdAt,
      })
      .from(employeeFaceTemplatesTable)
      .where(eq(employeeFaceTemplatesTable.userOrganizationId, membership.id))
      .orderBy(employeeFaceTemplatesTable.createdAt),
  );
};

export const revokeEmployeeTemplates = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<{ revoked: number }>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const membership = await getEmployeeMembership(organizationId, employeeId);
  if (!membership) return fail("not-found", "Employee not found");
  const revoked = await db
    .update(employeeFaceTemplatesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(employeeFaceTemplatesTable.userOrganizationId, membership.id),
        eq(employeeFaceTemplatesTable.isActive, true),
      ),
    )
    .returning({ id: employeeFaceTemplatesTable.id });
  return ok({ revoked: revoked.length });
};
