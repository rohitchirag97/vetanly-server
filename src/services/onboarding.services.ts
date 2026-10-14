import { sql } from "drizzle-orm";

import db from "@/utils/db";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";

export type OnboardingStatus = {
  payrollSettings: boolean;
  statutorySettings: boolean;
  departments: number;
  shifts: number;
  holidays: number;
  /** Members other than the owner. */
  employees: number;
  kiosks: number;
  payrollRuns: number;
};

/** What a new organization has set up so far; the dashboard checklist ticks steps off from this. */
export const getOnboardingStatus = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<OnboardingStatus>> => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;

  const count = (table: string, extra = sql``) =>
    sql`(select count(*)::int from ${sql.identifier(table)} where organization_id = ${organizationId}${extra})`;
  const result = await db.execute<{
    payroll_settings: number;
    statutory_settings: number;
    departments: number;
    shifts: number;
    holidays: number;
    employees: number;
    kiosks: number;
    payroll_runs: number;
  }>(sql`select
    ${count("organization_payroll_settings")} as payroll_settings,
    ${count("organization_statutory_settings")} as statutory_settings,
    ${count("departments")} as departments,
    ${count("shifts")} as shifts,
    ${count("holidays")} as holidays,
    ${count("user_organizations", sql` and role <> 'super_admin'`)} as employees,
    ${count("kiosk_devices")} as kiosks,
    ${count("payroll_runs")} as payroll_runs`);
  const row = result.rows[0]!;
  return ok({
    payrollSettings: row.payroll_settings > 0,
    statutorySettings: row.statutory_settings > 0,
    departments: row.departments,
    shifts: row.shifts,
    holidays: row.holidays,
    employees: row.employees,
    kiosks: row.kiosks,
    payrollRuns: row.payroll_runs,
  });
};
