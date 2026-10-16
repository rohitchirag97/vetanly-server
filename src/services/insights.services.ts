import { and, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";

import db from "@/utils/db";
import {
  assetAssignmentsTable,
  attendanceRegularizationsTable,
  branchesTable,
  departmentsTable,
  employeeExitsTable,
  employeeProfilesTable,
  employeeStatutoryProfilesTable,
  expenseClaimsTable,
  leaveRequestsTable,
  leaveTypesTable,
  payrollItemsTable,
  payrollRunsTable,
  userOrganizationsTable as memberships,
  usersTable,
  UserRole,
  type CompensationType,
} from "@/drizzle/schema";
import { canManageMember, isOrganizationManager, PEOPLE_MANAGER_ROLES, requireRole, type ActiveMembership } from "@/services/access.services";
import { getDailyAttendance } from "@/services/attendance.services";
import { CATEGORY_LABELS } from "@/services/expense.services";
import {
  attendanceSummary,
  attrition,
  averageTenureYears,
  breakdown,
  byWeekday,
  daysUntilAnniversary,
  headcountTrend,
  lastMonths,
  TENURE_BANDS,
  tenureBand,
} from "@/services/insights-calc";
import { accruedGratuity, monthlyBasicOf } from "@/services/settlement-calc";
import { fail, ok } from "@/utils/result";

/**
 * HR insights for owners, admins and HR: workforce, attendance and leave, upcoming events and, for
 * owners and admins of the whole organization, payroll cost. Everything follows the requester's
 * reach: HR sees plain employees, a branch manager their branches.
 */

const IST_OFFSET_MS = 330 * 60_000;
const todayIst = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const EMPLOYMENT_TYPE: Record<string, string> = { full_time: "Full time", part_time: "Part time", contractor: "Contractor", intern: "Intern" };
const GENDER: Record<string, string> = { male: "Male", female: "Female", other: "Other" };

/** Everyone the requester can see, past and present, with what the insights need. */
const scopedMembers = async (organizationId: string, access: ActiveMembership) => {
  const rows = await db
    .select({
      id: memberships.id,
      userId: memberships.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      role: memberships.role,
      isActive: memberships.isActive,
      includeInPayroll: memberships.includeInPayroll,
      hireDate: memberships.hireDate,
      deactivatedAt: memberships.deactivatedAt,
      employmentType: memberships.employmentType,
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
      branchId: memberships.branchId,
      branchName: branchesTable.name,
      departmentName: departmentsTable.name,
      gender: employeeStatutoryProfilesTable.gender,
      dateOfBirth: employeeProfilesTable.dateOfBirth,
      exitType: employeeExitsTable.exitType,
      exitStatus: employeeExitsTable.status,
      lastWorkingDay: employeeExitsTable.lastWorkingDay,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .leftJoin(branchesTable, eq(branchesTable.id, memberships.branchId))
    .leftJoin(departmentsTable, eq(departmentsTable.id, memberships.departmentId))
    .leftJoin(employeeStatutoryProfilesTable, eq(employeeStatutoryProfilesTable.userOrganizationId, memberships.id))
    .leftJoin(employeeProfilesTable, and(eq(employeeProfilesTable.userId, memberships.userId), eq(employeeProfilesTable.organizationId, memberships.organizationId)))
    .leftJoin(
      employeeExitsTable,
      and(eq(employeeExitsTable.userId, memberships.userId), eq(employeeExitsTable.organizationId, memberships.organizationId), ne(employeeExitsTable.status, "cancelled")),
    )
    .where(eq(memberships.organizationId, organizationId));
  return rows
    .filter((row) => (row.role !== UserRole.SUPER_ADMIN || row.includeInPayroll) && canManageMember(access, row))
    .map((row) => {
      const deactivated = !row.isActive && row.deactivatedAt ? new Date(row.deactivatedAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) : null;
      return {
        ...row,
        name: `${row.fname} ${row.lname}`.trim(),
        // An exit's last working day, else the deactivation date.
        leftOn: row.lastWorkingDay ?? deactivated,
        voluntary: row.exitType === "resignation",
      };
    })
    // Deactivated with no date on record: nothing to place them in time with.
    .filter((row) => row.isActive || row.leftOn);
};

const peopleAccess = async (organizationId: string, requesterId: string) => requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);

export const workforceInsights = async (organizationId: string, requesterId: string) => {
  const access = await peopleAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const today = todayIst();
  const members = await scopedMembers(organizationId, access.data);
  const months = lastMonths(today, 12);
  const trend = headcountTrend(members, months, today);
  const current = members.filter((m) => (!m.hireDate || m.hireDate <= today) && (!m.leftOn || m.leftOn >= today));
  const quarterAgo = addDays(today, -90);
  return ok({
    asOf: today,
    headcount: current.length,
    joinedLast90Days: members.filter((m) => m.hireDate && m.hireDate > quarterAgo && m.hireDate <= today).length,
    servingNotice: current.filter((m) => m.exitStatus === "notice").length,
    averageTenureYears: averageTenureYears(current.map((m) => m.hireDate), today),
    attrition12Months: attrition(members, trend, today),
    trend,
    byDepartment: breakdown(current.map((m) => m.departmentName), "No department"),
    byBranch: breakdown(current.map((m) => m.branchName), "No branch"),
    byEmploymentType: breakdown(current.map((m) => (m.employmentType ? EMPLOYMENT_TYPE[m.employmentType] : null))),
    byGender: breakdown(current.map((m) => (m.gender ? (GENDER[m.gender] ?? m.gender) : null))),
    byTenure: TENURE_BANDS.map((band) => ({ name: band, count: current.filter((m) => tenureBand(m.hireDate, today) === band).length })).filter((row) => row.count > 0),
    leaversByReason: breakdown(
      members.filter((m) => m.leftOn && m.leftOn <= today && m.leftOn.slice(0, 7) >= months[0]!).map((m) => (m.exitType ? m.exitType[0]!.toUpperCase() + m.exitType.slice(1) : "Deactivated")),
    ),
  });
};

export const attendanceInsights = async (organizationId: string, requesterId: string, query: { from: string; to: string }) => {
  const access = await peopleAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const daily = await getDailyAttendance(organizationId, requesterId, { from: query.from, to: query.to, utcOffsetMinutes: 330 });
  if (!daily.ok) return daily;
  const members = await scopedMembers(organizationId, access.data);
  const byUser = new Map(members.map((m) => [m.userId, m]));
  // Only people in the requester's reach (the daily view also returns their own days).
  const rows = daily.data
    .filter((row) => byUser.has(row.employeeId))
    .map((row) => ({ ...row, lateMinutes: row.lateMinutes ?? 0 }));

  const perEmployee = new Map<string, { name: string; late: number; absent: number; lateMinutes: number }>();
  for (const row of rows) {
    const entry = perEmployee.get(row.employeeId) ?? { name: row.employeeName, late: 0, absent: 0, lateMinutes: 0 };
    if (row.lateMinutes > 0) {
      entry.late += 1;
      entry.lateMinutes += row.lateMinutes;
    }
    if (row.status === "absent") entry.absent += 1;
    perEmployee.set(row.employeeId, entry);
  }
  const top = (pick: (e: { late: number; absent: number }) => number) =>
    [...perEmployee.entries()]
      .map(([employeeId, e]) => ({ employeeId, name: e.name, count: pick(e), lateMinutes: e.lateMinutes }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5);

  const departments = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = byUser.get(row.employeeId)?.departmentName ?? "No department";
    departments.set(name, [...(departments.get(name) ?? []), row]);
  }

  // Approved leave starting in the period.
  const membershipIds = members.map((m) => m.id);
  const leaves = membershipIds.length
    ? await db
        .select({ membershipId: leaveRequestsTable.userOrganizationId, type: leaveTypesTable.name, days: leaveRequestsTable.days, status: leaveRequestsTable.status })
        .from(leaveRequestsTable)
        .innerJoin(leaveTypesTable, eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId))
        .where(
          and(
            eq(leaveRequestsTable.organizationId, organizationId),
            inArray(leaveRequestsTable.userOrganizationId, membershipIds),
            gte(leaveRequestsTable.startDate, query.from),
            lte(leaveRequestsTable.startDate, query.to),
          ),
        )
    : [];
  const approved = leaves.filter((l) => l.status === "approved");
  const leaveByType = new Map<string, number>();
  const leaveByPerson = new Map<string, number>();
  for (const leave of approved) {
    leaveByType.set(leave.type, (leaveByType.get(leave.type) ?? 0) + Number(leave.days));
    leaveByPerson.set(leave.membershipId, (leaveByPerson.get(leave.membershipId) ?? 0) + Number(leave.days));
  }
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  return ok({
    from: query.from,
    to: query.to,
    summary: attendanceSummary(rows),
    byWeekday: byWeekday(rows),
    byDepartment: [...departments.entries()]
      .map(([name, list]) => ({ name, ...attendanceSummary(list) }))
      .sort((a, b) => (a.attendanceRatePercent ?? 0) - (b.attendanceRatePercent ?? 0)),
    mostLate: top((e) => e.late),
    mostAbsent: top((e) => e.absent),
    leave: {
      daysTaken: approved.reduce((sum, l) => sum + Number(l.days), 0),
      byType: [...leaveByType.entries()].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days),
      topTakers: [...leaveByPerson.entries()]
        .map(([id, days]) => ({ name: nameOf.get(id) ?? "", days }))
        .sort((a, b) => b.days - a.days)
        .slice(0, 5),
    },
  });
};

/** Birthdays, work anniversaries, notice periods ending, gratuity coming due, and what waits for a decision. */
export const upcomingInsights = async (organizationId: string, requesterId: string) => {
  const access = await peopleAccess(organizationId, requesterId);
  if (!access.ok) return access;
  const today = todayIst();
  const members = await scopedMembers(organizationId, access.data);
  const active = members.filter((m) => m.isActive && (!m.leftOn || m.leftOn >= today));
  const within = 30;

  const events: { type: "birthday" | "anniversary" | "notice_ends" | "gratuity_due"; employeeId: string; name: string; date: string; inDays: number; detail: string }[] = [];
  for (const m of active) {
    if (m.dateOfBirth) {
      const days = daysUntilAnniversary(m.dateOfBirth, today, within);
      if (days !== null) events.push({ type: "birthday", employeeId: m.userId, name: m.name, date: addDays(today, days), inDays: days, detail: "Birthday" });
    }
    if (m.hireDate && m.hireDate < today) {
      const days = daysUntilAnniversary(m.hireDate, today, within);
      const years = days === null ? 0 : Number(addDays(today, days).slice(0, 4)) - Number(m.hireDate.slice(0, 4));
      if (days !== null && years >= 1) {
        events.push({ type: "anniversary", employeeId: m.userId, name: m.name, date: addDays(today, days), inDays: days, detail: `${years} year${years === 1 ? "" : "s"} with the company` });
      }
      // Gratuity becomes payable after about five years (four years 240 days).
      const accrued = accruedGratuity({
        hireDate: m.hireDate,
        asOf: today,
        monthlyBasic: monthlyBasicOf({ compensationType: m.compensationType as CompensationType | null, compensationAmount: Number(m.compensationAmount ?? 0) }),
      });
      if (!accrued.eligible && accrued.eligibleFrom <= addDays(today, 90)) {
        const inDays = Math.round((Date.parse(accrued.eligibleFrom) - Date.parse(today)) / 86_400_000);
        events.push({ type: "gratuity_due", employeeId: m.userId, name: m.name, date: accrued.eligibleFrom, inDays, detail: "Becomes eligible for gratuity" });
      }
    }
    if (m.exitStatus === "notice" && m.lastWorkingDay && m.lastWorkingDay <= addDays(today, within)) {
      const inDays = Math.round((Date.parse(m.lastWorkingDay) - Date.parse(today)) / 86_400_000);
      events.push({ type: "notice_ends", employeeId: m.userId, name: m.name, date: m.lastWorkingDay, inDays, detail: inDays < 0 ? "Last working day passed: complete the exit" : "Last working day" });
    }
  }

  const ids = members.map((m) => m.id);
  const pendingIn = <T>(rows: T[]) => rows.length;
  const [leave, claims, corrections, receipts] = ids.length
    ? await Promise.all([
        db.select({ id: leaveRequestsTable.id }).from(leaveRequestsTable).where(and(inArray(leaveRequestsTable.userOrganizationId, ids), eq(leaveRequestsTable.status, "pending"))),
        db.select({ id: expenseClaimsTable.id }).from(expenseClaimsTable).where(and(inArray(expenseClaimsTable.userOrganizationId, ids), eq(expenseClaimsTable.status, "pending"))),
        db
          .select({ id: attendanceRegularizationsTable.id })
          .from(attendanceRegularizationsTable)
          .where(and(inArray(attendanceRegularizationsTable.userOrganizationId, ids), eq(attendanceRegularizationsTable.status, "pending"))),
        db
          .select({ id: assetAssignmentsTable.id })
          .from(assetAssignmentsTable)
          .where(and(inArray(assetAssignmentsTable.userOrganizationId, ids), eq(assetAssignmentsTable.lost, false), isNull(assetAssignmentsTable.acknowledgedAt), isNull(assetAssignmentsTable.returnedOn))),
      ])
    : [[], [], [], []];

  return ok({
    asOf: today,
    events: events.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name)),
    pending: {
      leaveRequests: pendingIn(leave),
      expenseClaims: pendingIn(claims),
      attendanceCorrections: pendingIn(corrections),
      assetReceiptsUnconfirmed: receipts.length,
      missingHireDates: active.filter((m) => !m.hireDate).length,
      missingBirthDates: active.filter((m) => !m.dateOfBirth).length,
    },
  });
};

/** Payroll cost by month and where it goes. Owners and admins of the whole organization only. */
export const costInsights = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  if (!isOrganizationManager(access.data)) return fail("forbidden", "Payroll cost is for owners and admins only");
  const today = todayIst();
  const months = lastMonths(today, 12);
  const runs = await db
    .select({ id: payrollRunsTable.id, periodEnd: payrollRunsTable.periodEnd })
    .from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.organizationId, organizationId), eq(payrollRunsTable.status, "finalized"), gte(payrollRunsTable.periodEnd, `${months[0]}-01`)));
  const items = runs.length ? await db.select().from(payrollItemsTable).where(inArray(payrollItemsTable.runId, runs.map((r) => r.id))) : [];
  const monthOf = new Map(runs.map((r) => [r.id, r.periodEnd.slice(0, 7)]));
  const money = (value: string | number | null | undefined) => Number(value ?? 0);
  const employerCost = (item: (typeof items)[number]) =>
    item.statutory ? item.statutory.pfEps + item.statutory.pfEpfDiff + item.statutory.pfAdmin + item.statutory.pfEdli + item.statutory.esiEmployer : 0;

  const trend = months.map((month) => {
    const ofMonth = items.filter((item) => monthOf.get(item.runId) === month);
    const gross = ofMonth.reduce((sum, i) => sum + money(i.grossPay), 0);
    const employer = ofMonth.reduce((sum, i) => sum + employerCost(i), 0);
    return {
      month,
      employees: new Set(ofMonth.map((i) => i.userOrganizationId)).size,
      gross: Math.round(gross),
      net: Math.round(ofMonth.reduce((sum, i) => sum + money(i.netPay), 0)),
      overtime: Math.round(ofMonth.reduce((sum, i) => sum + money(i.overtimePay), 0)),
      employerContributions: Math.round(employer),
      totalCost: Math.round(gross + employer),
    };
  });

  // Where the latest month's cost goes.
  const latest = [...trend].reverse().find((row) => row.employees > 0)?.month ?? null;
  const latestItems = items.filter((item) => monthOf.get(item.runId) === latest);
  const split = (label: (item: (typeof items)[number]) => string | null, unknown: string) => {
    const totals = new Map<string, number>();
    for (const item of latestItems) {
      const name = label(item) ?? unknown;
      totals.set(name, (totals.get(name) ?? 0) + money(item.grossPay) + employerCost(item));
    }
    return [...totals.entries()].map(([name, cost]) => ({ name, cost: Math.round(cost) })).sort((a, b) => b.cost - a.cost);
  };

  const claims = await db
    .select({ category: expenseClaimsTable.category, amount: expenseClaimsTable.amount })
    .from(expenseClaimsTable)
    .where(
      and(
        eq(expenseClaimsTable.organizationId, organizationId),
        inArray(expenseClaimsTable.status, ["approved", "paid"]),
        gte(expenseClaimsTable.expenseDate, `${months[months.length - 6]}-01`),
      ),
    );
  const byCategory = new Map<string, number>();
  for (const claim of claims) {
    const label = CATEGORY_LABELS[claim.category];
    byCategory.set(label, (byCategory.get(label) ?? 0) + money(claim.amount));
  }

  return ok({
    trend,
    latestMonth: latest,
    byDepartment: split((item) => item.departmentName, "No department"),
    byBranch: split((item) => item.branchName, "No branch"),
    expensesLast6Months: [...byCategory.entries()].map(([name, amount]) => ({ name, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount),
  });
};
