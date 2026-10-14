import { z } from "zod";

const financialYear = z.string().regex(/^\d{4}-\d{2}$/, "Use a financial year like 2026-27").refine(
  (value) => (Number(value.slice(0, 4)) + 1) % 100 === Number(value.slice(5)),
  "Use a financial year like 2026-27",
);

const SECTIONS = ["80C", "80CCD1B", "80D_SELF", "80D_PARENTS", "HRA", "24B", "80E", "80TTA", "PREVIOUS_EMPLOYER"] as const;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const financialYearQuerySchema = z.object({ financialYear });

export const saveDeclarationSchema = z.object({
  financialYear,
  taxRegime: z.enum(["new", "old"]),
  seniorSelf: z.boolean().default(false),
  seniorParents: z.boolean().default(false),
});

export const declarationItemSchema = z.object({
  section: z.enum(SECTIONS),
  kind: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional(),
  declaredAmount: z.number().positive("Enter an amount above zero").max(100_000_000).multipleOf(0.01),
  // Section facts: HRA rent and landlord, lender for home loans, TDS for a previous employer.
  details: z
    .object({
      monthlyRent: z.number().positive().max(10_000_000).optional(),
      metro: z.boolean().optional(),
      landlordName: z.string().trim().max(100).optional(),
      landlordPan: z.string().trim().toUpperCase().regex(PAN, "Enter a valid PAN").optional().or(z.literal("")),
      landlordAddress: z.string().trim().max(300).optional(),
      lenderName: z.string().trim().max(100).optional(),
      lenderPan: z.string().trim().toUpperCase().regex(PAN, "Enter a valid PAN").optional().or(z.literal("")),
      employerName: z.string().trim().max(100).optional(),
      employerTan: z.string().trim().toUpperCase().max(10).optional(),
      tdsDeducted: z.number().min(0).max(100_000_000).optional(),
    })
    .default({}),
});

export const reviewDeclarationItemSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  // Accept a smaller amount than declared when the proof shows less.
  verifiedAmount: z.number().min(0).max(100_000_000).multipleOf(0.01).optional(),
  note: z.string().trim().max(500).optional(),
});

export const taxDeclarationSettingsSchema = z.object({
  financialYear,
  declarationClosesOn: z.iso.date().nullable().optional(),
  proofDeadline: z.iso.date(),
});
