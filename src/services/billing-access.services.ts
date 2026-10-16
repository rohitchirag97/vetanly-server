import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import db from "@/utils/db";
import {
  organizationsTable,
  platformPlanOffersTable,
  platformPlansTable,
  platformSubscriptionsTable,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import { ALL_ROLES, OWNER_ROLES, requireRole } from "@/services/access.services";
import { fail, ok, type ServiceResult } from "@/utils/result";

/**
 * Billing access, in order:
 * - inactive: a new organization whose owner has not started the free trial. Every request for its
 *   data is refused (see authenticate.middleware.ts) except billing and the organization's own basics.
 * - trial: free, everything on, for 14 days from when the owner starts it.
 * - paid: everything on through subscription.paid_until (inclusive, India time).
 * - grace: 7 days after the trial or paid period ends; everything still works, the owner sees a red banner.
 * - read_only: after grace. Data stays visible and attendance keeps recording, but payroll,
 *   new or reactivated employees and document sending are refused with 402.
 */
export type AccessState = "inactive" | "trial" | "paid" | "grace" | "read_only";

export type OrganizationAccess = {
  state: AccessState;
  /** Null until the owner starts the trial. */
  trialEndsAt: string | null;
  paidUntil: string | null;
  /** When full access ends: the trial end or the end of the last paid day. Null while inactive. */
  accessEndsAt: string | null;
  graceEndsAt: string | null;
  /** Whole days left in the current state; 0 when inactive or read-only. */
  daysLeft: number;
};

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
// Paid dates are calendar days for Indian customers, so a paid day ends at midnight IST.
const BUSINESS_UTC_OFFSET = "+05:30";

/** The calendar date in India for an instant. */
const indiaDate = (instant: Date) => new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);

const endOfPaidDay = (date: string) => new Date(`${date}T23:59:59.999${BUSINESS_UTC_OFFSET}`);

export const computeAccess = (
  input: { trialEndsAt: Date | null; paidUntil: string | null; subscriptionStatus: string | null },
  now: Date = new Date(),
): OrganizationAccess => {
  if (!input.trialEndsAt && !input.paidUntil) {
    return {
      state: "inactive",
      trialEndsAt: null,
      paidUntil: null,
      accessEndsAt: null,
      graceEndsAt: null,
      daysLeft: 0,
    };
  }
  const paidEnd =
    input.paidUntil && input.subscriptionStatus !== "cancelled" ? endOfPaidDay(input.paidUntil) : null;
  // A cancelled subscription with no trial has no access left at all, so it falls through to read-only.
  const ends = [input.trialEndsAt, paidEnd].filter((end): end is Date => end !== null);
  const accessEnd = ends.length ? new Date(Math.max(...ends.map((end) => end.getTime()))) : new Date(0);
  const graceEnd = new Date(accessEnd.getTime() + GRACE_DAYS * DAY_MS);
  // Whole calendar days in India time, so the count drops by one each midnight IST and the last
  // day reads 0 ("ends today"). Rounding hours up instead kept a trial started in the afternoon
  // at 14 days for most of the next day.
  const daysUntil = (when: Date) => Math.max(0, Math.round((Date.parse(indiaDate(when)) - Date.parse(indiaDate(now))) / DAY_MS));

  let state: AccessState;
  let daysLeft: number;
  if (now <= accessEnd) {
    state = paidEnd && now <= paidEnd ? "paid" : "trial";
    daysLeft = daysUntil(state === "paid" ? paidEnd! : input.trialEndsAt!);
  } else if (now <= graceEnd) {
    state = "grace";
    daysLeft = daysUntil(graceEnd);
  } else {
    state = "read_only";
    daysLeft = 0;
  }
  return {
    state,
    trialEndsAt: input.trialEndsAt?.toISOString() ?? null,
    paidUntil: input.paidUntil,
    accessEndsAt: accessEnd.toISOString(),
    graceEndsAt: graceEnd.toISOString(),
    daysLeft,
  };
};

const loadAccessRow = async (organizationId: string) => {
  const [row] = await db
    .select({
      trialEndsAt: organizationsTable.trialEndsAt,
      upgradeRequestedAt: organizationsTable.upgradeRequestedAt,
      paidUntil: platformSubscriptionsTable.paidUntil,
      subscriptionStatus: platformSubscriptionsTable.status,
      planName: platformPlansTable.name,
    })
    .from(organizationsTable)
    .leftJoin(platformSubscriptionsTable, eq(platformSubscriptionsTable.organizationId, organizationsTable.id))
    .leftJoin(platformPlansTable, eq(platformPlansTable.id, platformSubscriptionsTable.planId))
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  return row ?? null;
};

export const getOrganizationAccess = async (organizationId: string): Promise<OrganizationAccess | null> => {
  const row = await loadAccessRow(organizationId);
  return row ? computeAccess(row) : null;
};

export const TRIAL_NOT_STARTED_MESSAGE =
  "This workspace is not active yet. The owner can start the 14-day free trial to begin.";

/** Refuses a write that read-only (or not yet started) organizations may not make. Trial, paid and grace pass. */
export const requireFullAccess = async (organizationId: string): Promise<ServiceResult<null>> => {
  const access = await getOrganizationAccess(organizationId);
  if (access?.state === "inactive") return fail("payment-required", TRIAL_NOT_STARTED_MESSAGE);
  if (access?.state === "read_only") {
    return fail(
      "payment-required",
      "Your organization's plan has expired, so it is read-only. The owner can upgrade from the Billing page.",
    );
  }
  return ok(null);
};

/** Members billed per head: everyone active except the owner, unless the owner is on payroll. Mirrors payroll. */
export const countBillableEmployees = async (organizationId: string) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.isActive, true),
        or(
          ne(userOrganizationsTable.role, UserRole.SUPER_ADMIN),
          eq(userOrganizationsTable.includeInPayroll, true),
        ),
      ),
    );
  return Number(row?.count ?? 0);
};

/** Price for a period: base, plus each employee beyond those included. Flat per-employee plans use base 0, included 0. */
export const estimatePlanAmount = (
  plan: { priceAmount: string; includedEmployees: number; overagePrice: string },
  employees: number,
) => {
  const cents =
    Math.round(Number(plan.priceAmount) * 100) +
    Math.max(0, employees - plan.includedEmployees) * Math.round(Number(plan.overagePrice) * 100);
  return (cents / 100).toFixed(2);
};

export type BillingStatus = OrganizationAccess & {
  isOwner: boolean;
  planName: string | null;
  /** Owner only. */
  owner?: {
    billableEmployees: number;
    upgradeRequestedAt: string | null;
    plans: {
      id: string;
      name: string;
      description: string | null;
      currencyCode: string;
      billingPeriod: "monthly" | "annual";
      priceAmount: string;
      includedEmployees: number;
      overagePrice: string;
      estimatedAmount: string;
    }[];
  };
};

export const getBillingStatus = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<BillingStatus>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const row = await loadAccessRow(organizationId);
  if (!row) return fail("not-found", "Organization not found");

  const status: BillingStatus = {
    ...computeAccess(row),
    isOwner: OWNER_ROLES.includes(access.data.role),
    planName: row.planName,
  };
  if (!status.isOwner) return ok(status);

  const [billableEmployees, plans] = await Promise.all([
    countBillableEmployees(organizationId),
    db
      .select({
        id: platformPlansTable.id,
        name: platformPlansTable.name,
        description: platformPlansTable.description,
        currencyCode: platformPlansTable.currencyCode,
        billingPeriod: platformPlansTable.billingPeriod,
        priceAmount: platformPlansTable.priceAmount,
        includedEmployees: platformPlansTable.includedEmployees,
        overagePrice: platformPlansTable.overagePrice,
      })
      .from(platformPlansTable)
      .where(
        and(
          eq(platformPlansTable.isActive, true),
          // Custom plans appear only where offered, or where the organization is already on them.
          or(
            eq(platformPlansTable.visibility, "public"),
            inArray(
              platformPlansTable.id,
              db
                .select({ planId: platformPlanOffersTable.planId })
                .from(platformPlanOffersTable)
                .where(eq(platformPlanOffersTable.organizationId, organizationId)),
            ),
            inArray(
              platformPlansTable.id,
              db
                .select({ planId: platformSubscriptionsTable.planId })
                .from(platformSubscriptionsTable)
                .where(eq(platformSubscriptionsTable.organizationId, organizationId)),
            ),
          ),
        ),
      )
      .orderBy(platformPlansTable.billingPeriod, platformPlansTable.name),
  ]);
  status.owner = {
    billableEmployees,
    upgradeRequestedAt: row.upgradeRequestedAt?.toISOString() ?? null,
    plans: plans.map((plan) => ({ ...plan, estimatedAmount: estimatePlanAmount(plan, billableEmployees) })),
  };
  return ok(status);
};

export const requestUpgrade = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<{ upgradeRequestedAt: string }>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;
  const [row] = await db
    .update(organizationsTable)
    .set({ upgradeRequestedAt: new Date() })
    .where(eq(organizationsTable.id, organizationId))
    .returning({ upgradeRequestedAt: organizationsTable.upgradeRequestedAt });
  if (!row?.upgradeRequestedAt) return fail("not-found", "Organization not found");
  return ok({ upgradeRequestedAt: row.upgradeRequestedAt.toISOString() });
};

/** Starts the one free trial. Only the owner can, and only once: a started trial is never restarted. */
export const startTrial = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<OrganizationAccess>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;
  const [started] = await db
    .update(organizationsTable)
    .set({ trialEndsAt: sql`now() + make_interval(days => ${TRIAL_DAYS})` })
    .where(and(eq(organizationsTable.id, organizationId), isNull(organizationsTable.trialEndsAt)))
    .returning({ id: organizationsTable.id });
  if (!started) return fail("conflict", "The free trial has already been used for this organization");
  const current = await getOrganizationAccess(organizationId);
  return current ? ok(current) : fail("not-found", "Organization not found");
};
