import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import {
  organizationsTable,
  platformBillingProfilesTable,
  platformInvoiceItemsTable,
  platformInvoicesTable,
  platformPlanOffersTable,
  platformPlansTable,
  platformSubscriptionsTable,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";
import type { PlatformActor } from "@/services/platform.services";
import { recordPlatformEvent } from "@/services/platform.services";
import db from "@/utils/db";
import { computeAccess, countBillableEmployees, getOrganizationAccess } from "@/services/billing-access.services";

type PlanInput = {
  name: string;
  description?: string;
  priceAmount: number;
  billingPeriod: "monthly" | "annual" | "five_year";
  includedEmployees: number;
  overagePrice: number;
  features: string[];
  visibility: "public" | "custom";
  isActive: boolean;
};

type BillingProfileInput = {
  legalName: string;
  gstin?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  email?: string;
  whatsappPhone?: string;
};

type InvoiceInput = {
  organizationId: string;
  taxRate: number;
  dueDate?: string;
  notes?: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
};

const money = (cents: number) => (cents / 100).toFixed(2);

export const listPlatformPlans = async (actor: PlatformActor) => {
  await recordPlatformEvent({ actor, action: "billing.plans.list.read" });
  return db.select().from(platformPlansTable).orderBy(desc(platformPlansTable.isActive), platformPlansTable.name);
};

export const createPlatformPlan = async (actor: PlatformActor, input: PlanInput) => {
  const [plan] = await db.insert(platformPlansTable).values({
    ...input,
    description: input.description || null,
    priceAmount: input.priceAmount.toFixed(2),
    overagePrice: input.overagePrice.toFixed(2),
  }).returning();
  await recordPlatformEvent({ actor, action: "billing.plan.create", afterValues: { planId: plan.id, name: plan.name } });
  return plan;
};

export const updatePlatformPlan = async (actor: PlatformActor, planId: string, patch: Partial<PlanInput>) => {
  const values: Partial<typeof platformPlansTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description || null;
  if (patch.priceAmount !== undefined) values.priceAmount = patch.priceAmount.toFixed(2);
  if (patch.billingPeriod !== undefined) values.billingPeriod = patch.billingPeriod;
  if (patch.includedEmployees !== undefined) values.includedEmployees = patch.includedEmployees;
  if (patch.overagePrice !== undefined) values.overagePrice = patch.overagePrice.toFixed(2);
  if (patch.features !== undefined) values.features = patch.features;
  if (patch.visibility !== undefined) values.visibility = patch.visibility;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  const [plan] = await db.update(platformPlansTable).set(values).where(eq(platformPlansTable.id, planId)).returning();
  if (!plan) return null;
  await recordPlatformEvent({ actor, action: "billing.plan.update", afterValues: { planId: plan.id, name: plan.name, isActive: plan.isActive } });
  return plan;
};

export const getPlatformOrganizationBilling = async (actor: PlatformActor, organizationId: string) => {
  const [profile] = await db.select().from(platformBillingProfilesTable)
    .where(eq(platformBillingProfilesTable.organizationId, organizationId)).limit(1);
  const [subscription] = await db.select({
    id: platformSubscriptionsTable.id,
    status: platformSubscriptionsTable.status,
    startsAt: platformSubscriptionsTable.startsAt,
    nextBillingAt: platformSubscriptionsTable.nextBillingAt,
    paidUntil: platformSubscriptionsTable.paidUntil,
    planId: platformPlansTable.id,
    planName: platformPlansTable.name,
    priceAmount: platformPlansTable.priceAmount,
    currencyCode: platformPlansTable.currencyCode,
    billingPeriod: platformPlansTable.billingPeriod,
  }).from(platformSubscriptionsTable)
    .innerJoin(platformPlansTable, eq(platformPlansTable.id, platformSubscriptionsTable.planId))
    .where(eq(platformSubscriptionsTable.organizationId, organizationId)).limit(1);
  const [[organization], access, billableEmployees, offers] = await Promise.all([
    db.select({ upgradeRequestedAt: organizationsTable.upgradeRequestedAt }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1),
    getOrganizationAccess(organizationId),
    countBillableEmployees(organizationId),
    db.select({ planId: platformPlanOffersTable.planId }).from(platformPlanOffersTable)
      .where(eq(platformPlanOffersTable.organizationId, organizationId)),
  ]);
  await recordPlatformEvent({ actor, action: "billing.organization.read", organizationId });
  return {
    profile: profile ?? null,
    subscription: subscription ?? null,
    access,
    billableEmployees,
    upgradeRequestedAt: organization?.upgradeRequestedAt ?? null,
    offeredPlanIds: offers.map((offer) => offer.planId),
  };
};

/** Replaces the custom plans this organization's owner can see. Public plans need no offer. */
export const savePlatformPlanOffers = async (actor: PlatformActor, organizationId: string, planIds: string[]) => {
  const uniqueIds = [...new Set(planIds)];
  const [[organization], plans] = await Promise.all([
    db.select({ id: organizationsTable.id, name: organizationsTable.name }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1),
    uniqueIds.length
      ? db.select({ id: platformPlansTable.id, visibility: platformPlansTable.visibility }).from(platformPlansTable)
        .where(inArray(platformPlansTable.id, uniqueIds))
      : [],
  ]);
  if (!organization) return { status: "organization-missing" as const };
  if (plans.length !== uniqueIds.length || plans.some((plan) => plan.visibility !== "custom")) {
    return { status: "invalid-plans" as const };
  }
  await db.transaction(async (tx) => {
    await tx.delete(platformPlanOffersTable).where(eq(platformPlanOffersTable.organizationId, organizationId));
    if (uniqueIds.length) {
      await tx.insert(platformPlanOffersTable).values(uniqueIds.map((planId) => ({ planId, organizationId })));
    }
  });
  await recordPlatformEvent({
    actor,
    action: "billing.plan_offers.save",
    organizationId,
    organizationName: organization.name,
    afterValues: { planIds: uniqueIds },
  });
  return { status: "saved" as const, offeredPlanIds: uniqueIds };
};

export const savePlatformBillingProfile = async (
  actor: PlatformActor,
  organizationId: string,
  input: BillingProfileInput,
) => {
  const [organization] = await db.select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  if (!organization) return null;
  const [profile] = await db.insert(platformBillingProfilesTable).values({
    organizationId,
    legalName: input.legalName,
    gstin: input.gstin || null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 || null,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country,
    email: input.email || null,
    whatsappPhone: input.whatsappPhone || null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: platformBillingProfilesTable.organizationId,
    set: {
      legalName: input.legalName,
      gstin: input.gstin || null,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 || null,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      country: input.country,
      email: input.email || null,
      whatsappPhone: input.whatsappPhone || null,
      updatedAt: new Date(),
    },
  }).returning();
  await recordPlatformEvent({
    actor,
    action: "billing.profile.update",
    organizationId,
    organizationName: organization.name,
    afterValues: { hasGstin: Boolean(profile.gstin), hasWhatsApp: Boolean(profile.whatsappPhone) },
  });
  return profile;
};

export const setPlatformOrganizationPlan = async (
  actor: PlatformActor,
  organizationId: string,
  input: {
    planId: string;
    status: "active" | "trial" | "past_due" | "cancelled";
    startsAt?: string;
    nextBillingAt?: string;
    paidUntil?: string;
  },
) => {
  const [[organization], [plan]] = await Promise.all([
    db.select({ id: organizationsTable.id, name: organizationsTable.name }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1),
    db.select({ id: platformPlansTable.id, name: platformPlansTable.name, isActive: platformPlansTable.isActive })
      .from(platformPlansTable).where(eq(platformPlansTable.id, input.planId)).limit(1),
  ]);
  if (!organization) return { status: "organization-missing" as const };
  if (!plan || !plan.isActive) return { status: "plan-unavailable" as const };
  const values = {
    planId: input.planId,
    status: input.status,
    startsAt: input.startsAt || new Date().toISOString().slice(0, 10),
    nextBillingAt: input.nextBillingAt || null,
    paidUntil: input.paidUntil || null,
    updatedAt: new Date(),
  };
  const subscription = await db.transaction(async (tx) => {
    const [saved] = await tx.insert(platformSubscriptionsTable).values({ organizationId, ...values })
      .onConflictDoUpdate({ target: platformSubscriptionsTable.organizationId, set: values })
      .returning();
    // A recorded paid period answers the owner's upgrade request.
    if (values.paidUntil) {
      await tx.update(organizationsTable).set({ upgradeRequestedAt: null }).where(eq(organizationsTable.id, organizationId));
    }
    return saved;
  });
  await recordPlatformEvent({
    actor,
    action: "billing.subscription.assign",
    organizationId,
    organizationName: organization.name,
    afterValues: { planId: plan.id, planName: plan.name, status: subscription.status, paidUntil: subscription.paidUntil },
  });
  return { status: "saved" as const, subscription };
};

export const listPlatformInvoices = async (
  actor: PlatformActor,
  filters: { search?: string; status?: "open" | "paid" | "void"; page: number; pageSize: number },
) => {
  await recordPlatformEvent({ actor, action: "billing.invoices.list.read" });
  const search = filters.search?.trim();
  const where = and(
    filters.status ? eq(platformInvoicesTable.status, filters.status) : undefined,
    search ? or(ilike(platformInvoicesTable.invoiceNumber, `%${search}%`), ilike(organizationsTable.name, `%${search}%`)) : undefined,
  );
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(platformInvoicesTable).innerJoin(organizationsTable, eq(organizationsTable.id, platformInvoicesTable.organizationId)).where(where);
  const rows = await db.select({
    id: platformInvoicesTable.id,
    invoiceNumber: platformInvoicesTable.invoiceNumber,
    organizationId: platformInvoicesTable.organizationId,
    organizationName: organizationsTable.name,
    status: platformInvoicesTable.status,
    currencyCode: platformInvoicesTable.currencyCode,
    subtotal: platformInvoicesTable.subtotal,
    taxAmount: platformInvoicesTable.taxAmount,
    totalAmount: platformInvoicesTable.totalAmount,
    issuedAt: platformInvoicesTable.issuedAt,
    dueDate: platformInvoicesTable.dueDate,
    paidAt: platformInvoicesTable.paidAt,
    whatsappStatus: platformInvoicesTable.whatsappStatus,
    whatsappSentAt: platformInvoicesTable.whatsappSentAt,
    whatsappError: platformInvoicesTable.whatsappError,
  }).from(platformInvoicesTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, platformInvoicesTable.organizationId))
    .where(where)
    .orderBy(desc(platformInvoicesTable.issuedAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);
  return { items: rows, page: filters.page, pageSize: filters.pageSize, total: Number(countRow?.count ?? 0) };
};

export const getPlatformInvoice = async (actor: PlatformActor, invoiceId: string) => {
  const invoice = await loadPlatformInvoice(invoiceId);
  await recordPlatformEvent({
    actor,
    action: "billing.invoice.read",
    organizationId: invoice?.organizationId,
    organizationName: invoice?.organizationName,
    afterValues: { invoiceId },
  });
  return invoice;
};

const loadPlatformInvoice = async (invoiceId: string) => {
  const [invoice] = await db.select({
    id: platformInvoicesTable.id,
    invoiceNumber: platformInvoicesTable.invoiceNumber,
    organizationId: platformInvoicesTable.organizationId,
    organizationName: organizationsTable.name,
    status: platformInvoicesTable.status,
    currencyCode: platformInvoicesTable.currencyCode,
    subtotal: platformInvoicesTable.subtotal,
    taxRate: platformInvoicesTable.taxRate,
    taxAmount: platformInvoicesTable.taxAmount,
    totalAmount: platformInvoicesTable.totalAmount,
    billTo: platformInvoicesTable.billTo,
    notes: platformInvoicesTable.notes,
    issuedAt: platformInvoicesTable.issuedAt,
    dueDate: platformInvoicesTable.dueDate,
    paidAt: platformInvoicesTable.paidAt,
    paymentMethod: platformInvoicesTable.paymentMethod,
    paymentReference: platformInvoicesTable.paymentReference,
    whatsappStatus: platformInvoicesTable.whatsappStatus,
    whatsappDestination: platformInvoicesTable.whatsappDestination,
    whatsappSentAt: platformInvoicesTable.whatsappSentAt,
    whatsappError: platformInvoicesTable.whatsappError,
  }).from(platformInvoicesTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, platformInvoicesTable.organizationId))
    .where(eq(platformInvoicesTable.id, invoiceId)).limit(1);
  if (!invoice) return null;
  const items = await db.select().from(platformInvoiceItemsTable)
    .where(eq(platformInvoiceItemsTable.invoiceId, invoiceId));
  return { ...invoice, items };
};

export const createPlatformInvoice = async (actor: PlatformActor, input: InvoiceInput) => {
  const result = await db.transaction(async (tx) => {
    const [[organization], [profile]] = await Promise.all([
      tx.select({ id: organizationsTable.id, name: organizationsTable.name }).from(organizationsTable)
        .where(eq(organizationsTable.id, input.organizationId)).limit(1),
      tx.select().from(platformBillingProfilesTable)
        .where(eq(platformBillingProfilesTable.organizationId, input.organizationId)).limit(1),
    ]);
    if (!organization) return { status: "organization-missing" as const };
    if (!profile) return { status: "billing-profile-missing" as const };

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vetanly-platform-invoice-number'))`);
    const [counter] = await tx.select({ value: sql<number>`count(*)::int` }).from(platformInvoicesTable);
    const sequence = Number(counter?.value ?? 0) + 1;

    const normalizedItems = input.items.map((item) => {
      const subtotalCents = Math.round(item.quantity * item.unitPrice * 100);
      const taxCents = Math.round(subtotalCents * input.taxRate / 100);
      return {
        description: item.description,
        quantity: item.quantity.toFixed(2),
        unitPrice: item.unitPrice.toFixed(2),
        lineSubtotal: money(subtotalCents),
        lineTax: money(taxCents),
        lineTotal: money(subtotalCents + taxCents),
        subtotalCents,
        taxCents,
      };
    });
    const subtotalCents = normalizedItems.reduce((sum, item) => sum + item.subtotalCents, 0);
    const taxCents = normalizedItems.reduce((sum, item) => sum + item.taxCents, 0);
    const invoiceNumber = `HP-${new Date().getFullYear()}-${String(sequence).padStart(6, "0")}`;
    const billTo: Record<string, string | null> = {
      legalName: profile.legalName,
      gstin: profile.gstin,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      city: profile.city,
      state: profile.state,
      postalCode: profile.postalCode,
      country: profile.country,
      email: profile.email,
      whatsappPhone: profile.whatsappPhone,
    };
    const [invoice] = await tx.insert(platformInvoicesTable).values({
      invoiceNumber,
      organizationId: organization.id,
      status: "open",
      currencyCode: "INR",
      subtotal: money(subtotalCents),
      taxRate: input.taxRate.toFixed(2),
      taxAmount: money(taxCents),
      totalAmount: money(subtotalCents + taxCents),
      billTo,
      notes: input.notes || null,
      dueDate: input.dueDate || null,
      createdByUserId: actor.id,
    }).returning();
    await tx.insert(platformInvoiceItemsTable).values(normalizedItems.map((item) => ({
      invoiceId: invoice.id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineSubtotal: item.lineSubtotal,
      lineTax: item.lineTax,
      lineTotal: item.lineTotal,
    })));
    return { status: "created" as const, invoice, organizationName: organization.name };
  });
  if (result.status !== "created") return result;
  await recordPlatformEvent({
    actor,
    action: "billing.invoice.create",
    organizationId: result.invoice.organizationId,
    organizationName: result.organizationName,
    afterValues: { invoiceId: result.invoice.id, invoiceNumber: result.invoice.invoiceNumber, totalAmount: result.invoice.totalAmount },
  });
  return { status: "created" as const, invoice: await loadPlatformInvoice(result.invoice.id) };
};

export const markPlatformInvoicePaid = async (
  actor: PlatformActor,
  invoiceId: string,
  input: { paymentMethod: "cash" | "bank_transfer" | "upi" | "other"; paymentReference?: string },
) => {
  const current = await loadPlatformInvoice(invoiceId);
  if (!current) return { status: "missing" as const };
  if (current.status !== "open") return { status: "not-open" as const, invoice: current };
  const [invoice] = await db.update(platformInvoicesTable).set({
    status: "paid",
    paidAt: new Date(),
    paymentMethod: input.paymentMethod,
    paymentReference: input.paymentReference || null,
    updatedAt: new Date(),
  }).where(and(eq(platformInvoicesTable.id, invoiceId), eq(platformInvoicesTable.status, "open"))).returning();
  if (!invoice) return { status: "not-open" as const, invoice: await loadPlatformInvoice(invoiceId) };
  await recordPlatformEvent({
    actor,
    action: "billing.invoice.mark_paid",
    organizationId: current.organizationId,
    organizationName: current.organizationName,
    afterValues: { invoiceId, paymentMethod: input.paymentMethod, paymentReference: input.paymentReference || null },
  });
  return { status: "saved" as const, invoice: await loadPlatformInvoice(invoiceId) };
};

export const voidPlatformInvoice = async (actor: PlatformActor, invoiceId: string, reason: string) => {
  const current = await loadPlatformInvoice(invoiceId);
  if (!current) return { status: "missing" as const };
  if (current.status !== "open") return { status: "not-open" as const, invoice: current };
  const [invoice] = await db.update(platformInvoicesTable).set({ status: "void", notes: [current.notes, `VOID: ${reason}`].filter(Boolean).join("\n"), updatedAt: new Date() })
    .where(and(eq(platformInvoicesTable.id, invoiceId), eq(platformInvoicesTable.status, "open"))).returning({ id: platformInvoicesTable.id });
  if (!invoice) return { status: "not-open" as const, invoice: await loadPlatformInvoice(invoiceId) };
  await recordPlatformEvent({ actor, action: "billing.invoice.void", organizationId: current.organizationId, organizationName: current.organizationName, reason, afterValues: { invoiceId } });
  return { status: "saved" as const, invoice: await loadPlatformInvoice(invoiceId) };
};

export const getPlatformInvoiceDelivery = async (invoiceId: string) => {
  const invoice = await loadPlatformInvoice(invoiceId);
  if (!invoice) return null;
  const [organizationOwner] = await db.select({ phone: usersTable.phone, name: sql<string>`concat(${usersTable.fname}, ' ', ${usersTable.lname})` })
    .from(userOrganizationsTable).innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(and(eq(userOrganizationsTable.organizationId, invoice.organizationId), eq(userOrganizationsTable.role, "super_admin")))
    .limit(1);
  const destination = invoice.billTo.whatsappPhone || organizationOwner?.phone || null;
  return { invoice, destination, recipientName: invoice.billTo.legalName || organizationOwner?.name || invoice.organizationName };
};

export const setPlatformInvoiceWhatsAppStatus = async (
  invoiceId: string,
  status: "queued" | "sent" | "failed",
  destination: string | null,
  error?: string | null,
  pdfStorageKey?: string | null,
) => {
  await db.update(platformInvoicesTable).set({
    whatsappStatus: status,
    whatsappDestination: destination,
    whatsappSentAt: status === "sent" ? new Date() : null,
    whatsappError: error?.slice(0, 500) || null,
    pdfStorageKey: pdfStorageKey ?? undefined,
    updatedAt: new Date(),
  }).where(eq(platformInvoicesTable.id, invoiceId));
};

export const getPlatformBillingOverview = async () => {
  const [[subscriptions], [invoices]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(platformSubscriptionsTable).where(eq(platformSubscriptionsTable.status, "active")),
    db.select({ count: sql<number>`count(*)::int`, outstanding: sql<string>`coalesce(sum(${platformInvoicesTable.totalAmount}), 0)::numeric(12,2)` })
      .from(platformInvoicesTable).where(eq(platformInvoicesTable.status, "open")),
  ]);
  return {
    activeSubscriptions: Number(subscriptions?.count ?? 0),
    openInvoices: Number(invoices?.count ?? 0),
    outstandingAmount: invoices?.outstanding ?? "0.00",
    attention: await listBillingAttention(),
  };
};

/**
 * Organizations that need the platform owner: an open upgrade request, a trial or paid period
 * ending within 7 days, a grace period, or read-only access. Upgrade requests come first.
 */
const listBillingAttention = async () => {
  const rows = await db.select({
    id: organizationsTable.id,
    name: organizationsTable.name,
    trialEndsAt: organizationsTable.trialEndsAt,
    upgradeRequestedAt: organizationsTable.upgradeRequestedAt,
    paidUntil: platformSubscriptionsTable.paidUntil,
    subscriptionStatus: platformSubscriptionsTable.status,
  }).from(organizationsTable)
    .leftJoin(platformSubscriptionsTable, eq(platformSubscriptionsTable.organizationId, organizationsTable.id))
    .where(eq(organizationsTable.status, "active"));
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      upgradeRequestedAt: row.upgradeRequestedAt,
      access: computeAccess(row),
    }))
    .filter(({ upgradeRequestedAt, access }) =>
      upgradeRequestedAt !== null || access.state === "grace" || access.state === "read_only" || access.daysLeft <= 7)
    .sort((a, b) =>
      Number(b.upgradeRequestedAt !== null) - Number(a.upgradeRequestedAt !== null)
      || (a.access.accessEndsAt ?? "9999").localeCompare(b.access.accessEndsAt ?? "9999"))
    .slice(0, 50);
};
