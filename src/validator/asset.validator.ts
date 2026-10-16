import { z } from "zod";

export const ASSET_CATEGORIES = ["laptop", "desktop", "mobile", "sim", "id_card", "access_card", "vehicle", "furniture", "tool", "other"] as const;
const condition = z.enum(["new", "good", "fair", "damaged"]);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

export const assetSchema = z
  .object({
    assetTag: z.string().trim().min(1, "Asset tag is required").max(40),
    name: z.string().trim().min(1, "Name is required").max(120),
    category: z.enum(ASSET_CATEGORIES),
    serialNumber: text(80),
    brand: text(60),
    model: text(80),
    purchaseDate: z.iso.date().nullable().optional(),
    purchaseCost: z.number().min(0).max(100_000_000).nullable().optional(),
    warrantyUntil: z.iso.date().nullable().optional(),
    branchId: z.uuid().nullable().optional(),
    condition: condition.default("good"),
    notes: text(500),
  })
  .refine((value) => !value.purchaseDate || !value.warrantyUntil || value.warrantyUntil >= value.purchaseDate, {
    message: "The warranty cannot end before the purchase date",
    path: ["warrantyUntil"],
  });

export const listAssetsQuerySchema = z.object({
  status: z.enum(["available", "assigned", "in_repair", "retired"]).optional(),
  category: z.enum(ASSET_CATEGORIES).optional(),
  branchId: z.uuid().optional(),
});

export const assignAssetSchema = z.object({
  employeeId: z.uuid(),
  assignedOn: z.iso.date(),
  condition,
  notes: text(300),
});

export const returnAssetSchema = z.object({
  returnedOn: z.iso.date(),
  condition,
  notes: text(300),
  // Not returned: lost or kept. The asset is retired and the loss recorded against the assignment.
  lost: z.boolean().default(false),
});

export const assetStatusSchema = z
  .object({
    status: z.enum(["available", "in_repair", "retired"]),
    reason: text(200),
  })
  .refine((value) => value.status !== "retired" || !!value.reason?.trim(), {
    message: "Say why it is retired (sold, scrapped, lost…)",
    path: ["reason"],
  });
