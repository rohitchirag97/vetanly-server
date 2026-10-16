import { and, eq, inArray } from "drizzle-orm";

import db from "@/utils/db";
import { decryptSecret } from "@/utils/crypto";
import { employeeProfilesTable, userOrganizationsTable } from "@/drizzle/schema";
import { getDailyAttendance } from "@/services/attendance.services";
import { eachDate } from "@/services/payroll-calc";
import { loadOffDays } from "@/services/off-days";
import { getRun } from "@/services/payroll.services";
import { isValidIfsc, MUSTER_LEGEND, musterCode, musterTotals } from "@/services/register-calc";
import type { ReportCell, ReportTable } from "@/services/report.services";
import { fail, ok, type ServiceResult } from "@/utils/result";

const money = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 100) / 100;
const sumColumn = (rows: ReportCell[][], index: number) => money(rows.reduce((total, row) => total + (Number(row[index]) || 0), 0));
const monthLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * One NEFT transfer per employee with a positive net pay, for the bank's bulk-upload screen.
 * Employees without usable bank details are listed in the notes so they can be paid by hand.
 */
export const buildBankTransfer = async (
  organizationId: string,
  requesterId: string,
  runId: string,
  organizationName: string,
): Promise<ServiceResult<ReportTable>> => {
  const result = await getRun(organizationId, requesterId, runId);
  if (!result.ok) return result;
  const { run, items } = result.data;
  if (run.status !== "finalized") {
    return fail("invalid", "Finalize this payroll run before exporting the bank file, so the amounts cannot change after upload");
  }

  const profiles = items.length
    ? await db
        .select({
          userId: employeeProfilesTable.userId,
          holder: employeeProfilesTable.bankAccountHolder,
          account: employeeProfilesTable.bankAccountNumber,
          ifsc: employeeProfilesTable.bankIfsc,
        })
        .from(employeeProfilesTable)
        .where(
          and(
            eq(employeeProfilesTable.organizationId, organizationId),
            inArray(employeeProfilesTable.userId, items.map((item) => item.userId)),
          ),
        )
    : [];
  const profileOf = new Map(profiles.map((profile) => [profile.userId, profile]));
  const narration = `Salary ${monthLabel(run.periodStart)}`;

  const rows: ReportCell[][] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const net = money(item.netPay);
    if (net <= 0) continue;
    const profile = profileOf.get(item.userId);
    const account = profile?.account ? decryptSecret(profile.account).replace(/\s/g, "") : "";
    const ifsc = (profile?.ifsc ?? "").replace(/\s/g, "").toUpperCase();
    if (!account || !ifsc) {
      skipped.push(`${item.employeeName}: no bank account or IFSC on their profile (Rs. ${net.toFixed(2)})`);
      continue;
    }
    if (!isValidIfsc(ifsc)) {
      skipped.push(`${item.employeeName}: IFSC "${ifsc}" is not valid (Rs. ${net.toFixed(2)})`);
      continue;
    }
    rows.push([profile?.holder?.trim() || item.employeeName, account, ifsc, net, "NEFT", narration, item.employeeCode ?? ""]);
  }

  return ok({
    title: "Salary bank transfer",
    subtitle: `${run.periodStart} to ${run.periodEnd} · ${rows.length} transfer${rows.length === 1 ? "" : "s"}`,
    organizationName,
    fileName: `salary-bank-transfer-${run.periodStart}-to-${run.periodEnd}`,
    columns: [
      { header: "Beneficiary name", width: 26 },
      { header: "Account number", width: 20 },
      { header: "IFSC", width: 13 },
      { header: "Amount (INR)", align: "right", width: 13 },
      { header: "Mode", width: 7 },
      { header: "Narration", width: 18 },
      { header: "Employee code", width: 13 },
    ],
    rows,
    totals: ["Total", null, null, sumColumn(rows, 3), null, null, null],
    notes: [
      "Upload the CSV in your bank's bulk payment screen, or map these columns to its template. Check the total against the bank's confirmation before approving.",
      "Authorised signatory: ______________________      Date: ______________",
      ...(skipped.length ? ["Not in this file, pay separately:", ...skipped] : []),
    ],
  });
};

/** Who was present each day of the period: the attendance register inspectors ask for. */
export const buildMusterRoll = async (
  organizationId: string,
  requesterId: string,
  query: { from: string; to: string; utcOffsetMinutes: number; branchId?: string },
  organizationName: string,
): Promise<ServiceResult<ReportTable>> => {
  if ((Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > 30) {
    return fail("invalid", "A muster roll covers at most one month; choose up to 31 days");
  }
  const dates = eachDate(query.from, query.to);

  const daily = await getDailyAttendance(organizationId, requesterId, query);
  if (!daily.ok) return daily;
  const statusOf = new Map(daily.data.map((day) => [`${day.employeeId}|${day.date}`, day.status]));
  const nameOf = new Map(daily.data.map((day) => [day.employeeId, day.employeeName]));
  const employeeIds = [...nameOf.keys()];

  const members = employeeIds.length
    ? await db
        .select({
          id: userOrganizationsTable.id,
          userId: userOrganizationsTable.userId,
          employeeCode: userOrganizationsTable.employeeCode,
          hireDate: userOrganizationsTable.hireDate,
          branchId: userOrganizationsTable.branchId,
        })
        .from(userOrganizationsTable)
        .where(and(eq(userOrganizationsTable.organizationId, organizationId), inArray(userOrganizationsTable.userId, employeeIds)))
    : [];
  const offDay = await loadOffDays(organizationId, query.from, query.to, members);
  const today = new Date(Date.now() + query.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

  const rows: ReportCell[][] = members
    .sort((a, b) => (nameOf.get(a.userId) ?? "").localeCompare(nameOf.get(b.userId) ?? ""))
    .map((member, index) => {
      const codes = dates.map((date) =>
        musterCode({
          status: statusOf.get(`${member.userId}|${date}`),
          ...offDay(member.id, date),
          beforeJoining: !!member.hireDate && date < member.hireDate,
          future: date > today,
        }),
      );
      const totals = musterTotals(codes);
      return [index + 1, nameOf.get(member.userId) ?? "", member.employeeCode ?? "", ...codes, totals.present, totals.absent, totals.leave, totals.off];
    });

  return ok({
    title: "Muster roll",
    subtitle: `${query.from} to ${query.to}`,
    organizationName,
    fileName: `muster-roll-${query.from}-to-${query.to}`,
    columns: [
      { header: "#", width: 3 },
      { header: "Employee", width: 15 },
      { header: "Code", width: 7 },
      ...dates.map((date) => ({ header: String(Number(date.slice(8))), width: 2.7 })),
      { header: "Pres.", align: "right" as const, width: 4.5 },
      { header: "Abs.", align: "right" as const, width: 4 },
      { header: "Leave", align: "right" as const, width: 4.5 },
      { header: "Off", align: "right" as const, width: 3.5 },
    ],
    rows,
    notes: [MUSTER_LEGEND],
    compact: true,
  });
};

const COMPENSATION_LABEL = { fixed_salary: "/ month", daily: "/ day", hourly: "/ hour" } as const;

/** Each employee's wages, deductions and net pay for one payroll run: the register of wages. */
export const buildWageRegister = async (
  organizationId: string,
  requesterId: string,
  runId: string,
  organizationName: string,
): Promise<ServiceResult<ReportTable>> => {
  const result = await getRun(organizationId, requesterId, runId);
  if (!result.ok) return result;
  const { run, items } = result.data;

  const rows: ReportCell[][] = items.map((item, index) => {
    const statutory = item.statutory;
    const pf = money(statutory?.pfEmployee);
    const esi = money(statutory?.esiEmployee);
    const pt = money(statutory?.professionalTax);
    const tds = money(statutory?.tds);
    const advances = money(item.loanDeduction);
    const fines = money(item.lateFine);
    const total = money(item.totalDeductions);
    return [
      index + 1,
      item.employeeName,
      item.employeeCode ?? "",
      item.jobTitle ?? "",
      `${money(item.compensationAmount)} ${COMPENSATION_LABEL[item.compensationType as keyof typeof COMPENSATION_LABEL] ?? ""}`.trim(),
      money(Number(item.presentDays) + Number(item.halfDays) / 2),
      money(item.paidLeaveDays),
      money(item.overtimeMinutes / 60),
      money(item.basePay),
      money(Number(item.overtimePay) + Number(item.offDayPay)),
      money(item.allowancesPay),
      money(item.bonus),
      money(item.grossPay),
      pf,
      esi,
      pt,
      tds,
      advances,
      fines,
      money(Math.max(0, total - pf - esi - pt - tds - advances - fines)),
      total,
      money(item.netPay),
      "",
    ];
  });

  const totalsFrom = 8;
  return ok({
    title: "Register of wages",
    subtitle: `${run.periodStart} to ${run.periodEnd}${run.status === "finalized" ? "" : " · DRAFT, not final"}`,
    organizationName,
    fileName: `wage-register-${run.periodStart}-to-${run.periodEnd}`,
    columns: [
      { header: "#", width: 2.5 },
      { header: "Employee", width: 13 },
      { header: "Code", width: 7 },
      { header: "Designation", width: 9 },
      { header: "Rate", width: 8 },
      { header: "Days", align: "right", width: 4.5 },
      { header: "P. leave", align: "right", width: 5 },
      { header: "OT hrs", align: "right", width: 4.5 },
      { header: "Wages", align: "right", width: 7 },
      { header: "OT & off", align: "right", width: 6 },
      { header: "Allow.", align: "right", width: 6 },
      { header: "Bonus", align: "right", width: 5.5 },
      { header: "Gross", align: "right", width: 7 },
      { header: "PF", align: "right", width: 5.5 },
      { header: "ESI", align: "right", width: 5 },
      { header: "PT", align: "right", width: 4.5 },
      { header: "TDS", align: "right", width: 5.5 },
      { header: "Adv.", align: "right", width: 5.5 },
      { header: "Fines", align: "right", width: 5 },
      { header: "Other", align: "right", width: 5 },
      { header: "Total ded.", align: "right", width: 7 },
      { header: "Net pay", align: "right", width: 7 },
      { header: "Signature", width: 8 },
    ],
    rows,
    // Columns 8 to 21 are amounts; the rest of the totals row stays empty.
    totals: [null, "Total", null, null, null, null, null, null, ...Array.from({ length: 22 - totalsFrom }, (_, i) => sumColumn(rows, totalsFrom + i)), null],
    notes: ["Employees sign or put a thumb impression in the last column when wages are paid in cash."],
    compact: true,
  });
};
