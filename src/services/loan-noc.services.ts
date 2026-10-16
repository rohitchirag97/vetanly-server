import { and, desc, eq } from "drizzle-orm";

import db from "@/utils/db";
import {
  employeeRecoverableRepaymentsTable as repayments,
  employeeRecoverablesTable as recoverables,
  organizationsTable,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";
import { ALL_ROLES, isOrganizationManager, MANAGER_ROLES, requireRole } from "@/services/access.services";
import { queueDelivery, sendableChannels } from "@/services/messaging.services";
import { maskEmail, maskPhone } from "@/services/messaging-template";
import { deliveryChannels, type DeliveryChannels } from "@/services/user.services";
import { requireFullAccess } from "@/services/billing-access.services";
import { fail, ok, type ServiceResult } from "@/utils/result";

export type LoanNoc = {
  reference: string;
  organizationName: string;
  employeeName: string;
  type: "loan" | "salary_advance";
  principalAmount: string;
  currencyCode: string;
  disbursedAt: string | null;
  closedAt: string;
  issuedAt: string;
};

/** NOC data and recipient. No access check; callers authorize first. */
export const loadLoanNoc = async (
  organizationId: string,
  recoverableId: string,
): Promise<ServiceResult<{ noc: LoanNoc; phone: string; email: string | null; delivery: DeliveryChannels; employeeId: string }>> => {
  const [row] = await db
    .select({
      id: recoverables.id,
      type: recoverables.type,
      status: recoverables.status,
      principalAmount: recoverables.principalAmount,
      currencyCode: recoverables.currencyCode,
      disbursedAt: recoverables.disbursedAt,
      fname: usersTable.fname,
      lname: usersTable.lname,
      phone: usersTable.phone,
      email: usersTable.email,
      emailVerified: usersTable.emailVerified,
      employeeId: usersTable.id,
      organizationName: organizationsTable.name,
    })
    .from(recoverables)
    .innerJoin(
      userOrganizationsTable,
      eq(userOrganizationsTable.id, recoverables.userOrganizationId),
    )
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .innerJoin(organizationsTable, eq(organizationsTable.id, recoverables.organizationId))
    .where(and(eq(recoverables.organizationId, organizationId), eq(recoverables.id, recoverableId)))
    .limit(1);
  if (!row) return fail("not-found", "Record not found");
  if (row.status !== "completed") {
    return fail("conflict", "A NOC can only be issued once the loan is fully repaid and closed");
  }

  const [lastPayment] = await db
    .select({ paidAt: repayments.paidAt })
    .from(repayments)
    .where(
      and(
        eq(repayments.organizationId, organizationId),
        eq(repayments.recoverableId, recoverableId),
        eq(repayments.status, "confirmed"),
      ),
    )
    .orderBy(desc(repayments.paidAt))
    .limit(1);

  return ok({
    phone: row.phone,
    email: row.email && row.emailVerified ? row.email : null,
    delivery: deliveryChannels(row),
    employeeId: row.employeeId,
    noc: {
      reference: `NOC-${row.id.slice(0, 8).toUpperCase()}`,
      organizationName: row.organizationName,
      employeeName: `${row.fname} ${row.lname}`.trim(),
      type: row.type,
      principalAmount: row.principalAmount,
      currencyCode: row.currencyCode,
      disbursedAt: row.disbursedAt ? row.disbursedAt.toISOString() : null,
      closedAt: (lastPayment?.paidAt ?? new Date()).toISOString(),
      issuedAt: new Date().toISOString(),
    },
  });
};

const authorize = async (organizationId: string, requesterId: string, recoverableId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const loaded = await loadLoanNoc(organizationId, recoverableId);
  if (!loaded.ok) return loaded;
  if (!isOrganizationManager(access.data) && loaded.data.employeeId !== requesterId) {
    return fail("not-found", "Record not found");
  }
  return loaded;
};

export const getLoanNoc = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
): Promise<ServiceResult<LoanNoc & { delivery: DeliveryChannels & { addon: boolean } }>> => {
  const loaded = await authorize(organizationId, requesterId, recoverableId);
  if (!loaded.ok) return loaded;
  return ok({ ...loaded.data.noc, delivery: await sendableChannels(organizationId, "loan_noc", loaded.data.delivery) });
};

export const requestLoanNocWhatsApp = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
): Promise<ServiceResult<null>> => {
  const loaded = await authorize(organizationId, requesterId, recoverableId);
  if (!loaded.ok) return loaded;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;
  if (!loaded.data.delivery.whatsapp) {
    return fail("invalid", "This employee has no phone number linked for WhatsApp");
  }
  const queued = await queueDelivery({
    organizationId,
    requesterId,
    channel: "whatsapp",
    messageType: "loan_noc",
    relatedId: recoverableId,
    recipientUserId: loaded.data.employeeId,
    recipientMasked: maskPhone(loaded.data.phone),
  });
  return queued.ok ? ok(null) : queued;
};

export const requestLoanNocEmail = async (
  organizationId: string,
  requesterId: string,
  recoverableId: string,
): Promise<ServiceResult<null>> => {
  const loaded = await authorize(organizationId, requesterId, recoverableId);
  if (!loaded.ok) return loaded;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;
  if (!loaded.data.delivery.email || !loaded.data.email) {
    return fail("invalid", "This employee has no Google email linked");
  }
  const queued = await queueDelivery({
    organizationId,
    requesterId,
    channel: "email",
    messageType: "loan_noc",
    relatedId: recoverableId,
    recipientUserId: loaded.data.employeeId,
    recipientMasked: maskEmail(loaded.data.email),
  });
  return queued.ok ? ok(null) : queued;
};
