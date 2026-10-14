import { z } from "zod";

export const EXPENSE_CATEGORIES = [
  "travel",
  "fuel",
  "food",
  "accommodation",
  "phone_internet",
  "office_supplies",
  "client_meeting",
  "medical",
  "other",
] as const;

// Arrives as multipart form fields (the receipt is a file), so numbers come in as text.
export const createExpenseClaimSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES, "Choose a category"),
  amount: z.coerce
    .number("Enter the amount")
    .positive("Amount must be more than zero")
    .max(1_000_000, "Amount is too large for one claim")
    .multipleOf(0.01, "Use at most two decimal places"),
  expenseDate: z.iso.date("Choose the date of the expense"),
  description: z.string().trim().min(3, "Describe what the expense was for").max(500),
});

export const reviewExpenseClaimSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

export const payExpenseClaimSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

export const listExpenseClaimsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled", "paid"]).optional(),
  employeeId: z.uuid().optional(),
});
