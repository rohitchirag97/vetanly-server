import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  messageLogsTable as logs,
  messagingProvidersTable as providers,
  messagingSettingsTable as settingsTable,
  messagingTemplatesTable as templates,
  organizationsTable,
  platformMessagingSettingsTable,
  walletTopUpRequestsTable as topUps,
  walletTransactionsTable as transactions,
  UserRole,
  userOrganizationsTable,
  type MessageType,
  type MessagingChannel,
  type MessagingProviderKind,
  type MessagingRates,
} from "@/drizzle/schema";
import { isOrganizationManager, OWNER_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { VETANLY_TEMPLATES, isVetanlyWhatsAppConfigured } from "@/services/vetanly-whatsapp";
import {
  HAS_DOCUMENT,
  MESSAGE_TYPE_LABELS,
  MESSAGE_VARIABLES,
  PLACEHOLDERS,
  renderJsonBody,
  unknownPlaceholders,
} from "@/services/messaging-template";
import { notify } from "@/services/notification.services";
import { enqueueMessage } from "@/queue/producer/sendMessage";
import { encryptSecret } from "@/utils/crypto";
import { env } from "@/utils/env";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  customProviderSchema,
  listMessageLogsSchema,
  lowBalanceSchema,
  templateMappingSchema,
  topUpRequestSchema,
} from "@/validator/messaging.validator";

/**
 * The report delivery add-on: settings, the prepaid wallet, the WhatsApp provider and its template
 * mapping, the message log, and queueing a message. Owners manage it (it is billing); owners and admins
 * of the whole organization can read the log. Sending happens in services/messaging-delivery.ts.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is handled in thousandths of a rupee so per-message rates like 0.115 add up exactly.
export const toMilli = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 1000);
export const fromMilli = (milli: number) => (milli / 1000).toFixed(3);

const DEFAULT_RATES: MessagingRates = { email: 0, whatsappVetanly: 0.35, whatsappCustom: 0.05 };

export const platformRates = async (): Promise<MessagingRates> => {
  const [row] = await db.select().from(platformMessagingSettingsTable).where(eq(platformMessagingSettingsTable.id, 1)).limit(1);
  return row
    ? { email: Number(row.emailRate), whatsappVetanly: Number(row.whatsappVetanlyRate), whatsappCustom: Number(row.whatsappCustomRate) }
    : DEFAULT_RATES;
};

export const ensureSettings = async (organizationId: string, tx: Tx | typeof db = db) => {
  await tx.insert(settingsTable).values({ organizationId }).onConflictDoNothing();
  const [row] = await tx.select().from(settingsTable).where(eq(settingsTable.organizationId, organizationId)).limit(1);
  return row!;
};

const effectiveRates = (platform: MessagingRates, overrides: Partial<MessagingRates>): MessagingRates => ({
  email: overrides.email ?? platform.email,
  whatsappVetanly: overrides.whatsappVetanly ?? platform.whatsappVetanly,
  whatsappCustom: overrides.whatsappCustom ?? platform.whatsappCustom,
});

const rateFor = (rates: MessagingRates, channel: MessagingChannel, kind: MessagingProviderKind | null) =>
  channel === "email" ? rates.email : kind === "vetanly" ? rates.whatsappVetanly : rates.whatsappCustom;

const loadProvider = async (organizationId: string, providerId: string | null) => {
  if (!providerId) return null;
  const [row] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, providerId), eq(providers.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
};

export const loadTemplates = async (providerId: string) =>
  db.select().from(templates).where(eq(templates.providerId, providerId));

const webhookBase = () => (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");

/** A provider as the browser sees it: secret names only, never their values. */
const providerView = (provider: NonNullable<Awaited<ReturnType<typeof loadProvider>>>) => ({
  id: provider.id,
  kind: provider.kind,
  name: provider.name,
  config: provider.config,
  secretNames: Object.keys(provider.secrets),
  statusWebhookUrl: provider.kind === "custom_http" ? `${webhookBase()}/webhooks/messaging/${provider.webhookToken}` : null,
  lastTestAt: provider.lastTestAt,
  lastTestOk: provider.lastTestOk,
  lastTestMessage: provider.lastTestMessage,
});

// ---------- What can be sent ----------

export type DeliveryAvailability = {
  /** The add-on is on; without it documents can only be viewed and downloaded. */
  addon: boolean;
  email: boolean;
  whatsapp: boolean;
};

/** Whether this organization can send this kind of message, by channel (before the recipient is known). */
export const deliveryAvailability = async (organizationId: string, messageType: MessageType): Promise<DeliveryAvailability> => {
  const settings = await ensureSettings(organizationId);
  if (!settings.addonEnabled) return { addon: false, email: false, whatsapp: false };
  const provider = await loadProvider(organizationId, settings.whatsappProviderId);
  let whatsapp = false;
  if (provider?.kind === "vetanly") whatsapp = true;
  else if (provider?.kind === "custom_http") {
    whatsapp = (await loadTemplates(provider.id)).some((t) => t.messageType === messageType);
  }
  return { addon: true, email: true, whatsapp };
};

/**
 * What the send buttons may offer for one recipient: the add-on must be on, the channel set up, and the
 * recipient must have that channel (a real phone, a verified email).
 */
export const sendableChannels = async (organizationId: string, messageType: MessageType, recipient: { whatsapp: boolean; email: boolean }) => {
  const available = await deliveryAvailability(organizationId, messageType);
  return { addon: available.addon, whatsapp: available.whatsapp && recipient.whatsapp, email: available.email && recipient.email };
};

const notifyLowBalance = async (organizationId: string, balanceMilli: number, thresholdMilli: number, notifiedAt: Date | null) => {
  if (balanceMilli >= thresholdMilli || notifiedAt) return;
  await db.update(settingsTable).set({ lowBalanceNotifiedAt: new Date() }).where(eq(settingsTable.organizationId, organizationId));
  const owners = await db
    .select({ userId: userOrganizationsTable.userId })
    .from(userOrganizationsTable)
    .where(and(eq(userOrganizationsTable.organizationId, organizationId), eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN), eq(userOrganizationsTable.isActive, true)));
  await notify({
    organizationId,
    userIds: owners.map((o) => o.userId),
    type: "messaging_low_balance",
    title: "Your messaging balance is running low",
    body: `₹${(balanceMilli / 1000).toFixed(2)} left. Add balance so salary slips and documents keep going out.`,
    link: "/messaging",
  });
};

/**
 * Charges the wallet, logs the message and queues it. The charge is taken now so the balance can never
 * go negative, and refunded if the message finally fails.
 */
export const queueDelivery = async (input: {
  organizationId: string;
  requesterId: string;
  channel: MessagingChannel;
  messageType: Exclude<MessageType, "test">;
  relatedId: string;
  recipientUserId: string;
  recipientMasked: string;
}): Promise<ServiceResult<{ messageLogId: string }>> => {
  const settings = await ensureSettings(input.organizationId);
  if (!settings.addonEnabled) {
    return fail("payment-required", "Sending by email or WhatsApp is an add-on. The owner can turn it on from the Messaging page; documents can still be viewed and downloaded.");
  }
  const available = await deliveryAvailability(input.organizationId, input.messageType);
  if (input.channel === "whatsapp" && !available.whatsapp) {
    return fail("invalid", `WhatsApp is not set up for ${MESSAGE_TYPE_LABELS[input.messageType].toLowerCase()}s yet. The owner can set it up on the Messaging page.`);
  }
  const provider = input.channel === "whatsapp" ? await loadProvider(input.organizationId, settings.whatsappProviderId) : null;
  const rates = effectiveRates(await platformRates(), settings.rateOverrides);
  const chargeMilli = toMilli(rateFor(rates, input.channel, provider?.kind ?? null));

  const result = await db.transaction(async (tx) => {
    let balanceAfter = toMilli(settings.balance);
    if (chargeMilli > 0) {
      const [debited] = await tx
        .update(settingsTable)
        .set({ balance: sql`${settingsTable.balance} - ${fromMilli(chargeMilli)}`, updatedAt: new Date() })
        .where(and(eq(settingsTable.organizationId, input.organizationId), gte(settingsTable.balance, fromMilli(chargeMilli))))
        .returning({ balance: settingsTable.balance });
      if (!debited) return null;
      balanceAfter = toMilli(debited.balance);
    }
    const [log] = await tx
      .insert(logs)
      .values({
        organizationId: input.organizationId,
        channel: input.channel,
        providerId: provider?.id ?? null,
        providerKind: input.channel === "email" ? "email" : provider!.kind,
        messageType: input.messageType,
        relatedId: input.relatedId,
        recipientUserId: input.recipientUserId,
        recipientMasked: input.recipientMasked,
        charge: fromMilli(chargeMilli),
        requestedByUserId: input.requesterId,
      })
      .returning({ id: logs.id });
    if (chargeMilli > 0) {
      await tx.insert(transactions).values({
        organizationId: input.organizationId,
        kind: "charge",
        amount: fromMilli(-chargeMilli),
        balanceAfter: fromMilli(balanceAfter),
        messageLogId: log!.id,
        note: `${MESSAGE_TYPE_LABELS[input.messageType]} by ${input.channel === "email" ? "email" : "WhatsApp"}`,
        createdByUserId: input.requesterId,
      });
    }
    return { logId: log!.id, balanceAfter };
  });
  if (!result) {
    return fail("payment-required", `Not enough messaging balance (this message costs ₹${(chargeMilli / 1000).toFixed(2)}). The owner can add balance on the Messaging page.`);
  }
  await enqueueMessage(result.logId);
  await notifyLowBalance(input.organizationId, result.balanceAfter, toMilli(settings.lowBalanceThreshold), settings.lowBalanceNotifiedAt);
  return ok({ messageLogId: result.logId });
};

/** Returns a message's charge to the wallet once, e.g. when it finally fails. */
export const refundMessage = async (messageLogId: string, reason: string) => {
  await db.transaction(async (tx) => {
    const [log] = await tx
      .update(logs)
      .set({ refunded: true, updatedAt: new Date() })
      .where(and(eq(logs.id, messageLogId), eq(logs.refunded, false)))
      .returning({ organizationId: logs.organizationId, charge: logs.charge });
    if (!log || toMilli(log.charge) <= 0) return;
    const [credited] = await tx
      .update(settingsTable)
      .set({ balance: sql`${settingsTable.balance} + ${log.charge}`, updatedAt: new Date() })
      .where(eq(settingsTable.organizationId, log.organizationId))
      .returning({ balance: settingsTable.balance });
    await tx.insert(transactions).values({
      organizationId: log.organizationId,
      kind: "refund",
      amount: log.charge,
      balanceAfter: credited!.balance,
      messageLogId,
      note: reason.slice(0, 300),
    });
  });
};

// ---------- The owner's Messaging page ----------

const ownerAccess = (organizationId: string, requesterId: string) => requireRole(organizationId, requesterId, OWNER_ROLES);

export const getMessagingOverview = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  if (!isOrganizationManager(access.data)) return fail("forbidden");
  const settings = await ensureSettings(organizationId);
  const provider = await loadProvider(organizationId, settings.whatsappProviderId);
  const rates = effectiveRates(await platformRates(), settings.rateOverrides);
  const [pending, recent] = await Promise.all([
    db.select().from(topUps).where(and(eq(topUps.organizationId, organizationId), eq(topUps.status, "pending"))).orderBy(desc(topUps.createdAt)),
    db.select().from(transactions).where(eq(transactions.organizationId, organizationId)).orderBy(desc(transactions.createdAt)).limit(30),
  ]);
  return ok({
    isOwner: access.data.role === UserRole.SUPER_ADMIN,
    addonEnabled: settings.addonEnabled,
    addonRequestedAt: settings.addonRequestedAt,
    balance: Number(settings.balance),
    lowBalanceThreshold: Number(settings.lowBalanceThreshold),
    lowBalance: toMilli(settings.balance) < toMilli(settings.lowBalanceThreshold),
    rates,
    provider: provider ? providerView(provider) : null,
    templates: provider ? await loadTemplates(provider.id) : [],
    vetanly: { configured: isVetanlyWhatsAppConfigured(), templates: VETANLY_TEMPLATES },
    messageTypes: (["salary_slip", "loan_noc", "test"] as MessageType[]).map((type) => ({
      type,
      label: MESSAGE_TYPE_LABELS[type],
      hasDocument: HAS_DOCUMENT[type],
      variables: MESSAGE_VARIABLES[type],
    })),
    placeholders: PLACEHOLDERS,
    pendingTopUps: pending,
    transactions: recent,
  });
};

export const requestAddon = async (organizationId: string, requesterId: string) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  if (settings.addonEnabled) return fail("conflict", "The add-on is already on");
  await db.update(settingsTable).set({ addonRequestedAt: new Date(), updatedAt: new Date() }).where(eq(settingsTable.organizationId, organizationId));
  return ok({ requested: true });
};

/** Switches WhatsApp to Vetanly's own service. Keeps nothing of a previous custom provider. */
export const useVetanlyProvider = async (organizationId: string, requesterId: string) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  const current = await loadProvider(organizationId, settings.whatsappProviderId);
  if (current?.kind === "vetanly") return ok({ id: current.id });
  const [created] = await db
    .insert(providers)
    .values({ organizationId, kind: "vetanly", name: "Vetanly WhatsApp", webhookToken: randomBytes(24).toString("hex") })
    .returning({ id: providers.id });
  await db.update(settingsTable).set({ whatsappProviderId: created!.id, updatedAt: new Date() }).where(eq(settingsTable.organizationId, organizationId));
  if (current) await db.delete(providers).where(eq(providers.id, current.id));
  return ok({ id: created!.id });
};

/** Saves the organization's own provider (any HTTP API). Secrets left out keep their saved value; null removes one. */
export const saveCustomProvider = async (organizationId: string, requesterId: string, input: z.infer<typeof customProviderSchema>) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  const current = await loadProvider(organizationId, settings.whatsappProviderId);
  const existing = current?.kind === "custom_http" ? current : null;

  const secrets: Record<string, string> = { ...(existing?.secrets ?? {}) };
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (value === null || value === "") delete secrets[name];
    else secrets[name] = encryptSecret(value);
  }
  const secretNames = Object.keys(secrets);
  const unknown = [input.config.bodyTemplate, input.config.url, ...input.config.headers.map((h) => h.value)].flatMap((text) => unknownPlaceholders(text, secretNames));
  if (unknown.length) return fail("invalid", `Unknown placeholders: ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")}`);
  try {
    renderJsonBody(input.config.bodyTemplate, {
      phone: "919876543210",
      recipientName: "Test",
      template: "t",
      language: "en",
      params: ["a", "b"],
      documentUrl: "https://example.com/a.pdf",
      documentFilename: "a.pdf",
      reference: "ref",
      secrets: Object.fromEntries(secretNames.map((n) => [n, "x"])),
    });
  } catch {
    return fail("invalid", "The request body is not valid JSON once the placeholders are filled in. Put text placeholders inside quotes, and {{params_json}} without quotes.");
  }

  const values = { kind: "custom_http" as const, name: input.name, config: input.config, secrets, updatedAt: new Date() };
  let id = existing?.id;
  if (existing) {
    await db.update(providers).set(values).where(eq(providers.id, existing.id));
  } else {
    const [created] = await db.insert(providers).values({ organizationId, ...values, webhookToken: randomBytes(24).toString("hex") }).returning({ id: providers.id });
    id = created!.id;
    await db.update(settingsTable).set({ whatsappProviderId: id, updatedAt: new Date() }).where(eq(settingsTable.organizationId, organizationId));
    if (current) await db.delete(providers).where(eq(providers.id, current.id));
  }
  return ok({ id: id! });
};

export const removeProvider = async (organizationId: string, requesterId: string) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  if (!settings.whatsappProviderId) return ok(null);
  await db.update(settingsTable).set({ whatsappProviderId: null, updatedAt: new Date() }).where(eq(settingsTable.organizationId, organizationId));
  await db.delete(providers).where(and(eq(providers.id, settings.whatsappProviderId), eq(providers.organizationId, organizationId)));
  return ok(null);
};

/** Maps Vetanly's messages to the custom provider's templates. A message left out is not sent by WhatsApp. */
export const saveTemplateMapping = async (organizationId: string, requesterId: string, input: z.infer<typeof templateMappingSchema>) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  const provider = await loadProvider(organizationId, settings.whatsappProviderId);
  if (provider?.kind !== "custom_http") return fail("conflict", "Template mapping is for your own provider; Vetanly WhatsApp uses its own templates");
  for (const mapping of input.templates) {
    const allowed = MESSAGE_VARIABLES[mapping.messageType].map((v) => v.key);
    const bad = mapping.params.filter((p) => !allowed.includes(p));
    if (bad.length) return fail("invalid", `${MESSAGE_TYPE_LABELS[mapping.messageType]}: unknown variables ${bad.join(", ")}`);
  }
  await db.transaction(async (tx) => {
    await tx.delete(templates).where(eq(templates.providerId, provider.id));
    if (input.templates.length) {
      await tx.insert(templates).values(
        input.templates.map((t) => ({ organizationId, providerId: provider.id, messageType: t.messageType, templateName: t.templateName, language: t.language, params: t.params })),
      );
    }
  });
  return ok(await loadTemplates(provider.id));
};

export const saveLowBalanceThreshold = async (organizationId: string, requesterId: string, input: z.infer<typeof lowBalanceSchema>) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  await ensureSettings(organizationId);
  await db
    .update(settingsTable)
    .set({ lowBalanceThreshold: input.threshold.toFixed(2), lowBalanceNotifiedAt: null, updatedAt: new Date() })
    .where(eq(settingsTable.organizationId, organizationId));
  return ok({ threshold: input.threshold });
};

export const requestTopUp = async (organizationId: string, requesterId: string, input: z.infer<typeof topUpRequestSchema>) => {
  const access = await ownerAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const [open] = await db.select({ n: count() }).from(topUps).where(and(eq(topUps.organizationId, organizationId), eq(topUps.status, "pending")));
  if ((open?.n ?? 0) >= 3) return fail("conflict", "You already have top-up requests waiting. We'll add the balance once payment is received.");
  const [created] = await db
    .insert(topUps)
    .values({ organizationId, amount: input.amount.toFixed(2), note: input.note || null, requestedByUserId: requesterId })
    .returning();
  return ok(created!);
};

export const listMessageLogs = async (organizationId: string, requesterId: string, query: z.infer<typeof listMessageLogsSchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  if (!isOrganizationManager(access.data)) return fail("forbidden");
  const conditions: SQL[] = [eq(logs.organizationId, organizationId)];
  if (query.status) conditions.push(eq(logs.status, query.status));
  if (query.channel) conditions.push(eq(logs.channel, query.channel));
  if (query.messageType) conditions.push(eq(logs.messageType, query.messageType));
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    db.select().from(logs).where(where).orderBy(desc(logs.createdAt)).limit(query.limit).offset(query.offset),
    db.select({ n: count() }).from(logs).where(where),
  ]);
  return ok({ total: total?.n ?? 0, logs: rows.map(({ testDestination: _, ...row }) => row) });
};

// ---------- Platform console ----------

export const platformMessagingOverview = async () => {
  const [rates, pending] = await Promise.all([
    platformRates(),
    db
      .select({ request: topUps, organizationName: organizationsTable.name })
      .from(topUps)
      .innerJoin(organizationsTable, eq(organizationsTable.id, topUps.organizationId))
      .where(eq(topUps.status, "pending"))
      .orderBy(topUps.createdAt),
  ]);
  const addonRequests = await db
    .select({ organizationId: settingsTable.organizationId, requestedAt: settingsTable.addonRequestedAt, name: organizationsTable.name })
    .from(settingsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, settingsTable.organizationId))
    .where(and(eq(settingsTable.addonEnabled, false), sql`${settingsTable.addonRequestedAt} is not null`));
  return { rates, pendingTopUps: pending.map((p) => ({ ...p.request, organizationName: p.organizationName })), addonRequests, vetanlyConfigured: isVetanlyWhatsAppConfigured() };
};

export const savePlatformRates = async (rates: MessagingRates) => {
  const values = {
    emailRate: rates.email.toFixed(3),
    whatsappVetanlyRate: rates.whatsappVetanly.toFixed(3),
    whatsappCustomRate: rates.whatsappCustom.toFixed(3),
    updatedAt: new Date(),
  };
  await db.insert(platformMessagingSettingsTable).values({ id: 1, ...values }).onConflictDoUpdate({ target: platformMessagingSettingsTable.id, set: values });
  return platformRates();
};

export const platformOrganizationMessaging = async (organizationId: string) => {
  const settings = await ensureSettings(organizationId);
  const provider = await loadProvider(organizationId, settings.whatsappProviderId);
  const platform = await platformRates();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [usage, topUpRows, recent] = await Promise.all([
    db
      .select({ channel: logs.channel, status: logs.status, n: count() })
      .from(logs)
      .where(and(eq(logs.organizationId, organizationId), gte(logs.createdAt, since)))
      .groupBy(logs.channel, logs.status),
    db.select().from(topUps).where(eq(topUps.organizationId, organizationId)).orderBy(desc(topUps.createdAt)).limit(20),
    db.select().from(transactions).where(eq(transactions.organizationId, organizationId)).orderBy(desc(transactions.createdAt)).limit(20),
  ]);
  return {
    addonEnabled: settings.addonEnabled,
    addonRequestedAt: settings.addonRequestedAt,
    balance: Number(settings.balance),
    lowBalanceThreshold: Number(settings.lowBalanceThreshold),
    rateOverrides: settings.rateOverrides,
    platformRates: platform,
    effectiveRates: effectiveRates(platform, settings.rateOverrides),
    provider: provider ? { kind: provider.kind, name: provider.name, lastTestOk: provider.lastTestOk, lastTestAt: provider.lastTestAt } : null,
    usageLast30Days: usage,
    topUps: topUpRows,
    transactions: recent,
  };
};

export const setOrganizationMessaging = async (
  organizationId: string,
  actorId: string,
  input: { addonEnabled?: boolean; rateOverrides?: Partial<MessagingRates> },
) => {
  await ensureSettings(organizationId);
  await db
    .update(settingsTable)
    .set({
      ...(input.addonEnabled === undefined ? {} : { addonEnabled: input.addonEnabled, ...(input.addonEnabled ? { addonRequestedAt: null } : {}) }),
      ...(input.rateOverrides === undefined ? {} : { rateOverrides: input.rateOverrides }),
      updatedAt: new Date(),
    })
    .where(eq(settingsTable.organizationId, organizationId));
  if (input.addonEnabled) {
    const owners = await db
      .select({ userId: userOrganizationsTable.userId })
      .from(userOrganizationsTable)
      .where(and(eq(userOrganizationsTable.organizationId, organizationId), eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN)));
    await notify({
      organizationId,
      userIds: owners.map((o) => o.userId).filter((id) => id !== actorId),
      type: "messaging_addon_enabled",
      title: "Email and WhatsApp delivery is on",
      body: "Add balance and set up WhatsApp on the Messaging page.",
      link: "/messaging",
    });
  }
  return platformOrganizationMessaging(organizationId);
};

/**
 * Adds (or, negative, removes) balance. With a top-up request, marks it credited. A positive credit
 * re-arms the low-balance warning.
 */
export const creditWallet = async (
  organizationId: string,
  actorId: string,
  input: { amount: number; reference?: string; note?: string; topUpRequestId?: string },
) => {
  const amountMilli = toMilli(input.amount);
  const outcome = await db.transaction(async (tx) => {
    await ensureSettings(organizationId, tx);
    if (input.topUpRequestId) {
      const [request] = await tx
        .update(topUps)
        .set({ status: "credited", resolvedByUserId: actorId, resolvedAt: new Date() })
        .where(and(eq(topUps.id, input.topUpRequestId), eq(topUps.organizationId, organizationId), eq(topUps.status, "pending")))
        .returning({ id: topUps.id });
      if (!request) return "request-gone" as const;
    }
    const [updated] = await tx
      .update(settingsTable)
      .set({
        balance: sql`${settingsTable.balance} + ${fromMilli(amountMilli)}`,
        ...(amountMilli > 0 ? { lowBalanceNotifiedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(settingsTable.organizationId, organizationId), amountMilli < 0 ? gte(settingsTable.balance, fromMilli(-amountMilli)) : undefined))
      .returning({ balance: settingsTable.balance });
    if (!updated) return "insufficient" as const;
    await tx.insert(transactions).values({
      organizationId,
      kind: input.topUpRequestId || amountMilli > 0 ? "top_up" : "adjustment",
      amount: fromMilli(amountMilli),
      balanceAfter: updated.balance,
      reference: input.reference || null,
      note: input.note || null,
      createdByUserId: actorId,
    });
    return Number(updated.balance);
  });
  if (outcome === "request-gone") return fail("conflict", "That top-up request was already handled");
  if (outcome === "insufficient") return fail("conflict", "The balance is lower than the amount to remove");
  if (amountMilli > 0) {
    const owners = await db
      .select({ userId: userOrganizationsTable.userId })
      .from(userOrganizationsTable)
      .where(and(eq(userOrganizationsTable.organizationId, organizationId), eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN)));
    await notify({
      organizationId,
      userIds: owners.map((o) => o.userId),
      type: "messaging_balance_added",
      title: `₹${(amountMilli / 1000).toFixed(2)} added to your messaging balance`,
      body: `Balance now ₹${outcome.toFixed(2)}`,
      link: "/messaging",
    });
  }
  return ok({ balance: outcome });
};

export const cancelTopUpRequest = async (requestId: string, actorId: string) => {
  const [updated] = await db
    .update(topUps)
    .set({ status: "cancelled", resolvedByUserId: actorId, resolvedAt: new Date() })
    .where(and(eq(topUps.id, requestId), eq(topUps.status, "pending")))
    .returning({ id: topUps.id });
  return updated ? ok(null) : fail("not-found", "No pending request");
};

/** The organization's WhatsApp provider row, with its encrypted secrets, for the sender. */
export const providerForSend = loadProvider;
