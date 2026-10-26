import { eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  organizationPayrollSettingsTable,
  type LateFineMethod,
  type OffDayWorkPolicy,
  type OvertimeCalculationMethod,
} from "@/drizzle/schema";
import { MANAGER_ROLES, OWNER_ROLES, requireRole } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";
import type { payrollSettingsSchema } from "@/validator/payroll-settings.validator";

type PayrollSettings = {
  organizationId: string;
  currencyCode: string;
  overtimeCalculationMethod: OvertimeCalculationMethod;
  overtimeFixedAmountPerHour: string | null;
  overtimeHourlyRateMultiplier: string;
  overtimeHoursPerWorkday: string | null;
  lateFineMethod: LateFineMethod;
  lateFineAmount: string | null;
  lateFineCapPerPayPeriod: string | null;
  weeklyOffDays: number[];
  autoDeductLoans: boolean;
  paidHolidays: boolean;
  overtimeApprovalRequired: boolean;
  adminAttendanceEdit: boolean;
  offDayWorkPolicy: OffDayWorkPolicy;
  weeklyOffWorkMultiplier: string;
  holidayWorkMultiplier: string;
  fullDayThresholdPercent: string;
  halfDayThresholdPercent: string;
  updatedAt: Date;
};

export const parseWeeklyOff = (value: string | null | undefined): number[] =>
  (value ?? "")
    .split(",")
    .filter((part) => part !== "")
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

const present = <T extends { weeklyOffDays: string }>({ weeklyOffDays, ...rest }: T) => ({
  ...rest,
  weeklyOffDays: parseWeeklyOff(weeklyOffDays),
});

const columns = {
  organizationId: organizationPayrollSettingsTable.organizationId,
  currencyCode: organizationPayrollSettingsTable.currencyCode,
  overtimeCalculationMethod:
    organizationPayrollSettingsTable.overtimeCalculationMethod,
  overtimeFixedAmountPerHour:
    organizationPayrollSettingsTable.overtimeFixedAmountPerHour,
  overtimeHourlyRateMultiplier:
    organizationPayrollSettingsTable.overtimeHourlyRateMultiplier,
  overtimeHoursPerWorkday:
    organizationPayrollSettingsTable.overtimeHoursPerWorkday,
  lateFineMethod: organizationPayrollSettingsTable.lateFineMethod,
  lateFineAmount: organizationPayrollSettingsTable.lateFineAmount,
  lateFineCapPerPayPeriod: organizationPayrollSettingsTable.lateFineCapPerPayPeriod,
  weeklyOffDays: organizationPayrollSettingsTable.weeklyOffDays,
  autoDeductLoans: organizationPayrollSettingsTable.autoDeductLoans,
  paidHolidays: organizationPayrollSettingsTable.paidHolidays,
  overtimeApprovalRequired: organizationPayrollSettingsTable.overtimeApprovalRequired,
  adminAttendanceEdit: organizationPayrollSettingsTable.adminAttendanceEdit,
  offDayWorkPolicy: organizationPayrollSettingsTable.offDayWorkPolicy,
  weeklyOffWorkMultiplier: organizationPayrollSettingsTable.weeklyOffWorkMultiplier,
  holidayWorkMultiplier: organizationPayrollSettingsTable.holidayWorkMultiplier,
  fullDayThresholdPercent: organizationPayrollSettingsTable.fullDayThresholdPercent,
  halfDayThresholdPercent: organizationPayrollSettingsTable.halfDayThresholdPercent,
  updatedAt: organizationPayrollSettingsTable.updatedAt,
};

/** Whether admins and HR may set attendance directly (Payroll settings switch, off by default). */
export const isAdminAttendanceEditEnabled = async (organizationId: string) => {
  const [settings] = await db
    .select({ value: organizationPayrollSettingsTable.adminAttendanceEdit })
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return settings?.value ?? false;
};

const money = (value: number | null) => (value === null ? null : value.toFixed(2));

export const getPayrollSettings = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<PayrollSettings | null>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [settings] = await db
    .select(columns)
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return ok(settings ? present(settings) : null);
};

export const savePayrollSettings = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof payrollSettingsSchema>,
): Promise<ServiceResult<PayrollSettings>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;

  const values = {
    currencyCode: input.currencyCode,
    overtimeCalculationMethod: input.overtimeCalculationMethod,
    overtimeFixedAmountPerHour: money(input.overtimeFixedAmountPerHour),
    overtimeHourlyRateMultiplier: input.overtimeHourlyRateMultiplier.toFixed(3),
    overtimeHoursPerWorkday:
      input.overtimeHoursPerWorkday === null
        ? null
        : input.overtimeHoursPerWorkday.toFixed(2),
    lateFineMethod: input.lateFineMethod,
    lateFineAmount: money(input.lateFineAmount),
    lateFineCapPerPayPeriod: money(input.lateFineCapPerPayPeriod),
    weeklyOffDays: [...new Set(input.weeklyOffDays)].sort().join(","),
    autoDeductLoans: input.autoDeductLoans,
    paidHolidays: input.paidHolidays,
    overtimeApprovalRequired: input.overtimeApprovalRequired,
    adminAttendanceEdit: input.adminAttendanceEdit,
    offDayWorkPolicy: input.offDayWorkPolicy,
    weeklyOffWorkMultiplier: input.weeklyOffWorkMultiplier.toFixed(2),
    holidayWorkMultiplier: input.holidayWorkMultiplier.toFixed(2),
    fullDayThresholdPercent: input.fullDayThresholdPercent.toFixed(2),
    halfDayThresholdPercent: input.halfDayThresholdPercent.toFixed(2),
    updatedAt: new Date(),
  };

  const [settings] = await db
    .insert(organizationPayrollSettingsTable)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: organizationPayrollSettingsTable.organizationId,
      set: values,
    })
    .returning(columns);
  return ok(present(settings));
};
