import { Hono } from "hono";

import { authenticate } from "@/middleware/authenticate.middleware";
import {
  platformCancelTopUpController,
  platformCreditController,
  platformMessagingController,
  platformOrgMessagingController,
  platformRatesController,
  platformSetOrgMessagingController,
} from "@/controller/platform-messaging.controller";
import { platformRateLimit, requirePlatformAdmin } from "@/middleware/platform-admin.middleware";
import {
  addPlatformNoteController,
  createPlatformInvoiceController,
  createPlatformPlanController,
  createPlatformOrganizationController,
  getPlatformInvoiceController,
  getPlatformInvoicePdfController,
  getPlatformOrganizationBillingController,
  getPlatformMeController,
  getPlatformOrganizationController,
  getPlatformOverviewController,
  listPlatformAuditController,
  listPlatformInvoicesController,
  listPlatformOrganizationsController,
  listPlatformPlansController,
  markPlatformInvoicePaidController,
  platformReauthSendController,
  platformReauthVerifyController,
  reactivatePlatformOrganizationController,
  suspendPlatformOrganizationController,
  savePlatformBillingProfileController,
  savePlatformPlanOffersController,
  sendPlatformInvoiceWhatsAppController,
  setPlatformOrganizationPlanController,
  updatePlatformPlanController,
  voidPlatformInvoiceController,
} from "@/controller/platform.controller";

const platformRoutes: Hono = new Hono();
const protect = [authenticate, requirePlatformAdmin(), platformRateLimit];
const reauthProtect = [authenticate, requirePlatformAdmin({ requireFreshAuth: false }), platformRateLimit];

platformRoutes.post("/reauth/send-otp", ...reauthProtect, platformReauthSendController);
platformRoutes.post("/reauth/verify-otp", ...reauthProtect, platformReauthVerifyController);
platformRoutes.get("/me", ...protect, getPlatformMeController);
platformRoutes.get("/overview", ...protect, getPlatformOverviewController);
platformRoutes.get("/organizations", ...protect, listPlatformOrganizationsController);
platformRoutes.post("/organizations", ...protect, createPlatformOrganizationController);
platformRoutes.get("/organizations/:organizationId", ...protect, getPlatformOrganizationController);
platformRoutes.get("/organizations/:organizationId/billing", ...protect, getPlatformOrganizationBillingController);
platformRoutes.put("/organizations/:organizationId/billing-profile", ...protect, savePlatformBillingProfileController);
platformRoutes.put("/organizations/:organizationId/subscription", ...protect, setPlatformOrganizationPlanController);
platformRoutes.put("/organizations/:organizationId/plan-offers", ...protect, savePlatformPlanOffersController);
platformRoutes.post("/organizations/:organizationId/suspend", ...protect, suspendPlatformOrganizationController);
platformRoutes.post("/organizations/:organizationId/reactivate", ...protect, reactivatePlatformOrganizationController);
platformRoutes.post("/organizations/:organizationId/notes", ...protect, addPlatformNoteController);
platformRoutes.get("/audit-log", ...protect, listPlatformAuditController);
platformRoutes.get("/plans", ...protect, listPlatformPlansController);
platformRoutes.post("/plans", ...protect, createPlatformPlanController);
platformRoutes.patch("/plans/:planId", ...protect, updatePlatformPlanController);
platformRoutes.get("/invoices", ...protect, listPlatformInvoicesController);
platformRoutes.post("/invoices", ...protect, createPlatformInvoiceController);
platformRoutes.get("/invoices/:invoiceId/pdf", ...protect, getPlatformInvoicePdfController);
platformRoutes.get("/invoices/:invoiceId", ...protect, getPlatformInvoiceController);
platformRoutes.post("/invoices/:invoiceId/paid", ...protect, markPlatformInvoicePaidController);
platformRoutes.post("/invoices/:invoiceId/void", ...protect, voidPlatformInvoiceController);
platformRoutes.get("/messaging", ...protect, platformMessagingController);
platformRoutes.put("/messaging/rates", ...protect, platformRatesController);
platformRoutes.post("/messaging/top-ups/:requestId/cancel", ...protect, platformCancelTopUpController);
platformRoutes.get("/organizations/:organizationId/messaging", ...protect, platformOrgMessagingController);
platformRoutes.put("/organizations/:organizationId/messaging", ...protect, platformSetOrgMessagingController);
platformRoutes.post("/organizations/:organizationId/messaging/credit", ...protect, platformCreditController);
platformRoutes.post("/invoices/:invoiceId/send-whatsapp", ...protect, sendPlatformInvoiceWhatsAppController);

export default platformRoutes;
