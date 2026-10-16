import { and, count, eq, gte } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";

import db from "@/utils/db";
import {
  messageLogsTable as logs,
  messagingProvidersTable as providers,
  organizationsTable,
  type CustomHttpConfig,
  type MessageType,
} from "@/drizzle/schema";
import { OWNER_ROLES, requireRole } from "@/services/access.services";
import { VETANLY_TEMPLATES, sendVetanlyWhatsApp, verifyVetanlySignature } from "@/services/vetanly-whatsapp";
import { buildMessageContent } from "@/services/messaging-content";
import {
  HAS_DOCUMENT,
  mapStatus,
  maskPhone,
  MESSAGE_VARIABLES,
  nextStatus,
  readPath,
  renderJsonBody,
  renderText,
  type MappedStatus,
  type RenderContext,
} from "@/services/messaging-template";
import { ensureSettings, loadTemplates, providerForSend, refundMessage } from "@/services/messaging.services";
import { decryptSecret } from "@/utils/crypto";
import { signedDownloadUrl, storeFile } from "@/utils/file-storage";
import { sendPdfEmail } from "@/utils/mailer";
import { fail, ok } from "@/utils/result";

/**
 * Sends queued messages and follows their delivery status. A message that will never work (no phone,
 * template not mapped, provider removed) fails at once and is refunded; network trouble is retried.
 */

type Provider = NonNullable<Awaited<ReturnType<typeof providerForSend>>>;
type Outcome = { status: "sent" | "simulated"; providerMessageId: string | null };

const permanent = (message: string) => new UnrecoverableError(message);

/** Calls the organization's own provider with its template filled in. */
const sendCustomHttp = async (provider: Provider, ctx: Omit<RenderContext, "secrets">): Promise<Outcome> => {
  const config = provider.config as CustomHttpConfig;
  if (!config.url) throw permanent("The provider has no API URL");
  const secrets = Object.fromEntries(Object.entries(provider.secrets).map(([name, value]) => [name, decryptSecret(value)]));
  const full: RenderContext = { ...ctx, secrets };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const header of config.headers ?? []) headers[header.name] = renderText(header.value, full);
  let body: string | undefined;
  if (config.method !== "GET") {
    try {
      body = JSON.stringify(renderJsonBody(config.bodyTemplate ?? "{}", full));
    } catch {
      throw permanent("The provider's request body is not valid JSON once filled in");
    }
  }
  const response = await fetch(renderText(config.url, full), {
    method: config.method ?? "POST",
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = `Provider returned HTTP ${response.status}: ${text.slice(0, 200)}`;
    // 4xx (bad key, bad template, bad number) will not fix itself; 429 and 5xx may.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) throw permanent(message);
    throw new Error(message);
  }
  let providerMessageId: string | null = null;
  if (config.responseIdPath) {
    try {
      const id = readPath(JSON.parse(text), config.responseIdPath);
      providerMessageId = id === undefined || id === null ? null : String(id);
    } catch {
      // Not JSON: accepted, but without an id to follow.
    }
  }
  return { status: "sent", providerMessageId };
};

/** A PDF link the provider can download for 24 hours. */
const documentLink = async (organizationId: string, messageLogId: string, pdf: { buffer: Buffer; filename: string }) => {
  const key = `messaging/${organizationId}/${messageLogId}.pdf`;
  await storeFile(key, new Uint8Array(pdf.buffer), "application/pdf");
  return signedDownloadUrl(key, 24 * 3600);
};

const sendWhatsApp = async (
  provider: Provider,
  input: { organizationId: string; messageLogId: string; messageType: MessageType; phone: string; recipientName: string; variables: Record<string, string>; pdf: { buffer: Buffer; filename: string } | null },
): Promise<Outcome> => {
  const documentUrl = input.pdf && HAS_DOCUMENT[input.messageType] ? await documentLink(input.organizationId, input.messageLogId, input.pdf) : null;
  if (provider.kind === "vetanly") {
    const result = await sendVetanlyWhatsApp({
      to: input.phone,
      template: VETANLY_TEMPLATES[input.messageType],
      params: MESSAGE_VARIABLES[input.messageType].map((v) => input.variables[v.key] ?? ""),
      ...(documentUrl && input.pdf ? { document: { url: documentUrl, filename: input.pdf.filename } } : {}),
      reference: input.messageLogId,
    });
    return result.simulated ? { status: "simulated", providerMessageId: null } : { status: "sent", providerMessageId: result.providerMessageId };
  }
  const mapping = (await loadTemplates(provider.id)).find((t) => t.messageType === input.messageType);
  if (!mapping) throw permanent("No template is mapped for this message on your provider");
  return sendCustomHttp(provider, {
    phone: input.phone,
    recipientName: input.recipientName,
    template: mapping.templateName,
    language: mapping.language,
    params: mapping.params.map((key) => input.variables[key] ?? ""),
    documentUrl,
    documentFilename: input.pdf?.filename ?? null,
    reference: input.messageLogId,
  });
};

/** Sends one queued message. Safe to run twice: only a message still queued is sent. */
export const deliverMessage = async (messageLogId: string) => {
  const [log] = await db.select().from(logs).where(eq(logs.id, messageLogId)).limit(1);
  if (!log || log.status !== "queued") return;
  const content = await buildMessageContent(log.organizationId, log.messageType, log.relatedId).catch((error: Error) => {
    throw permanent(error.message);
  });

  let outcome: Outcome;
  if (log.channel === "email") {
    if (!content.email || !content.emailMessage || !content.pdf) throw permanent("The employee no longer has a verified email address");
    const id = await sendPdfEmail({
      to: content.email,
      subject: content.emailMessage.subject,
      react: content.emailMessage.react,
      filename: content.pdf.filename,
      pdf: content.pdf.buffer,
      idempotencyKey: `message/${log.id}`,
    });
    outcome = id ? { status: "sent", providerMessageId: id } : { status: "simulated", providerMessageId: null };
  } else {
    if (!content.phone) throw permanent("The employee has no phone number linked for WhatsApp");
    const provider = await providerForSend(log.organizationId, log.providerId);
    if (!provider) throw permanent("The WhatsApp provider was removed before this message was sent");
    outcome = await sendWhatsApp(provider, {
      organizationId: log.organizationId,
      messageLogId: log.id,
      messageType: log.messageType,
      phone: content.phone,
      recipientName: content.recipientName,
      variables: content.variables,
      pdf: content.pdf,
    });
  }

  await db
    .update(logs)
    .set({ status: outcome.status, providerMessageId: outcome.providerMessageId, error: null, updatedAt: new Date() })
    .where(and(eq(logs.id, log.id), eq(logs.status, "queued")));
  // Nothing really went out (no provider credentials yet), so nothing is charged.
  if (outcome.status === "simulated") await refundMessage(log.id, "Not sent: delivery is not configured on the server yet");
};

/** Marks a message failed for good and gives its charge back. */
export const failMessage = async (messageLogId: string, error: string) => {
  await db
    .update(logs)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(logs.id, messageLogId), eq(logs.status, "queued")));
  await refundMessage(messageLogId, `Refund: ${error}`);
};

const TESTS_PER_HOUR = 10;

/** Sends a free test message through the configured provider and reports what happened. */
export const sendTestMessage = async (organizationId: string, requesterId: string, phone: string) => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;
  const settings = await ensureSettings(organizationId);
  const provider = await providerForSend(organizationId, settings.whatsappProviderId);
  if (!provider) return fail("conflict", "Set up a WhatsApp provider first");
  const [recent] = await db
    .select({ n: count() })
    .from(logs)
    .where(and(eq(logs.organizationId, organizationId), eq(logs.messageType, "test"), gte(logs.createdAt, new Date(Date.now() - 3600_000))));
  if ((recent?.n ?? 0) >= TESTS_PER_HOUR) return fail("conflict", `At most ${TESTS_PER_HOUR} test messages an hour`);
  const [organization] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  const [log] = await db
    .insert(logs)
    .values({
      organizationId,
      channel: "whatsapp",
      providerId: provider.id,
      providerKind: provider.kind,
      messageType: "test",
      recipientMasked: maskPhone(phone),
      testDestination: phone,
      requestedByUserId: requesterId,
    })
    .returning({ id: logs.id });

  let outcome: Outcome | null = null;
  let error: string | null = null;
  try {
    outcome = await sendWhatsApp(provider, {
      organizationId,
      messageLogId: log!.id,
      messageType: "test",
      phone,
      recipientName: "Test recipient",
      variables: { recipient_name: "Test recipient", organization_name: organization?.name ?? "" },
      pdf: null,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : "Sending failed";
  }
  await db
    .update(logs)
    .set({ status: outcome?.status ?? "failed", providerMessageId: outcome?.providerMessageId ?? null, error, updatedAt: new Date() })
    .where(eq(logs.id, log!.id));
  const summary = error ?? (outcome?.status === "simulated" ? "Simulated: Vetanly WhatsApp is not connected on the server yet" : `Accepted by the provider${outcome?.providerMessageId ? ` (id ${outcome.providerMessageId})` : ""}`);
  await db
    .update(providers)
    .set({ lastTestAt: new Date(), lastTestOk: !error, lastTestMessage: summary.slice(0, 300) })
    .where(eq(providers.id, provider.id));
  return ok({ ok: !error, status: outcome?.status ?? "failed", message: summary });
};

// ---------- Delivery status callbacks ----------

const applyStatus = async (log: typeof logs.$inferSelect, incoming: MappedStatus, error: string | null) => {
  const status = nextStatus(log.status, incoming);
  if (!status) return false;
  await db
    .update(logs)
    .set({ status, ...(status === "failed" ? { error: (error ?? "Reported failed by the provider").slice(0, 500) } : {}), updatedAt: new Date() })
    .where(eq(logs.id, log.id));
  if (status === "failed" && log.messageType !== "test") await refundMessage(log.id, `Refund: ${error ?? "provider reported the message failed"}`);
  return true;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** From Vetanly's own WhatsApp service, signed with the shared secret. */
export const handleVetanlyWebhook = async (rawBody: string, signature: string | undefined) => {
  if (!verifyVetanlySignature(rawBody, signature)) return { status: 401 as const, updated: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400 as const, updated: 0 };
  }
  const events = (Array.isArray(payload) ? payload : [payload]) as { id?: string; reference?: string; status?: string; error?: string }[];
  let updated = 0;
  for (const event of events) {
    const incoming = mapStatus(event.status, { sent: ["sent"], delivered: ["delivered"], read: ["read"], failed: ["failed"] });
    if (!incoming) continue;
    const [log] = event.reference && UUID.test(event.reference)
      ? await db.select().from(logs).where(and(eq(logs.id, event.reference), eq(logs.providerKind, "vetanly"))).limit(1)
      : event.id
        ? await db.select().from(logs).where(and(eq(logs.providerMessageId, String(event.id)), eq(logs.providerKind, "vetanly"))).limit(1)
        : [];
    if (log && (await applyStatus(log, incoming, event.error ?? null))) updated += 1;
  }
  return { status: 200 as const, updated };
};

/** From an organization's own provider; the token in the URL identifies the provider. */
export const handleCustomWebhook = async (token: string, rawBody: string) => {
  const [provider] = await db.select().from(providers).where(eq(providers.webhookToken, token)).limit(1);
  if (!provider || provider.kind !== "custom_http") return { status: 404 as const, updated: 0 };
  const mapping = (provider.config as CustomHttpConfig).statusWebhook;
  if (!mapping) return { status: 200 as const, updated: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400 as const, updated: 0 };
  }
  let updated = 0;
  for (const event of Array.isArray(payload) ? payload : [payload]) {
    const messageId = readPath(event, mapping.messageIdPath);
    const incoming = mapStatus(readPath(event, mapping.statusPath), mapping.statusMap);
    if (messageId === undefined || messageId === null || !incoming) continue;
    const [log] = await db
      .select()
      .from(logs)
      .where(and(eq(logs.providerId, provider.id), eq(logs.providerMessageId, String(messageId))))
      .limit(1);
    const error = mapping.errorPath ? readPath(event, mapping.errorPath) : null;
    if (log && (await applyStatus(log, incoming, error === null || error === undefined ? null : String(error)))) updated += 1;
  }
  return { status: 200 as const, updated };
};

/** Meta-style webhook verification: echo the challenge when the verify token is the provider's token. */
export const verifyCustomWebhook = async (token: string, query: Record<string, string>) => {
  const [provider] = await db.select({ id: providers.id }).from(providers).where(eq(providers.webhookToken, token)).limit(1);
  if (!provider || query["hub.mode"] !== "subscribe" || query["hub.verify_token"] !== token) return null;
  return query["hub.challenge"] ?? null;
};
