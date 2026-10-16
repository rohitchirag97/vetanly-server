import { eq } from "drizzle-orm";

import db from "@/utils/db";
import { organizationPayrollSettingsTable } from "@/drizzle/schema";
import { holidayDatesBetween, holidaysForBranch } from "@/services/holiday.services";
import { rosterDaysFor } from "@/services/payroll.services";
import { parseWeeklyOff } from "@/services/payroll-settings.services";
import { loadRoster } from "@/services/roster.services";

/**
 * Whether a date is an employee's weekly off or holiday, decided the way payroll does:
 * a rotation or override replaces the company weekly off on the dates it covers, and
 * holidays apply company-wide or to the employee's branch.
 */
export const loadOffDays = async (
  organizationId: string,
  from: string,
  to: string,
  members: { id: string; branchId: string | null }[],
) => {
  const [holidays, [settings], roster] = await Promise.all([
    holidayDatesBetween(organizationId, from, to),
    db
      .select({ weeklyOffDays: organizationPayrollSettingsTable.weeklyOffDays })
      .from(organizationPayrollSettingsTable)
      .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
      .limit(1),
    loadRoster(organizationId, from, to, members.map((member) => member.id)),
  ]);
  const weeklyOff = settings ? parseWeeklyOff(settings.weeklyOffDays) : [0];
  const holidaySets = new Map(members.map((member) => [member.id, new Set(holidaysForBranch(holidays, member.branchId))]));
  const rosterDays = new Map(members.map((member) => [member.id, rosterDaysFor(roster.byMembership.get(member.id))]));

  return (membershipId: string, date: string) => {
    const rostered = rosterDays.get(membershipId)?.get(date);
    return {
      holiday: holidaySets.get(membershipId)?.has(date) ?? false,
      weeklyOff: rostered === "off" || (rostered !== "work" && weeklyOff.includes(new Date(`${date}T00:00:00Z`).getUTCDay())),
    };
  };
};
