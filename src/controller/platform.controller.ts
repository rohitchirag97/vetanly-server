import { randomInt } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

import {
  addPlatformOrganizationNote,
  createPlatformOrganization,
  getPlatformOrganization,
  getPlatformOverview,
  listPlatformAuditLogs,
  listPlatformOrganizations,
  recordPlatformEvent,
  updatePlatformOrganizationStatus,
  type PlatformActor,
} from "@/services/platform.services";
import { compareHash, hash } from "@/utils/hash";
import { del, get, incrementWithExpiry, secondsLeft, set, setIfAbsent } from "@/utils/redis";
import { sendOtp } from "@/queue/producer/sendOtp";
import { isVetanlyWhatsAppConfigured } from "@/services/vetanly-whatsapp";
import { enqueuePlatformInvoiceWhatsApp } from "@/queue/producer/sendPlatformInvoiceWhatsApp";
import {
  createPlatformInvoice,
  createPlatformPlan,
  getPlatformBillingOverview,
  getPlatformInvoice,
  getPlatformInvoiceDelivery,
  getPlatformOrganizationBilling,
  listPlatformInvoices,
  listPlatformPlans,
  markPlatformInvoicePaid,
  savePlatformBillingProfile,
  setPlatformInvoiceWhatsAppStatus,
  savePlatformPlanOffers,
  setPlatformOrganizationPlan,
  updatePlatformPlan,
  voidPlatformInvoice,
} from "@/services/platform-billing.services";
import { buildPlatformInvoicePdf } from "@/services/platform-invoice-pdf";
import { env } from "@/utils/env";
import { sendResponse } from "@/utils/response";
import {
  createPlatformOrganizationSchema,
  platformAuditQuerySchema,
  platformNoteSchema,
  platformOrganizationsQuerySchema,
  platformOtpSchema,
  suspendOrganizationSchema,
} from "@/validator/platform.validator";
import {
  platformBillingProfileSchema,
  platformInvoiceListSchema,
  platformInvoicePaidSchema,
  platformInvoiceSchema,
  platformInvoiceVoidSchema,
  platformPlanSchema,
  platformPlanUpdateSchema,
  platformPlanOffersSchema,
  platformSubscriptionSchema,
} from "@/validator/platform-billing.validator";

type AuthenticatedUser = { id: string; fname: string; lname: string; phone: string };

export const getActor = (c: Context): PlatformActor => {
  const user = c.get("user") as AuthenticatedUser;
  let ipAddress: string | null = null;
  try {
    ipAddress = getConnInfo(c).remote.address ?? null;
  } catch {
    ipAddress = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  }
  return {
    id: user.id,
    name: `${user.fname} ${user.lname}`.trim(),
    ipAddress,
    userAgent: c.req.header("user-agent") ?? null,
  };
};

const readBody = async (c: Context) => c.req.json().catch(() => null);

export const getPlatformMeController = async (c: Context): Promise<Response> => {
  const user = c.get("user") as AuthenticatedUser;
  return sendResponse(c, "success", "Platform admin session active", {
    id: user.id,
    name: `${user.fname} ${user.lname}`.trim(),
  });
};

const PLATFORM_OTP_RESEND_SECONDS = 60;

export const platformReauthSendController = async (c: Context): Promise<Response> => {
  const user = c.get("user") as AuthenticatedUser;
  const sessionId = c.get("sessionId") as string | undefined;
  if (!sessionId) return sendResponse(c, "error", "Your session has expired.", null, 401);
  // One code per minute per session: a page refresh or a repeated request reuses the code just sent
  // instead of replacing it, and does not count against the hourly limit.
  const cooldownKey = `platform-otp-cooldown:${sessionId}`;
  if (!(await setIfAbsent(cooldownKey, "1", PLATFORM_OTP_RESEND_SECONDS))) {
    return sendResponse(
      c,
      "success",
      "A verification code was sent to your account phone moments ago. Use that code.",
      { resendInSeconds: await secondsLeft(cooldownKey), alreadySent: true },
      200,
    );
  }
  const sent = await incrementWithExpiry(`platform-otp-send:${user.id}`, 3600);
  if (sent > 5) {
    return sendResponse(c, "error", "Too many verification codes requested. Try again later.", null, 429);
  }
  const otp = randomInt(100000, 1000000).toString();
  await set(`platform-otp:${sessionId}`, await hash(otp), 600);
  await del(`platform-otp-attempts:${sessionId}`);
  await sendOtp(user.phone, otp);
  await recordPlatformEvent({ actor: getActor(c), action: "platform.reauth.otp_sent" });
  return sendResponse(
    c,
    "success",
    "Verification code sent to your account phone.",
    { resendInSeconds: PLATFORM_OTP_RESEND_SECONDS, alreadySent: false },
    200,
  );
};

export const platformReauthVerifyController = async (c: Context): Promise<Response> => {
  const user = c.get("user") as AuthenticatedUser;
  const sessionId = c.get("sessionId") as string | undefined;
  if (!sessionId) return sendResponse(c, "error", "Your session has expired.", null, 401);
  const parsed = platformOtpSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return sendResponse(c, "error", "Enter the six-digit verification code.", null, 400);
  }
  const attempts = await incrementWithExpiry(`platform-otp-attempts:${sessionId}`, 600);
  if (attempts > 5) {
    await del(`platform-otp:${sessionId}`);
    return sendResponse(c, "error", "Too many attempts. Request a new code.", null, 429);
  }
  const storedOtp = await get(`platform-otp:${sessionId}`);
  if (!storedOtp || !(await compareHash(parsed.data.otp, storedOtp))) {
    return sendResponse(c, "error", "Incorrect or expired verification code.", null, 400);
  }
  await del(`platform-otp:${sessionId}`);
  await del(`platform-otp-attempts:${sessionId}`);
  await set(`platform-session:${sessionId}`, "verified", 30 * 60);
  await recordPlatformEvent({ actor: getActor(c), action: "platform.reauth.verified" });
  return sendResponse(c, "success", "Platform session verified for 30 minutes.", null, 200);
};

export const getPlatformOverviewController = async (c: Context): Promise<Response> => {
  const [overview, billing] = await Promise.all([getPlatformOverview(getActor(c)), getPlatformBillingOverview()]);
  return sendResponse(c, "success", "Platform overview fetched", { ...overview, billing });
};

export const listPlatformOrganizationsController = async (c: Context): Promise<Response> => {
  const parsed = platformOrganizationsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid organization filters", null, 400);
  }
  return sendResponse(c, "success", "Organizations fetched", await listPlatformOrganizations(getActor(c), parsed.data));
};

export const getPlatformOrganizationController = async (c: Context): Promise<Response> => {
  const result = await getPlatformOrganization(getActor(c), c.req.param("organizationId"));
  if (!result) return sendResponse(c, "error", "Organization not found", null, 404);
  return sendResponse(c, "success", "Organization fetched", result);
};

export const createPlatformOrganizationController = async (c: Context): Promise<Response> => {
  const parsed = createPlatformOrganizationSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid organization details", null, 400);
  }
  try {
    const result = await createPlatformOrganization(getActor(c), {
      ...parsed.data,
      owner: {
        ...parsed.data.owner,
        phone: parsed.data.owner.phone.replace(/\D/g, ""),
        email: parsed.data.owner.email || undefined,
      },
    });
    if (result.status === "slug-taken") {
      return sendResponse(c, "error", "An organization with this slug already exists.", null, 409);
    }
    return sendResponse(c, "success", "Organization and owner account created", result, 201);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      return sendResponse(c, "error", "The organization slug or owner email is already in use.", null, 409);
    }
    throw error;
  }
};

export const suspendPlatformOrganizationController = async (c: Context): Promise<Response> => {
  const parsed = suspendOrganizationSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "A suspension reason is required", null, 400);
  }
  const organization = await updatePlatformOrganizationStatus(
    getActor(c),
    c.req.param("organizationId"),
    "suspended",
    parsed.data.reason,
  );
  if (!organization) return sendResponse(c, "error", "Organization not found", null, 404);
  return sendResponse(c, "success", "Organization suspended", organization);
};

export const reactivatePlatformOrganizationController = async (c: Context): Promise<Response> => {
  const organization = await updatePlatformOrganizationStatus(
    getActor(c),
    c.req.param("organizationId"),
    "active",
  );
  if (!organization) return sendResponse(c, "error", "Organization not found", null, 404);
  return sendResponse(c, "success", "Organization reactivated", organization);
};

export const addPlatformNoteController = async (c: Context): Promise<Response> => {
  const parsed = platformNoteSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid note", null, 400);
  }
  const note = await addPlatformOrganizationNote(getActor(c), c.req.param("organizationId"), parsed.data.text);
  if (!note) return sendResponse(c, "error", "Organization not found", null, 404);
  return sendResponse(c, "success", "Internal note added", note, 201);
};

export const listPlatformAuditController = async (c: Context): Promise<Response> => {
  const parsed = platformAuditQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid audit filters", null, 400);
  }
  return sendResponse(c, "success", "Platform audit log fetched", await listPlatformAuditLogs(getActor(c), parsed.data.page, parsed.data.pageSize));
};

export const listPlatformPlansController = async (c: Context): Promise<Response> =>
  sendResponse(c, "success", "Plans fetched", await listPlatformPlans(getActor(c)));

export const createPlatformPlanController = async (c: Context): Promise<Response> => {
  const parsed = platformPlanSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid plan", null, 400);
  try {
    const plan = await createPlatformPlan(getActor(c), parsed.data);
    return sendResponse(c, "success", "Plan created", plan, 201);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return sendResponse(c, "error", "A plan with this name already exists.", null, 409);
    throw error;
  }
};

export const updatePlatformPlanController = async (c: Context): Promise<Response> => {
  const parsed = platformPlanUpdateSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid plan", null, 400);
  try {
    const plan = await updatePlatformPlan(getActor(c), c.req.param("planId"), parsed.data);
    return plan ? sendResponse(c, "success", "Plan updated", plan) : sendResponse(c, "error", "Plan not found", null, 404);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return sendResponse(c, "error", "A plan with this name already exists.", null, 409);
    throw error;
  }
};

export const getPlatformOrganizationBillingController = async (c: Context): Promise<Response> => {
  const billing = await getPlatformOrganizationBilling(getActor(c), c.req.param("organizationId"));
  return sendResponse(c, "success", "Organization billing fetched", billing);
};

export const savePlatformBillingProfileController = async (c: Context): Promise<Response> => {
  const parsed = platformBillingProfileSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid billing profile", null, 400);
  const profile = await savePlatformBillingProfile(getActor(c), c.req.param("organizationId"), parsed.data);
  return profile ? sendResponse(c, "success", "Billing profile saved", profile) : sendResponse(c, "error", "Organization not found", null, 404);
};

export const setPlatformOrganizationPlanController = async (c: Context): Promise<Response> => {
  const parsed = platformSubscriptionSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid subscription", null, 400);
  const result = await setPlatformOrganizationPlan(getActor(c), c.req.param("organizationId"), parsed.data);
  if (result.status === "organization-missing") return sendResponse(c, "error", "Organization not found", null, 404);
  if (result.status === "plan-unavailable") return sendResponse(c, "error", "Choose an active plan.", null, 400);
  return sendResponse(c, "success", "Organization plan updated", result.subscription);
};

export const listPlatformInvoicesController = async (c: Context): Promise<Response> => {
  const parsed = platformInvoiceListSchema.safeParse(c.req.query());
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid invoice filters", null, 400);
  return sendResponse(c, "success", "Invoices fetched", await listPlatformInvoices(getActor(c), parsed.data));
};

export const createPlatformInvoiceController = async (c: Context): Promise<Response> => {
  const parsed = platformInvoiceSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid invoice", null, 400);
  const result = await createPlatformInvoice(getActor(c), parsed.data);
  if (result.status === "organization-missing") return sendResponse(c, "error", "Organization not found", null, 404);
  if (result.status === "billing-profile-missing") return sendResponse(c, "error", "Save the customer billing profile before creating an invoice.", null, 400);
  return sendResponse(c, "success", "Invoice generated", result.invoice, 201);
};

export const getPlatformInvoiceController = async (c: Context): Promise<Response> => {
  const invoice = await getPlatformInvoice(getActor(c), c.req.param("invoiceId"));
  return invoice ? sendResponse(c, "success", "Invoice fetched", invoice) : sendResponse(c, "error", "Invoice not found", null, 404);
};

export const getPlatformInvoicePdfController = async (c: Context): Promise<Response> => {
  const invoice = await getPlatformInvoice(getActor(c), c.req.param("invoiceId"));
  if (!invoice) return sendResponse(c, "error", "Invoice not found", null, 404);
  const pdf = await buildPlatformInvoicePdf(invoice);
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  c.header("Cache-Control", "private, no-store");
  return c.body(pdf, 200);
};

export const markPlatformInvoicePaidController = async (c: Context): Promise<Response> => {
  const parsed = platformInvoicePaidSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid payment details", null, 400);
  const result = await markPlatformInvoicePaid(getActor(c), c.req.param("invoiceId"), parsed.data);
  if (result.status === "missing") return sendResponse(c, "error", "Invoice not found", null, 404);
  if (result.status === "not-open") return sendResponse(c, "error", "Only open invoices can be marked paid.", null, 409);
  return sendResponse(c, "success", "Invoice marked paid", result.invoice);
};

export const voidPlatformInvoiceController = async (c: Context): Promise<Response> => {
  const parsed = platformInvoiceVoidSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "A void reason is required", null, 400);
  const result = await voidPlatformInvoice(getActor(c), c.req.param("invoiceId"), parsed.data.reason);
  if (result.status === "missing") return sendResponse(c, "error", "Invoice not found", null, 404);
  if (result.status === "not-open") return sendResponse(c, "error", "Only open invoices can be voided.", null, 409);
  return sendResponse(c, "success", "Invoice voided", result.invoice);
};

export const sendPlatformInvoiceWhatsAppController = async (c: Context): Promise<Response> => {
  if (!isVetanlyWhatsAppConfigured()) {
    return sendResponse(c, "error", "WhatsApp delivery is not configured. Set VETANLY_WHATSAPP_URL and VETANLY_WHATSAPP_API_KEY on the server.", null, 503);
  }
  const invoiceId = c.req.param("invoiceId");
  const delivery = await getPlatformInvoiceDelivery(invoiceId);
  if (!delivery) return sendResponse(c, "error", "Invoice not found", null, 404);
  if (delivery.invoice.status === "void") return sendResponse(c, "error", "A void invoice cannot be sent.", null, 409);
  if (delivery.invoice.whatsappStatus === "queued") return sendResponse(c, "error", "This invoice is already queued for WhatsApp delivery.", null, 409);
  if (!delivery.destination) return sendResponse(c, "error", "Add a WhatsApp number with country code to the customer billing profile.", null, 400);
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    return sendResponse(c, "error", "Cloudflare R2 must be configured so AiSensy can access the invoice PDF.", null, 503);
  }
  const digits = delivery.destination.replace(/\D/g, "");
  if (digits.length < 11 || digits.length > 15) return sendResponse(c, "error", "The WhatsApp number must include its country code.", null, 400);
  const destination = `+${digits}`;
  try {
    await setPlatformInvoiceWhatsAppStatus(invoiceId, "queued", destination);
    await enqueuePlatformInvoiceWhatsApp({ invoiceId, requestedByUserId: (c.get("user") as AuthenticatedUser).id });
    await recordPlatformEvent({ actor: getActor(c), action: "billing.invoice.whatsapp.queued", organizationId: delivery.invoice.organizationId, organizationName: delivery.invoice.organizationName, afterValues: { invoiceId, destination: `${destination.slice(0, 3)}***${destination.slice(-2)}` } });
  } catch (error) {
    await setPlatformInvoiceWhatsAppStatus(invoiceId, "failed", destination, error instanceof Error ? error.message : "Queue failed");
    throw error;
  }
  return sendResponse(c, "success", "Invoice queued for WhatsApp delivery", { status: "queued", destination: `${destination.slice(0, 3)}***${destination.slice(-2)}` }, 202);
};

export const savePlatformPlanOffersController = async (c: Context): Promise<Response> => {
  const parsed = platformPlanOffersSchema.safeParse(await readBody(c));
  if (!parsed.success) return sendResponse(c, "error", parsed.error.issues[0]?.message ?? "Invalid plan offers", null, 400);
  const result = await savePlatformPlanOffers(getActor(c), c.req.param("organizationId")!, parsed.data.planIds);
  if (result.status === "organization-missing") return sendResponse(c, "error", "Organization not found", null, 404);
  if (result.status === "invalid-plans") return sendResponse(c, "error", "Only existing custom plans can be offered.", null, 400);
  return sendResponse(c, "success", "Custom plan offers saved", { offeredPlanIds: result.offeredPlanIds });
};
