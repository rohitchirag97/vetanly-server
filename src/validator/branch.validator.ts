import { z } from "zod";

import { PT_STATES } from "@/services/statutory-calc";

const text = (max: number) => z.string().trim().max(max).nullable().optional();

export const branchSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    code: text(32),
    addressLine1: text(200),
    addressLine2: text(200),
    city: text(100),
    state: text(100),
    postalCode: text(20),
    ptState: z
      .enum(PT_STATES.map((state) => state.code) as [string, ...string[]])
      .nullable()
      .optional(),
    ptFlatAmount: z.number().min(0).max(2500).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    geofenceRadiusMeters: z.number().int().min(50, "Use at least 50 m: phone GPS is rarely more precise").max(5000).default(200),
    gpsCheckIn: z.boolean().default(false),
  })
  .refine((value) => (value.latitude == null) === (value.longitude == null), {
    message: "Enter both latitude and longitude",
    path: ["latitude"],
  })
  .refine((value) => !value.gpsCheckIn || value.latitude != null, {
    message: "Set the branch location before turning on GPS check-in",
    path: ["gpsCheckIn"],
  })
  .refine((value) => value.ptState !== "FLAT" || value.ptFlatAmount != null, {
    message: "Enter the monthly professional tax amount",
    path: ["ptFlatAmount"],
  });

export const branchStatusSchema = z.object({ isActive: z.boolean() });

export const branchManagersSchema = z.object({
  // Admins and HR (user ids) limited to this branch; anyone left out stops managing it.
  employeeIds: z.array(z.uuid()).max(50),
});
