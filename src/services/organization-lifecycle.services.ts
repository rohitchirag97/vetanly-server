import { and, count, eq, isNotNull, lte, sql } from "drizzle-orm";

import db from "@/utils/db";
import {
  employeeDocumentsTable,
  expenseClaimsTable,
  organizationsTable,
  platformInvoicesTable,
  taxDeclarationItemsTable,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import { isFileStorageAvailable, removeFile } from "@/utils/file-storage";
import { fail, ok, type ServiceResult } from "@/utils/result";

export const DELETION_GRACE_DAYS = 30;

type LifecycleOrganization = {
  id: string;
  name: string;
  status: string;
  isActive: boolean;
  deactivatedAt: Date | null;
  deletionScheduledAt: Date | null;
};

/**
 * The owner manages the organization even while it is paused or scheduled for deletion, so this
 * checks the membership directly instead of requireRole, which only admits active organizations.
 */
const loadAsOwner = async (
  organizationId: string,
  userId: string,
): Promise<ServiceResult<LifecycleOrganization>> => {
  const [row] = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      status: organizationsTable.status,
      isActive: organizationsTable.isActive,
      deactivatedAt: organizationsTable.deactivatedAt,
      deletionScheduledAt: organizationsTable.deletionScheduledAt,
    })
    .from(userOrganizationsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, userOrganizationsTable.organizationId))
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.userId, userId),
        eq(userOrganizationsTable.isActive, true),
        eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN),
      ),
    )
    .limit(1);
  if (!row || row.status === "deleted") return fail("forbidden", "Only the organization owner can do this");
  if (row.status === "suspended") {
    return fail("conflict", "This organization is suspended by HazriPro. Contact support to make changes.");
  }
  return ok(row);
};

const update = async (organizationId: string, values: Partial<typeof organizationsTable.$inferInsert>) => {
  const [row] = await db
    .update(organizationsTable)
    .set(values)
    .where(eq(organizationsTable.id, organizationId))
    .returning({
      id: organizationsTable.id,
      name: organizationsTable.name,
      status: organizationsTable.status,
      isActive: organizationsTable.isActive,
      deactivatedAt: organizationsTable.deactivatedAt,
      deletionScheduledAt: organizationsTable.deletionScheduledAt,
    });
  return ok(row!);
};

/** Pauses the organization: members lose access and kiosks stop, but nothing is deleted. */
export const deactivateOrganization = async (organizationId: string, userId: string) => {
  const org = await loadAsOwner(organizationId, userId);
  if (!org.ok) return org;
  if (org.data.status === "pending_deletion") return fail("conflict", "Cancel the scheduled deletion first");
  if (!org.data.isActive) return fail("conflict", "This organization is already deactivated");
  return update(organizationId, { isActive: false, deactivatedAt: new Date() });
};

export const reactivateOrganization = async (organizationId: string, userId: string) => {
  const org = await loadAsOwner(organizationId, userId);
  if (!org.ok) return org;
  if (org.data.status === "pending_deletion") return fail("conflict", "Cancel the scheduled deletion first");
  if (org.data.isActive) return fail("conflict", "This organization is already active");
  return update(organizationId, { isActive: true, deactivatedAt: null });
};

/** Locks the organization now and erases it after the grace period, unless the owner cancels first. */
export const scheduleOrganizationDeletion = async (organizationId: string, userId: string, confirmName: string) => {
  const org = await loadAsOwner(organizationId, userId);
  if (!org.ok) return org;
  if (org.data.status === "pending_deletion") return fail("conflict", "Deletion is already scheduled");
  if (confirmName.trim() !== org.data.name.trim()) {
    return fail("invalid", "Type the organization name exactly as shown to confirm");
  }
  return update(organizationId, {
    status: "pending_deletion",
    deletionScheduledAt: new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000),
  });
};

export const cancelOrganizationDeletion = async (organizationId: string, userId: string) => {
  const org = await loadAsOwner(organizationId, userId);
  if (!org.ok) return org;
  if (org.data.status !== "pending_deletion") return fail("conflict", "No deletion is scheduled");
  // A paused organization stays paused; only the deletion is called off.
  return update(organizationId, { status: "active", deletionScheduledAt: null });
};

// Children before parents, following the foreign keys between these tables.
const PURGE_ORDER = [
  "payroll_items",
  "payroll_runs",
  "attendance_logs",
  "attendance_regularizations",
  "employee_face_templates",
  "overtime_approvals",
  "leave_requests",
  "employee_recoverable_repayments",
  "employee_recoverables",
  "employee_statutory_profiles",
  "leave_types",
  "kiosk_devices",
  "shift_swap_requests",
  "shift_roster_overrides",
  "shift_rotation_assignments",
  "shift_rotations",
  "tax_declaration_items",
  "tax_declarations",
  "tax_declaration_settings",
  "expense_claims",
  "employee_documents",
  "employee_exits",
  "employee_lifecycle_tasks",
  "employee_profiles",
  "organization_payroll_settings",
  "organization_statutory_settings",
  "holidays",
  "announcements",
  "notifications",
  "user_organizations",
  "departments",
  "shifts",
  "audit_logs",
] as const;

/**
 * Erases one organization whose deletion is due. Everything goes in one transaction, so a failure
 * leaves it untouched for the next run. GST invoices must be kept, so an organization that has any
 * keeps its row (status "deleted") with the invoices; all of its workspace data is still erased.
 */
export const purgeOrganization = async (organizationId: string) => {
  const documentKeys = [
    ...(await db
      .select({ key: employeeDocumentsTable.storageKey })
      .from(employeeDocumentsTable)
      .where(eq(employeeDocumentsTable.organizationId, organizationId))),
    ...(await db
      .select({ key: expenseClaimsTable.receiptStorageKey })
      .from(expenseClaimsTable)
      .where(and(eq(expenseClaimsTable.organizationId, organizationId), isNotNull(expenseClaimsTable.receiptStorageKey)))),
    ...(await db
      .select({ key: taxDeclarationItemsTable.proofStorageKey })
      .from(taxDeclarationItemsTable)
      .where(and(eq(taxDeclarationItemsTable.organizationId, organizationId), isNotNull(taxDeclarationItemsTable.proofStorageKey)))),
  ].filter((row): row is { key: string } => row.key !== null);

  const outcome = await db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(
        and(
          eq(organizationsTable.id, organizationId),
          eq(organizationsTable.status, "pending_deletion"),
          lte(organizationsTable.deletionScheduledAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    if (!org) return "skipped" as const;

    // Lets the audit-log guard accept deletes for this organization only, until the transaction ends.
    await tx.execute(sql`select set_config('hazripro.purge_organization_id', ${organizationId}, true)`);
    for (const table of PURGE_ORDER) {
      await tx.execute(sql`delete from ${sql.identifier(table)} where organization_id = ${organizationId}`);
    }

    const [{ invoices }] = await tx
      .select({ invoices: count() })
      .from(platformInvoicesTable)
      .where(eq(platformInvoicesTable.organizationId, organizationId));
    if (invoices > 0) {
      await tx
        .update(organizationsTable)
        .set({ status: "deleted", isActive: false, upgradeRequestedAt: null })
        .where(eq(organizationsTable.id, organizationId));
      return "kept-for-invoices" as const;
    }
    await tx.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    return "deleted" as const;
  });

  // Files go only after the database commit, so a failed purge never leaves records pointing at missing files.
  if (outcome !== "skipped" && isFileStorageAvailable()) {
    for (const { key } of documentKeys) {
      await removeFile(key).catch((error) => console.error(`[purge] could not delete file ${key}`, error));
    }
  }
  return outcome;
};

/** Daily job: erases every organization whose 30-day deletion window has passed. */
export const purgeDueOrganizations = async () => {
  const due = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(
      and(
        eq(organizationsTable.status, "pending_deletion"),
        isNotNull(organizationsTable.deletionScheduledAt),
        lte(organizationsTable.deletionScheduledAt, new Date()),
      ),
    );
  for (const { id } of due) {
    try {
      const outcome = await purgeOrganization(id);
      console.info(`[purge] organization ${id}: ${outcome}`);
    } catch (error) {
      console.error(`[purge] organization ${id} failed; it will be retried on the next run`, error);
    }
  }
};
