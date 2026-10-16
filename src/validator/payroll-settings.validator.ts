import { z } from "zod";

const money = z.number().min(0).max(9_999_999_999.99);

export const payrollSettingsSchema = z
  .object({
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code"),
    overtimeCalculationMethod: z
      .enum(["fixed_per_hour", "hourly_rate_multiplier", "equivalent_days"])
      .default("hourly_rate_multiplier"),
    overtimeFixedAmountPerHour: money.nullable().default(null),
    overtimeHourlyRateMultiplier: z.number().min(0.001).max(999).default(1.5),
    overtimeHoursPerWorkday: z.number().gt(0).max(24).nullable().default(null),
    lateFineMethod: z
      .enum(["none", "fixed_per_occurrence", "per_minute"])
      .default("none"),
    lateFineAmount: money.nullable().default(null),
    lateFineCapPerPayPeriod: money.nullable().default(null),
    weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(6).default([0]),
    autoDeductLoans: z.boolean().default(false),
    paidHolidays: z.boolean().default(false),
    overtimeApprovalRequired: z.boolean().default(false),
    offDayWorkPolicy: z.enum(["manager", "pay", "comp_off"]).default("manager"),
    weeklyOffWorkMultiplier: z.number().min(0).max(5).default(1),
    holidayWorkMultiplier: z.number().min(0).max(5).default(2),
    fullDayThresholdPercent: z.number().gt(0).max(100).default(90),
    halfDayThresholdPercent: z.number().gt(0).max(100).default(50),
  })
  .superRefine((settings, ctx) => {
    const require = (condition: boolean, path: string, message: string) => {
      if (!condition) ctx.addIssue({ code: "custom", path: [path], message });
    };
    require(
      settings.halfDayThresholdPercent < settings.fullDayThresholdPercent,
      "halfDayThresholdPercent",
      "Half-day threshold must be lower than the full-day threshold",
    );
    if (settings.overtimeCalculationMethod === "fixed_per_hour") {
      require(
        settings.overtimeFixedAmountPerHour !== null,
        "overtimeFixedAmountPerHour",
        "Fixed overtime amount per hour is required",
      );
    }
    if (settings.overtimeCalculationMethod === "equivalent_days") {
      require(
        settings.overtimeHoursPerWorkday !== null,
        "overtimeHoursPerWorkday",
        "Hours per workday is required",
      );
    }
    if (settings.lateFineMethod !== "none") {
      require(
        settings.lateFineAmount !== null,
        "lateFineAmount",
        "Late fine amount is required",
      );
    }
  });
