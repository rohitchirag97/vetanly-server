import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeRecoverableRepaymentsTable as repayments,
  employeeRecoverablesTable as recoverables,
  organizationPayrollSettingsTable,
  userOrganizationsTable,
  usersTable,
  type RecoverableStatus,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  getEmployeeMembership,
  MANAGER_ROLES,
  requireRole,
  isOrganizationManager,
} from "@/services/access.services";
import { managerIds, notify } from "@/services/notification.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createRecoverableSchema,
  createRepaymentSchema,
  listRecoverablesQuerySchema,
  reviewRepaymentSchema,
  updateRecoverableStatusSchema,
} from "@/validator/recoverable.validator";

export const toCents = (value: string | number) => Math.round(Number(value) * 100);
export const fromCents = (cents: number) => (cents / 100).toFixed(2);

const transitions: Record<string, RecoverableStatus[]> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: ["disbursed", "cancelled"],
};

const repayableStatuses: RecoverableStatus[] = ["disbursed", "active"];

export const totalDueCents = (row: {
  principalAmount: string;
  installmentCount: number | null;
  installmentAmount: string | null;
}) =>
  Math.max(
    toCents(row.principalAmount),
    (row.installmentCount ?? 0) * toCents(row.installmentAmount ?? 0),
  );

const selectRecoverables = (where: SQL | undefined) =>
  db
    .select({
      id: recoverables.id,
      employeeId: userOrganizationsTable.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      type: recoverables.type,
      status: recoverables.status,
      principalAmount: recoverables.principalAmount,
      currencyCode: recoverables.currencyCode,
      annualInterestRate: recoverables.annualInterestRate,
      installmentCount: recoverables.installmentCount,
      installmentAmount: recoverables.installmentAmount,
      requestedAt: recoverables.requestedAt,
      approvedAt: recoverables.approvedAt,
      disbursedAt: recoverables.disbursedAt,
      firstRepaymentDate: recoverables.firstRepaymentDate,
      description: recoverables.description,
    })
    .from(recoverables)
    .innerJoin(
      userOrganizationsTable,
      eq(userOrganizationsTable.id, recoverables.userOrganizationId),
    )
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(where);

type RecoverableRow = Awaited<ReturnType<typeof selectRecoverables>>[number];

const withTotals = (
  rows: RecoverableRow[],
  repaidById: Map<string, number>,
) =>
  rows.map(({ fname, lname, ...row }) => {
    const repaid = repaidById.get(row.id) ?? 0;
    return {
      ...row,
      employeeName: `${fname} ${lname}`.trim(),
      totalRepaid: fromCents(repaid),
      outstanding: fromCents(Math.max(totalDueCents(row) - repaid, 0)),
    };
  });

type Recoverable = ReturnType<typeof withTotals>[number];

const repaidTotals = async (organizationId: string, ids: string[]) => {
  const totals = new Map<string, number>();
  if (ids.length === 0) return totals;
  const rows = await db
    .select({ recoverableId: repayments.recoverableId, amount: repayments.amount })
    .from(repayments)
    .where(
      and(
        eq(repayments.organizationId, organizationId),
        inArray(repayments.recoverableId, ids),
        eq(repayments.status, "confirmed"),
      ),
    );
  for (const row of rows) {
    totals.set(
      row.recoverableId,
      (totals.get(row.recoverableId) ?? 0) + toCents(row.amount),
    );
  }
  return totals;
};

const loadOne = async (organizationId: string, id: string) => {
  const [row] = await selectRecoverables(
    and(eq(recoverables.organizationId, organizationId), eq(recoverables.id, id)),
  ).limit(1);
  if (!row) return null;
  const totals = await repaidTotals(organizationId, [id]);
  return withTotals([row], totals)[0];
};

export const createRecoverable = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createRecoverableSchema>,
): Promise<ServiceResult<Recoverable>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const isManager = isOrganizationManager(access.data);
  const employeeId = isManager ? (input.employeeId ?? requesterId) : requesterId;
  if (!isManager && input.employeeId && input.employeeId !== requesterId) {
    return fail("forbidden");
  }

  const membership = await getEmployeeMembership(organizationId, employeeId);
  if (!membership || !membership.isActive) {
    return fail("not-found", "Employee not found in this organization");
  }

  let currencyCode = input.currencyCode;
  if (!currencyCode) {
    const [settings] = await db
      .select({ currencyCode: organizationPayrollSettingsTable.currencyCode })
      .from(organizationPayrollSettingsTable)
      .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
      .limit(1);
    currencyCode = settings?.currencyCode;
  }
  if (!currencyCode) {
    return fail("invalid", "Currency is required when payroll settings are not configured");
  }

  const [created] = await db
    .insert(recoverables)
    .values({
      organizationId,
      userOrganizationId: membership.id,
      type: input.type,
      status: "pending",
      principalAmount: input.principalAmount.toFixed(2),
      currencyCode,
      annualInterestRate: (isManager ? input.annualInterestRate : 0).toFixed(4),
      installmentCount: input.installmentCount,
      installmentAmount: input.installmentAmount?.toFixed(2),
      firstRepaymentDate: input.firstRepaymentDate,
      description: input.description,
    })
    .returning({ id: recoverables.id });

  const recoverable = await loadOne(organizationId, created.id);
  if (!recoverable) return fail("not-found");
  if (employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [employeeId],
      type: "loan_requested",
      title: `A ${recoverable.type} was recorded for you`,
      body: `${recoverable.currencyCode} ${recoverable.principalAmount}`,
      link: "/loans",
    });
  } else {
    await notify({
      organizationId,
      userIds: await managerIds(organizationId, requesterId),
      type: "loan_requested",
      title: `${recoverable.employeeName} requested a ${recoverable.type}`,
      body: `${recoverable.currencyCode} ${recoverable.principalAmount}`,
      link: "/loans/all",
    });
  }
  return ok(recoverable);
};

export const listRecoverables = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listRecoverablesQuerySchema>,
): Promise<ServiceResult<Recoverable[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const isManager = isOrganizationManager(access.data);
  if (!isManager && query.employeeId && query.employeeId !== requesterId) {
    return fail("forbidden");
  }
  const employeeId = isManager ? query.employeeId : requesterId;

  const conditions: SQL[] = [eq(recoverables.organizationId, organizationId)];
  if (employeeId) conditions.push(eq(userOrganizationsTable.userId, employeeId));
  if (query.type) conditions.push(eq(recoverables.type, query.type));
  if (query.status) conditions.push(eq(recoverables.status, query.status));

  const rows = await selectRecoverables(and(...conditions)).orderBy(
    desc(recoverables.requestedAt),
  );
  const totals = await repaidTotals(
    organizationId,
    rows.map((row) => row.id),
  );
  return ok(withTotals(rows, totals));
};

export const getRecoverable = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
): Promise<ServiceResult<Recoverable>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const recoverable = await loadOne(organizationId, recoverableId);
  if (!recoverable) return fail("not-found", "Record not found");
  if (!isOrganizationManager(access.data) && recoverable.employeeId !== requesterId) {
    return fail("not-found", "Record not found");
  }
  return ok(recoverable);
};

export const updateRecoverableStatus = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
  input: z.infer<typeof updateRecoverableStatusSchema>,
): Promise<ServiceResult<Recoverable>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const current = await loadOne(organizationId, recoverableId);
  if (!current) return fail("not-found", "Record not found");

  const isManager = isOrganizationManager(access.data);
  const isOwnPendingCancel =
    input.status === "cancelled" &&
    current.status === "pending" &&
    current.employeeId === requesterId;
  if (!isManager && !isOwnPendingCancel) {
    return fail(current.employeeId === requesterId ? "forbidden" : "not-found",
      current.employeeId === requesterId ? undefined : "Record not found");
  }

  if (!transitions[current.status]?.includes(input.status)) {
    return fail("conflict", `Cannot change status from ${current.status} to ${input.status}`);
  }

  const now = new Date();
  const [updated] = await db
    .update(recoverables)
    .set({
      status: input.status,
      updatedAt: now,
      ...(input.status === "approved"
        ? {
            approvedAt: now,
            ...(input.annualInterestRate !== undefined
              ? { annualInterestRate: input.annualInterestRate.toFixed(4) }
              : {}),
          }
        : {}),
      ...(input.status === "disbursed" ? { disbursedAt: now } : {}),
    })
    .where(
      and(
        eq(recoverables.id, recoverableId),
        eq(recoverables.organizationId, organizationId),
        eq(recoverables.status, current.status),
      ),
    )
    .returning({ id: recoverables.id });
  if (!updated) return fail("conflict", "Status was changed by someone else; reload and retry");

  const recoverable = await loadOne(organizationId, recoverableId);
  if (!recoverable) return fail("not-found");
  if (current.employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [current.employeeId],
      type: `loan_${input.status}`,
      title: `Your ${recoverable.type} was ${input.status}`,
      body: `${recoverable.currencyCode} ${recoverable.principalAmount}`,
      link: "/loans",
    });
  }
  return ok(recoverable);
};

export const listAllRepayments = async (
  organizationId: string,
  requesterId: string,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = isOrganizationManager(access.data);

  const conditions: SQL[] = [eq(repayments.organizationId, organizationId)];
  if (!isManager) conditions.push(eq(userOrganizationsTable.userId, requesterId));

  return ok(
    await db
      .select({
        id: repayments.id,
        recoverableId: repayments.recoverableId,
        employeeId: userOrganizationsTable.userId,
        fname: usersTable.fname,
        lname: usersTable.lname,
        type: recoverables.type,
        amount: repayments.amount,
        currencyCode: repayments.currencyCode,
        source: repayments.source,
        status: repayments.status,
        paymentMethod: repayments.paymentMethod,
        paidAt: repayments.paidAt,
        reference: repayments.reference,
        notes: repayments.notes,
        reviewedAt: repayments.reviewedAt,
        reviewNote: repayments.reviewNote,
      })
      .from(repayments)
      .innerJoin(
        recoverables,
        and(
          eq(recoverables.id, repayments.recoverableId),
          eq(recoverables.organizationId, repayments.organizationId),
        ),
      )
      .innerJoin(
        userOrganizationsTable,
        eq(userOrganizationsTable.id, recoverables.userOrganizationId),
      )
      .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
      .where(and(...conditions))
      .orderBy(desc(repayments.paidAt))
      .limit(500)
      .then((rows) =>
        rows.map(({ fname, lname, ...row }) => ({
          ...row,
          employeeName: `${fname} ${lname}`.trim(),
        })),
      ),
  );
};

export const listRepayments = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
) => {
  const recoverable = await getRecoverable(organizationId, requesterId, recoverableId);
  if (!recoverable.ok) return recoverable;
  return ok(
    await db
      .select({
        id: repayments.id,
        amount: repayments.amount,
        currencyCode: repayments.currencyCode,
        source: repayments.source,
        paidAt: repayments.paidAt,
        payrollPeriodStart: repayments.payrollPeriodStart,
        payrollPeriodEnd: repayments.payrollPeriodEnd,
        reference: repayments.reference,
        notes: repayments.notes,
        status: repayments.status,
        paymentMethod: repayments.paymentMethod,
        reviewedAt: repayments.reviewedAt,
        reviewNote: repayments.reviewNote,
      })
      .from(repayments)
      .where(
        and(
          eq(repayments.organizationId, organizationId),
          eq(repayments.recoverableId, recoverableId),
        ),
      )
      .orderBy(desc(repayments.paidAt)),
  );
};

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Locks the loan row and returns its outstanding balance from confirmed payments only.
export const lockAndMeasure = async (
  tx: Tx,
  organizationId: string,
  recoverableId: string,
) => {
  const [row] = await tx
    .select({
      status: recoverables.status,
      principalAmount: recoverables.principalAmount,
      currencyCode: recoverables.currencyCode,
      installmentCount: recoverables.installmentCount,
      installmentAmount: recoverables.installmentAmount,
    })
    .from(recoverables)
    .where(
      and(
        eq(recoverables.id, recoverableId),
        eq(recoverables.organizationId, organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) return fail("not-found", "Record not found");
  if (!repayableStatuses.includes(row.status)) {
    return fail("conflict", "Repayments can only be recorded after disbursement");
  }

  const paid = await tx
    .select({ amount: repayments.amount })
    .from(repayments)
    .where(
      and(
        eq(repayments.organizationId, organizationId),
        eq(repayments.recoverableId, recoverableId),
        eq(repayments.status, "confirmed"),
      ),
    );
  const repaidCents = paid.reduce((sum, p) => sum + toCents(p.amount), 0);
  return ok({ row, outstanding: totalDueCents(row) - repaidCents });
};

export const createRepayment = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
  input: z.infer<typeof createRepaymentSchema>,
): Promise<ServiceResult<Recoverable>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = isOrganizationManager(access.data);
  if (!isManager) {
    const own = await getRecoverable(organizationId, requesterId, recoverableId);
    if (!own.ok) return own;
    if (input.source !== "manual") return fail("forbidden");
  }

  const result = await db.transaction(async (tx): Promise<ServiceResult<null>> => {
    const locked = await lockAndMeasure(tx, organizationId, recoverableId);
    if (!locked.ok) return locked;
    const { row, outstanding } = locked.data;
    const amountCents = toCents(input.amount);
    if (amountCents > outstanding) {
      return fail("invalid", `Amount exceeds the outstanding balance of ${fromCents(outstanding)}`);
    }

    await tx.insert(repayments).values({
      organizationId,
      recoverableId,
      amount: fromCents(amountCents),
      currencyCode: row.currencyCode,
      source: isManager ? input.source : "employee",
      status: isManager ? "confirmed" : "pending",
      paymentMethod: input.paymentMethod,
      submittedByUserId: requesterId,
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      payrollPeriodStart: isManager ? input.payrollPeriodStart : undefined,
      payrollPeriodEnd: isManager ? input.payrollPeriodEnd : undefined,
      reference: input.reference,
      notes: input.notes,
      ...(isManager ? { reviewedByUserId: requesterId, reviewedAt: new Date() } : {}),
    });

    if (isManager) {
      await tx
        .update(recoverables)
        .set({
          status: amountCents === outstanding ? "completed" : "active",
          updatedAt: new Date(),
        })
        .where(eq(recoverables.id, recoverableId));
    }
    return ok(null);
  });
  if (!result.ok) return result;

  const recoverable = await loadOne(organizationId, recoverableId);
  if (!recoverable) return fail("not-found");
  if (isManager) {
    if (recoverable.employeeId !== requesterId) {
      await notify({
        organizationId,
        userIds: [recoverable.employeeId],
        type: "repayment_recorded",
        title: "A repayment was recorded on your loan",
        body: `${recoverable.currencyCode} ${input.amount}`,
        link: "/loans",
      });
    }
  } else {
    await notify({
      organizationId,
      userIds: await managerIds(organizationId, requesterId),
      type: "repayment_submitted",
      title: `${recoverable.employeeName} submitted a repayment`,
      body: `${recoverable.currencyCode} ${input.amount} awaiting confirmation`,
      link: "/installments",
    });
  }
  return ok(recoverable);
};

export const reviewRepayment = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
  repaymentId: string,
  input: z.infer<typeof reviewRepaymentSchema>,
): Promise<ServiceResult<Recoverable>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;

  const result = await db.transaction(async (tx): Promise<ServiceResult<null>> => {
    const locked = await lockAndMeasure(tx, organizationId, recoverableId);
    if (!locked.ok) return locked;
    const { outstanding } = locked.data;

    const [payment] = await tx
      .select({ amount: repayments.amount, status: repayments.status })
      .from(repayments)
      .where(
        and(
          eq(repayments.id, repaymentId),
          eq(repayments.organizationId, organizationId),
          eq(repayments.recoverableId, recoverableId),
        ),
      )
      .limit(1);
    if (!payment) return fail("not-found", "Payment not found");
    if (payment.status !== "pending") {
      return fail("conflict", "This payment has already been reviewed");
    }

    const amountCents = toCents(payment.amount);
    if (input.status === "confirmed" && amountCents > outstanding) {
      return fail("invalid", `Amount exceeds the outstanding balance of ${fromCents(outstanding)}`);
    }

    await tx
      .update(repayments)
      .set({
        status: input.status,
        reviewedByUserId: requesterId,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote,
      })
      .where(eq(repayments.id, repaymentId));

    if (input.status === "confirmed") {
      await tx
        .update(recoverables)
        .set({
          status: amountCents === outstanding ? "completed" : "active",
          updatedAt: new Date(),
        })
        .where(eq(recoverables.id, recoverableId));
    }
    return ok(null);
  });
  if (!result.ok) return result;

  const recoverable = await loadOne(organizationId, recoverableId);
  if (!recoverable) return fail("not-found");
  if (recoverable.employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [recoverable.employeeId],
      type: `repayment_${input.status}`,
      title: `Your repayment was ${input.status}`,
      body: input.reviewNote,
      link: "/loans",
    });
  }
  return ok(recoverable);
};