import { z } from "zod";

import { ALL_FEATURES } from "@/services/plan-features";

const planFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  priceAmount: z.coerce.number().finite().min(0).max(1_000_000_000).multipleOf(0.01),
  billingPeriod: z.enum(["monthly", "annual", "five_year"]),
  includedEmployees: z.coerce.number().int().min(0).max(1_000_000),
  overagePrice: z.coerce.number().finite().min(0).max(1_000_000_000).multipleOf(0.01),
  features: z.array(z.enum(ALL_FEATURES)).max(ALL_FEATURES.length),
  visibility: z.enum(["public", "custom"]),
  isActive: z.boolean(),
};

export const platformPlanSchema = z.object({
  ...planFields,
  description: planFields.description.optional().default(""),
  features: planFields.features.default(ALL_FEATURES),
  visibility: planFields.visibility.default("public"),
  isActive: planFields.isActive.default(true),
});

// No defaults here: a field left out of an update must stay as it is, not reset.
export const platformPlanUpdateSchema = z.object(planFields).partial().refine((data) => Object.keys(data).length > 0, {
  message: "Provide at least one plan field to update.",
});

export const platformSubscriptionSchema = z.object({
  planId: z.uuid(),
  status: z.enum(["active", "trial", "past_due", "cancelled"]).default("active"),
  startsAt: z.iso.date().optional(),
  nextBillingAt: z.iso.date().optional().or(z.literal("")),
  // Last paid day, inclusive. Setting it activates full access and closes any upgrade request.
  paidUntil: z.iso.date().optional().or(z.literal("")),
});

export const platformBillingProfileSchema = z.object({
  legalName: z.string().trim().min(1).max(160),
  gstin: z.string().trim().toUpperCase().max(15).optional().default(""),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(100).default("India"),
  email: z.union([z.email(), z.literal("")]).optional().default(""),
  whatsappPhone: z.string().trim().max(20).optional().default(""),
}).refine((data) => !data.gstin || /^[0-9A-Z]{15}$/.test(data.gstin), {
  message: "GSTIN must contain 15 letters or digits.",
  path: ["gstin"],
}).refine((data) => !data.whatsappPhone || /^\+?[0-9]{8,15}$/.test(data.whatsappPhone), {
  message: "Enter a WhatsApp number with country code.",
  path: ["whatsappPhone"],
});

export const platformInvoiceSchema = z.object({
  organizationId: z.uuid(),
  taxRate: z.coerce.number().finite().min(0).max(100).multipleOf(0.01).default(18),
  dueDate: z.iso.date().optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().default(""),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(240),
    quantity: z.coerce.number().finite().gt(0).max(1_000_000).multipleOf(0.01),
    unitPrice: z.coerce.number().finite().min(0).max(1_000_000_000).multipleOf(0.01),
  })).min(1).max(30),
}).superRefine((invoice, context) => {
  const maximumTotal = 9_999_999_999.99;
  const subtotal = invoice.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = subtotal * (1 + invoice.taxRate / 100);
  if (!Number.isFinite(total) || total > maximumTotal) {
    context.addIssue({ code: "custom", path: ["items"], message: "Invoice total exceeds the supported maximum." });
  }
});

export const platformInvoiceListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["open", "paid", "void"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const platformInvoicePaidSchema = z.object({
  paymentMethod: z.enum(["cash", "bank_transfer", "upi", "other"]),
  paymentReference: z.string().trim().max(120).optional().default(""),
});

export const platformInvoiceVoidSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// Replaces the full set of custom plans offered to one organization.
export const platformPlanOffersSchema = z.object({
  planIds: z.array(z.uuid()).max(50),
});
