import { eq } from "drizzle-orm";
import type { Context } from "hono";

import db from "@/utils/db";
import { organizationsTable } from "@/drizzle/schema";

import { getActor } from "@/controller/platform.controller";
import {
  cancelTopUpRequest,
  creditWallet,
  platformMessagingOverview,
  platformOrganizationMessaging,
  savePlatformRates,
  setOrganizationMessaging,
} from "@/services/messaging.services";
import { recordPlatformEvent } from "@/services/platform.services";
import { sendResponse } from "@/utils/response";
import { platformCreditSchema, platformOrgMessagingSchema, platformRatesSchema } from "@/validator/messaging.validator";

const body = (c: Context) => c.req.json().catch(() => null);
/** Platform calls name an organization in the path; refuse unknown ones before touching their wallet. */
const organizationExists = async (organizationId: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return false;
  const [row] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  return !!row;
};
const notFound = (c: Context) => sendResponse(c, "error", "Organization not found", null, 404);
const invalid = (c: Context, message?: string) => sendResponse(c, "error", message ?? "Invalid request", null, 400);

export const platformMessagingController = async (c: Context) =>
  sendResponse(c, "success", "Messaging overview", await platformMessagingOverview());

export const platformRatesController = async (c: Context) => {
  const parsed = platformRatesSchema.safeParse(await body(c));
  if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
  const rates = await savePlatformRates(parsed.data);
  await recordPlatformEvent({ actor: getActor(c), action: "messaging.rates.update", afterValues: rates });
  return sendResponse(c, "success", "Rates saved", rates);
};

export const platformOrgMessagingController = async (c: Context) => {
  if (!(await organizationExists(c.req.param("organizationId")!))) return notFound(c);
  return sendResponse(c, "success", "Organization messaging", await platformOrganizationMessaging(c.req.param("organizationId")!));
};

export const platformSetOrgMessagingController = async (c: Context) => {
  const parsed = platformOrgMessagingSchema.safeParse(await body(c));
  if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
  const organizationId = c.req.param("organizationId")!;
  if (!(await organizationExists(organizationId))) return notFound(c);
  const actor = getActor(c);
  const data = await setOrganizationMessaging(organizationId, actor.id, parsed.data);
  await recordPlatformEvent({ actor, action: "messaging.organization.update", organizationId, afterValues: parsed.data });
  return sendResponse(c, "success", "Messaging updated", data);
};

export const platformCreditController = async (c: Context) => {
  const parsed = platformCreditSchema.safeParse(await body(c));
  if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
  const organizationId = c.req.param("organizationId")!;
  if (!(await organizationExists(organizationId))) return notFound(c);
  const actor = getActor(c);
  const result = await creditWallet(organizationId, actor.id, parsed.data);
  if (!result.ok) return sendResponse(c, "error", result.message ?? "Could not change the balance", null, 409);
  await recordPlatformEvent({
    actor,
    action: "messaging.wallet.credit",
    organizationId,
    afterValues: { amount: parsed.data.amount, reference: parsed.data.reference ?? null, balance: result.data.balance },
  });
  return sendResponse(c, "success", parsed.data.amount > 0 ? "Balance added" : "Balance adjusted", result.data);
};

export const platformCancelTopUpController = async (c: Context) => {
  const actor = getActor(c);
  const requestId = c.req.param("requestId")!;
  const result = await cancelTopUpRequest(requestId, actor.id);
  if (!result.ok) return sendResponse(c, "error", result.message ?? "Not found", null, 404);
  await recordPlatformEvent({ actor, action: "messaging.topup.cancel", afterValues: { requestId } });
  return sendResponse(c, "success", "Top-up request cancelled", null);
};
