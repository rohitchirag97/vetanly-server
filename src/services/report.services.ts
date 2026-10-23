import type { z } from "zod";

import type { Form16Data } from "@/services/form16-pdf";
import { MANAGER_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { requireFeature } from "@/services/billing-access.services";
import type { PlanFeature } from "@/services/plan-features";
import { getDailyAttendance } from "@/services/attendance.services";
import { listLeaveRequests } from "@/services/leave.services";
import { getRun } from "@/services/payroll.services";
import { listRecoverables } from "@/services/recoverable.services";
import { buildBankTransfer, buildMusterRoll, buildWageRegister } from "@/services/register-reports.services";
import { db_organizationName } from "@/services/report-meta";
import { buildForm16, buildStatutoryRunReport } from "@/services/statutory-report.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type { reportQuerySchema } from "@/validator/report.validator";

export type ReportCell = string | number | null;

export type ReportTable = {
  title: string;
  subtitle: string;
  organizationName: string;
  fileName: string;
  columns: { header: string; align?: "left" | "right"; width?: number }[];
  rows: ReportCell[][];
  totals?: ReportCell[];
  notes?: string[];
  /** Smaller font and padding for wide tables in the PDF. */
  compact?: boolean;
  form16?: Form16Data;
};

const label = (value: string) =>
  value.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());

const clock = (iso: Date | string | null, offsetMinutes: number) => {
  if (!iso) return "";
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(11, 16);
};

const hours = (minutes: number | null) => (minutes === null ? "" : (minutes / 60).toFixed(2));

const sum = (rows: ReportCell[][], index: number) =>
  rows.reduce((total, row) => total + (Number(row[index]) || 0), 0);

const REPORT_FEATURE: Record<z.infer<typeof reportQuerySchema>["type"], PlanFeature> = {
  attendance: "attendance",
  muster: "attendance",
  leave: "leave",
  payroll: "payroll",
  bank: "payroll",
  wages: "payroll",
  loans: "loans",
  pf: "statutory",
  esi: "statutory",
  pt: "statutory",
  tds: "statutory",
  form16: "statutory",
};

export const buildReport = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof reportQuerySchema>,
): Promise<ServiceResult<ReportTable>> => {
  const peopleReport = query.type === "attendance" || query.type === "leave" || query.type === "muster";
  const access = await requireRole(
    organizationId,
    requesterId,
    peopleReport ? PEOPLE_MANAGER_ROLES : MANAGER_ROLES,
  );
  if (!access.ok) return access;
  const feature = await requireFeature(organizationId, REPORT_FEATURE[query.type]);
  if (!feature.ok) return feature;
  const organizationName = await db_organizationName(organizationId);
  const range = `${query.from} to ${query.to}`;

  if (query.type === "form16") {
    if (!query.employeeId || !query.fy) return fail("invalid", "Choose an employee and financial year");
    return buildForm16(organizationId, query.employeeId, query.fy, organizationName);
  }
  if (query.type === "pf" || query.type === "esi" || query.type === "pt" || query.type === "tds") {
    if (!query.runId) return fail("invalid", "Choose a payroll run");
    return buildStatutoryRunReport(organizationId, requesterId, query.type, query.runId, organizationName);
  }

  if (query.type === "bank" || query.type === "wages") {
    if (!query.runId) return fail("invalid", "Choose a payroll run");
    return query.type === "bank"
      ? buildBankTransfer(organizationId, requesterId, query.runId, organizationName)
      : buildWageRegister(organizationId, requesterId, query.runId, organizationName);
  }
  if (query.type === "muster") {
    return buildMusterRoll(
      organizationId,
      requesterId,
      { from: query.from, to: query.to, utcOffsetMinutes: query.utcOffsetMinutes, branchId: query.branchId },
      organizationName,
    );
  }

  if (query.type === "attendance") {
    const daily = await getDailyAttendance(organizationId, requesterId, {
      from: query.from,
      to: query.to,
      utcOffsetMinutes: query.utcOffsetMinutes,
      branchId: query.branchId,
    });
    if (!daily.ok) return daily;
    const rows = daily.data
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.date.localeCompare(b.date))
      .map((day): ReportCell[] => [
        day.employeeName,
        day.date,
        label(day.status),
        clock(day.firstCheckIn, query.utcOffsetMinutes),
        clock(day.lastCheckOut, query.utcOffsetMinutes),
        hours(day.workedMinutes),
        day.lateMinutes,
        day.earlyLeaveMinutes,
      ]);
    return ok({
      title: "Attendance report",
      subtitle: range,
      organizationName,
      fileName: `attendance-${query.from}-to-${query.to}`,
      columns: [
        { header: "Employee", width: 26 },
        { header: "Date", width: 12 },
        { header: "Status", width: 13 },
        { header: "Check-in", width: 10 },
        { header: "Check-out", width: 10 },
        { header: "Hours", align: "right", width: 9 },
        { header: "Late (min)", align: "right", width: 11 },
        { header: "Early (min)", align: "right", width: 11 },
      ],
      rows,
      totals: ["Total", null, null, null, null, sum(rows, 5).toFixed(2), sum(rows, 6), sum(rows, 7)],
    });
  }

  if (query.type === "leave") {
    const requests = await listLeaveRequests(organizationId, requesterId, { branchId: query.branchId });
    if (!requests.ok) return requests;
    const rows = requests.data
      .filter((r) => r.startDate <= query.to && r.endDate >= query.from)
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.startDate.localeCompare(b.startDate))
      .map((r): ReportCell[] => [
        r.employeeName,
        r.leaveTypeName,
        r.startDate,
        r.endDate,
        Number(r.days),
        r.isPaid ? "Paid" : "Unpaid",
        label(r.status),
        r.reason ?? "",
      ]);
    return ok({
      title: "Leave report",
      subtitle: range,
      organizationName,
      fileName: `leave-${query.from}-to-${query.to}`,
      columns: [
        { header: "Employee", width: 26 },
        { header: "Leave type", width: 18 },
        { header: "From", width: 12 },
        { header: "To", width: 12 },
        { header: "Days", align: "right", width: 8 },
        { header: "Paid", width: 9 },
        { header: "Status", width: 12 },
        { header: "Reason", width: 36 },
      ],
      rows,
      totals: ["Total", null, null, null, sum(rows, 4), null, null, null],
    });
  }

  if (query.type === "loans") {
    const loans = await listRecoverables(organizationId, requesterId, {});
    if (!loans.ok) return loans;
    const rows = loans.data
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName))
      .map((l): ReportCell[] => [
        l.employeeName,
        label(l.type),
        label(l.status),
        l.currencyCode,
        Number(l.principalAmount),
        Number(l.totalRepaid),
        Number(l.outstanding),
        l.requestedAt.toISOString().slice(0, 10),
      ]);
    return ok({
      title: "Loans and advances report",
      subtitle: `As of ${new Date().toISOString().slice(0, 10)}`,
      organizationName,
      fileName: `loans-${new Date().toISOString().slice(0, 10)}`,
      columns: [
        { header: "Employee", width: 26 },
        { header: "Type", width: 16 },
        { header: "Status", width: 13 },
        { header: "Currency", width: 9 },
        { header: "Principal", align: "right", width: 13 },
        { header: "Repaid", align: "right", width: 13 },
        { header: "Outstanding", align: "right", width: 13 },
        { header: "Requested", width: 12 },
      ],
      rows,
      totals: ["Total", null, null, null, sum(rows, 4), sum(rows, 5), sum(rows, 6), null],
    });
  }

  if (!query.runId) return fail("invalid", "Choose a payroll run");
  const run = await getRun(organizationId, requesterId, query.runId);
  if (!run.ok) return run;
  const rows = run.data.items
    .filter((i) => !query.branchId || i.branchId === query.branchId)
    .map((i): ReportCell[] => [
    i.employeeName,
    i.employeeCode ?? "",
    i.branchName ?? "",
    i.departmentName ?? "",
    Number(i.workingDays),
    Number(i.presentDays) + Number(i.halfDays) / 2,
    Number(i.paidLeaveDays),
    Number(i.absentDays) + Number(i.unpaidLeaveDays),
    Number(i.grossPay),
    Number(i.totalDeductions),
    Number(i.netPay),
  ]);
  return ok({
    title: `Payroll report (${run.data.run.status})`,
    subtitle: `${run.data.run.periodStart} to ${run.data.run.periodEnd}`,
    organizationName,
    fileName: `payroll-${run.data.run.periodStart}-to-${run.data.run.periodEnd}`,
    columns: [
      { header: "Employee", width: 26 },
      { header: "Code", width: 10 },
      { header: "Branch", width: 16 },
      { header: "Department", width: 18 },
      { header: "Working days", align: "right", width: 10 },
      { header: "Present", align: "right", width: 9 },
      { header: "Paid leave", align: "right", width: 9 },
      { header: "Absent/LWP", align: "right", width: 10 },
      { header: "Gross", align: "right", width: 12 },
      { header: "Deductions", align: "right", width: 12 },
      { header: "Net pay", align: "right", width: 12 },
    ],
    rows,
    totals: ["Total", null, null, null, null, null, null, null, sum(rows, 8), sum(rows, 9), sum(rows, 10)],
  });
};
