import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    // Left out means "unchanged"; empty means "clear".
    .transform((value) => (value === undefined ? undefined : value?.trim() ? value.trim() : null));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format");

export const profileSchema = z.object({
  gender: z.enum(["male", "female", "other"]).nullish().transform((value) => (value === undefined ? undefined : value ?? null)),
  bloodGroup: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullish().transform((value) => (value === undefined ? undefined : value ?? null)),
  dateOfBirth: z
    .union([isoDate, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null))
    .refine((value) => !value || (value >= "1900-01-01" && value <= new Date().toISOString().slice(0, 10)), {
      message: "Date of birth is not valid",
    }),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),
  emergencyContactName: optionalText(100),
  emergencyContactRelation: optionalText(50),
  emergencyContactPhone: optionalText(20).refine(
    (value) => !value || /^\+?[\d\s-]{6,20}$/.test(value),
    { message: "Emergency contact phone is not valid" },
  ),
  bankAccountHolder: optionalText(100),
  bankName: optionalText(100),
  bankAccountNumber: z
    .string()
    .trim()
    .max(34)
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null))
    .refine((value) => !value || /^[A-Za-z0-9]{6,34}$/.test(value), {
      message: "Bank account number must be 6-34 letters or digits",
    }),
  bankIfsc: optionalText(20)
    .refine((value) => !value || /^[A-Za-z0-9]{4,20}$/.test(value), {
      message: "IFSC / routing code must be 4-20 letters or digits",
    })
    // Bank codes are upper case; storing them that way keeps bank files and comparisons consistent.
    .transform((value) => (typeof value === "string" ? value.toUpperCase() : value)),
  upiId: optionalText(100),
});

export const DOCUMENT_TYPES = [
  "id_proof",
  "address_proof",
  "contract",
  "offer_letter",
  "certificate",
  "other",
] as const;

// Employees can add their own supporting papers, but not company-issued documents.
export const EMPLOYEE_UPLOAD_TYPES: readonly string[] = [
  "id_proof",
  "address_proof",
  "certificate",
  "other",
];

export const documentFieldsSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  name: z.string().trim().max(150).optional(),
});

export const lifecycleKindSchema = z.enum(["onboarding", "offboarding"]);

export const taskKindQuerySchema = z.object({ kind: lifecycleKindSchema });
export const startChecklistSchema = z.object({ kind: lifecycleKindSchema });
export const createTaskSchema = z.object({
  kind: lifecycleKindSchema,
  title: z.string().trim().min(1, "Task title is required").max(150),
});
export const updateTaskSchema = z.object({ isDone: z.boolean() });

export const exitSchema = z
  .object({
    exitType: z.enum(["resignation", "termination", "retirement", "other"]),
    resignationDate: isoDate,
    noticeDays: z.number().int().min(0).max(365).default(30),
    lastWorkingDay: isoDate.optional(),
    reason: optionalText(500),
    notes: optionalText(1000),
  })
  .refine((value) => !value.lastWorkingDay || value.lastWorkingDay >= value.resignationDate, {
    message: "Last working day cannot be before the resignation date",
    path: ["lastWorkingDay"],
  });
