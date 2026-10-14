import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lte, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  expenseClaimsTable as claims,
  organizationPayrollSettingsTable,
  userOrganizationsTable,
  UserRole,
  usersTable,
  type ExpenseCategory,
} from "@/drizzle/schema";
import { ALL_ROLES, getEmployeeMembership, MANAGER_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { detectType, MAX_DOCUMENT_BYTES } from "@/services/employee-document.services";
import { managerIds, notify, peopleManagerIds } from "@/services/notification.services";
import { isFileStorageAvailable, removeFile, signedDownloadUrl, storeFile } from "@/utils/file-storage";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createExpenseClaimSchema,
  listExpenseClaimsQuerySchema,
  reviewExpenseClaimSchema,
} from "@/validator/expense.validator";

/**
 * Expense claims: an employee claims back money spent for work; an owner or admin approves it;
 * the next payroll run reimburses it (see payroll.services.ts), or it is marked paid outside payroll.
 * Finance stays with owners and admins, as for loans: HR does not review claims.
 */

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  travel: "Travel",
  fuel: "Fuel",
  food: "Food",
  accommodation: "Accommodation",
  phone_internet: "Phone & internet",
  office_supplies: "Office supplies",
  client_meeting: "Client meeting",
  medical: "Medical",
  other: "Other",
};

// Claims older than this are refused, so stale bills are not paid months later.
const MAX_CLAIM_AGE_DAYS = 180;

const columns = {
  id: claims.id,
  employeeId: userOrganizationsTable.userId,
  employeeRole: userOrganizationsTable.role,
  fname: usersTable.fname,
  lname: usersTable.lname,
  category: claims.category,
  amount: claims.amount,
  currencyCode: claims.currencyCode,
  expenseDate: claims.expenseDate,
  description: claims.description,
  status: claims.status,
  hasReceipt: claims.receiptStorageKey,
  receiptName: claims.receiptName,
  reviewedAt: claims.reviewedAt,
  reviewNote: claims.reviewNote,
  payrollRunId: claims.payrollRunId,
  paidAt: claims.paidAt,
  paymentNote: claims.paymentNote,
  createdAt: claims.createdAt,
};

const selectClaims = (where: SQL | undefined) =>
  db
    .select(columns)
    .from(claims)
    .innerJoin(userOrganizationsTable, eq(userOrganizationsTable.id, claims.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(where);

type ClaimRow = Awaited<ReturnType<typeof selectClaims>>[number];

const toClaim = ({ fname, lname, hasReceipt, ...row }: ClaimRow) => ({
  ...row,
  employeeName: `${fname} ${lname}`.trim(),
  categoryLabel: CATEGORY_LABELS[row.category],
  hasReceipt: hasReceipt !== null,
});

export type ExpenseClaim = ReturnType<typeof toClaim>;

const loadOne = async (organizationId: string, claimId: string) => {
  const [row] = await selectClaims(and(eq(claims.organizationId, organizationId), eq(claims.id, claimId))).limit(1);
  return row ? toClaim(row) : null;
};

/** Receipts need file storage; the client hides the upload when this is off. */
export const receiptsEnabled = () => isFileStorageAvailable();

export const listMyClaims = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<{ claims: ExpenseClaim[]; receiptsEnabled: boolean }>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const rows = await selectClaims(
    and(eq(claims.organizationId, organizationId), eq(userOrganizationsTable.userId, requesterId)),
  )
    .orderBy(desc(claims.createdAt))
    .limit(200);
  return ok({ claims: rows.map(toClaim), receiptsEnabled: receiptsEnabled() });
};

export const listClaims = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listExpenseClaimsQuerySchema>,
): Promise<ServiceResult<ExpenseClaim[]>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const conditions: SQL[] = [eq(claims.organizationId, organizationId)];
  // HR handles employees' claims only, never admins' or their own.
  if (access.data.role === UserRole.HR) conditions.push(eq(userOrganizationsTable.role, UserRole.EMPLOYEE));
  if (query.status) conditions.push(eq(claims.status, query.status));
  if (query.employeeId) conditions.push(eq(userOrganizationsTable.userId, query.employeeId));
  const rows = await selectClaims(and(...conditions)).orderBy(desc(claims.createdAt)).limit(500);
  return ok(rows.map(toClaim));
};

export const createClaim = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createExpenseClaimSchema>,
  receipt: File | null,
): Promise<ServiceResult<ExpenseClaim>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const membership = await getEmployeeMembership(organizationId, requesterId);
  if (!membership?.isActive) return fail("forbidden");

  const today = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - MAX_CLAIM_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (input.expenseDate > today) return fail("invalid", "The expense date cannot be in the future");
  if (input.expenseDate < oldest) {
    return fail("invalid", `Expenses older than ${MAX_CLAIM_AGE_DAYS} days cannot be claimed`);
  }

  let stored: { key: string; name: string; type: string } | null = null;
  if (receipt && receipt.size > 0) {
    if (!isFileStorageAvailable()) return fail("invalid", "Receipt uploads are not available yet");
    if (receipt.size > MAX_DOCUMENT_BYTES) return fail("invalid", "The receipt must be 5 MB or smaller");
    const data = new Uint8Array(await receipt.arrayBuffer());
    const detected = detectType(data);
    if (!detected) return fail("invalid", "Receipts must be a PDF, JPG or PNG file");
    stored = {
      key: `expense-receipts/${organizationId}/${membership.id}/${randomUUID()}.${detected.ext}`,
      name: (receipt.name || `Receipt.${detected.ext}`).slice(0, 150),
      type: detected.type,
    };
    await storeFile(stored.key, data, detected.type);
  }

  const [settings] = await db
    .select({ currencyCode: organizationPayrollSettingsTable.currencyCode })
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);

  let created: { id: string };
  try {
    [created] = await db
      .insert(claims)
      .values({
        organizationId,
        userOrganizationId: membership.id,
        category: input.category,
        amount: input.amount.toFixed(2),
        currencyCode: settings?.currencyCode ?? "INR",
        expenseDate: input.expenseDate,
        description: input.description,
        receiptStorageKey: stored?.key,
        receiptName: stored?.name,
        receiptContentType: stored?.type,
      })
      .returning({ id: claims.id });
  } catch (error) {
    if (stored) await removeFile(stored.key).catch(() => undefined);
    throw error;
  }

  const claim = await loadOne(organizationId, created.id);
  if (!claim) return fail("not-found");
  await notify({
    organizationId,
    // HR also reviews employees' claims, so they are told about those.
    userIds:
      membership.role === UserRole.EMPLOYEE
        ? await peopleManagerIds(organizationId, requesterId)
        : await managerIds(organizationId, requesterId),
    type: "expense_submitted",
    title: `${claim.employeeName} submitted an expense claim`,
    body: `${claim.categoryLabel} · ${claim.currencyCode} ${claim.amount}`,
    link: "/expenses/review",
  });
  return ok(claim);
};

export const cancelClaim = async (
  organizationId: string,
  requesterId: string,
  claimId: string,
): Promise<ServiceResult<ExpenseClaim>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const current = await loadOne(organizationId, claimId);
  if (!current || current.employeeId !== requesterId) return fail("not-found", "Claim not found");
  const [updated] = await db
    .update(claims)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(claims.id, claimId), eq(claims.organizationId, organizationId), eq(claims.status, "pending")))
    .returning({ id: claims.id });
  if (!updated) return fail("conflict", "Only a pending claim can be cancelled");
  return ok((await loadOne(organizationId, claimId))!);
};

export const reviewClaim = async (
  organizationId: string,
  requesterId: string,
  claimId: string,
  input: z.infer<typeof reviewExpenseClaimSchema>,
): Promise<ServiceResult<ExpenseClaim>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const current = await loadOne(organizationId, claimId);
  if (!current) return fail("not-found", "Claim not found");
  if (access.data.role === UserRole.HR && current.employeeRole !== UserRole.EMPLOYEE) {
    return fail("not-found", "Claim not found");
  }
  // An admin cannot approve their own claim; the owner has no one above them, so they may.
  if (current.employeeId === requesterId && access.data.role !== UserRole.SUPER_ADMIN) {
    return fail("forbidden", "Another admin or the owner must review your own claim");
  }
  const [updated] = await db
    .update(claims)
    .set({
      status: input.status,
      reviewedByUserId: requesterId,
      reviewedAt: new Date(),
      reviewNote: input.note || null,
      updatedAt: new Date(),
    })
    .where(and(eq(claims.id, claimId), eq(claims.organizationId, organizationId), eq(claims.status, "pending")))
    .returning({ id: claims.id });
  if (!updated) return fail("conflict", "This claim has already been reviewed");

  const claim = (await loadOne(organizationId, claimId))!;
  if (claim.employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [claim.employeeId],
      type: `expense_${input.status}`,
      title: `Your expense claim was ${input.status}`,
      body:
        input.status === "approved"
          ? `${claim.currencyCode} ${claim.amount} will be paid with your next salary`
          : input.note || `${claim.categoryLabel} · ${claim.currencyCode} ${claim.amount}`,
      link: "/expenses",
    });
  }
  return ok(claim);
};

/** For claims settled in cash or by bank transfer, so the next payroll does not pay them again. */
export const markClaimPaid = async (
  organizationId: string,
  requesterId: string,
  claimId: string,
  note: string | undefined,
): Promise<ServiceResult<ExpenseClaim>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [updated] = await db
    .update(claims)
    .set({ status: "paid", paidAt: new Date(), paymentNote: note || "Paid outside payroll", updatedAt: new Date() })
    .where(and(eq(claims.id, claimId), eq(claims.organizationId, organizationId), eq(claims.status, "approved")))
    .returning({ id: claims.id });
  if (!updated) return fail("conflict", "Only an approved claim can be marked paid");
  const claim = (await loadOne(organizationId, claimId))!;
  if (claim.employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [claim.employeeId],
      type: "expense_paid",
      title: "Your expense claim was paid",
      body: `${claim.currencyCode} ${claim.amount}${note ? ` · ${note}` : ""}`,
      link: "/expenses",
    });
  }
  return ok(claim);
};

export const getReceiptUrl = async (
  organizationId: string,
  requesterId: string,
  claimId: string,
): Promise<ServiceResult<{ url: string; name: string }>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const [row] = await db
    .select({
      key: claims.receiptStorageKey,
      name: claims.receiptName,
      employeeId: userOrganizationsTable.userId,
      employeeRole: userOrganizationsTable.role,
    })
    .from(claims)
    .innerJoin(userOrganizationsTable, eq(userOrganizationsTable.id, claims.userOrganizationId))
    .where(and(eq(claims.organizationId, organizationId), eq(claims.id, claimId)))
    .limit(1);
  // The claimant, owners and admins, and HR for employees' claims (the ones HR reviews).
  const canView =
    row &&
    (row.employeeId === requesterId ||
      MANAGER_ROLES.includes(access.data.role) ||
      (access.data.role === UserRole.HR && row.employeeRole === UserRole.EMPLOYEE));
  if (!canView) return fail("not-found", "Claim not found");
  if (!row.key) return fail("not-found", "This claim has no receipt");
  if (!isFileStorageAvailable()) return fail("invalid", "File storage is not configured");
  return ok({ url: signedDownloadUrl(row.key), name: row.name ?? "Receipt" });
};

/** Approved, unpaid claims dated on or before the period end, for the payroll run to reimburse. */
export const loadReimbursableClaims = async (organizationId: string, periodEnd: string) =>
  db
    .select({
      id: claims.id,
      userOrganizationId: claims.userOrganizationId,
      category: claims.category,
      amount: claims.amount,
      expenseDate: claims.expenseDate,
    })
    .from(claims)
    .where(
      and(
        eq(claims.organizationId, organizationId),
        eq(claims.status, "approved"),
        lte(claims.expenseDate, periodEnd),
      ),
    );

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Marks the claims a finalized run reimbursed as paid. Returns false if any of them is no longer
 * approved (cancelled or paid elsewhere since the run was generated), so the caller can abort.
 */
export const settleClaimsInPayroll = async (tx: Tx, organizationId: string, runId: string, claimIds: string[]) => {
  if (claimIds.length === 0) return true;
  const settled = await tx
    .update(claims)
    .set({ status: "paid", paidAt: new Date(), payrollRunId: runId, paymentNote: "Paid with salary", updatedAt: new Date() })
    .where(and(eq(claims.organizationId, organizationId), inArray(claims.id, claimIds), eq(claims.status, "approved")))
    .returning({ id: claims.id });
  return settled.length === claimIds.length;
};
