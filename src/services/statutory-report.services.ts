import { and, asc, eq, gte, lte } from "drizzle-orm";

import db from "@/utils/db";
import { payrollItemsTable as items, payrollRunsTable as runs } from "@/drizzle/schema";
import { getRun } from "@/services/payroll.services";
import type { ReportCell, ReportTable } from "@/services/report.services";
import { annualTax, financialYearOf, STANDARD_DEDUCTION } from "@/services/statutory-calc";
import { loadEmployeeStatutoryMap, loadStatutorySettings } from "@/services/statutory.services";
import { fail, ok, type ServiceResult } from "@/utils/result";

const rupees = (value: number) => Math.round(value * 100) / 100;
const sumOf = (rows: ReportCell[][], index: number) =>
  rupees(rows.reduce((total, row) => total + (Number(row[index]) || 0), 0));
const money = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type StatutoryKind = "pf" | "esi" | "pt" | "tds";

export const buildStatutoryRunReport = async (
  organizationId: string,
  requesterId: string,
  kind: StatutoryKind,
  runId: string,
  organizationName: string,
): Promise<ServiceResult<ReportTable>> => {
  const run = await getRun(organizationId, requesterId, runId);
  if (!run.ok) return run;
  const [{ identity }, profiles] = await Promise.all([
    loadStatutorySettings(organizationId),
    loadEmployeeStatutoryMap(organizationId),
  ]);
  const period = `${run.data.run.periodStart} to ${run.data.run.periodEnd}`;
  const fileName = `${kind}-${run.data.run.periodStart}-to-${run.data.run.periodEnd}`;
  const base = { organizationName, subtitle: period, fileName };
  const withData = run.data.items.filter((item) => item.statutory);

  if (kind === "pf") {
    const rows = withData
      .filter((item) => item.statutory!.pfEmployee > 0)
      .map((item): ReportCell[] => {
        const s = item.statutory!;
        const ncp = Number(item.workingDays) - Number(item.presentDays) - Number(item.halfDays) / 2 - Number(item.paidLeaveDays);
        return [
          item.employeeName,
          profiles.get(item.userOrganizationId).uan ?? "",
          Number(item.grossPay),
          s.pfWages,
          s.epsWages,
          s.epsWages,
          s.pfEmployee,
          s.pfEps,
          s.pfEpfDiff,
          s.pfAdmin,
          s.pfEdli,
          Math.max(ncp, 0),
        ];
      });
    const employer = sumOf(rows, 8) + sumOf(rows, 7);
    return ok({
      ...base,
      title: "Provident fund (ECR) report",
      columns: [
        { header: "Employee", width: 24 },
        { header: "UAN", width: 14 },
        { header: "Gross wages", align: "right", width: 12 },
        { header: "EPF wages", align: "right", width: 11 },
        { header: "EPS wages", align: "right", width: 11 },
        { header: "EDLI wages", align: "right", width: 11 },
        { header: "EPF (EE 12%)", align: "right", width: 11 },
        { header: "EPS (8.33%)", align: "right", width: 11 },
        { header: "EPF diff", align: "right", width: 10 },
        { header: "Admin", align: "right", width: 9 },
        { header: "EDLI", align: "right", width: 9 },
        { header: "NCP days", align: "right", width: 9 },
      ],
      rows,
      totals: ["Total", null, sumOf(rows, 2), sumOf(rows, 3), sumOf(rows, 4), sumOf(rows, 5), sumOf(rows, 6), sumOf(rows, 7), sumOf(rows, 8), sumOf(rows, 9), sumOf(rows, 10), sumOf(rows, 11)],
      notes: [
        `Establishment code: ${identity?.pfEstablishmentCode ?? "not set"}`,
        `Challan: employee share ${money(sumOf(rows, 6))} + employer share ${money(employer)} = A/c 1 total ${money(sumOf(rows, 6) + sumOf(rows, 8))}; A/c 10 (EPS) ${money(sumOf(rows, 7))}; A/c 2 (admin) ${money(sumOf(rows, 9))}; A/c 21 (EDLI) ${money(sumOf(rows, 10))}`,
        `Grand total payable: ${money(sumOf(rows, 6) + sumOf(rows, 8) + sumOf(rows, 7) + sumOf(rows, 9) + sumOf(rows, 10))}`,
      ],
    });
  }

  if (kind === "esi") {
    const rows = withData
      .filter((item) => item.statutory!.esiEmployee > 0 || item.statutory!.esiEmployer > 0)
      .map((item): ReportCell[] => {
        const s = item.statutory!;
        return [
          item.employeeName,
          profiles.get(item.userOrganizationId).esiNumber ?? "",
          Number(item.presentDays) + Number(item.halfDays) / 2 + Number(item.paidLeaveDays),
          s.esiWages,
          s.esiEmployee,
          s.esiEmployer,
          rupees(s.esiEmployee + s.esiEmployer),
        ];
      });
    return ok({
      ...base,
      title: "ESI contribution report",
      columns: [
        { header: "Employee", width: 26 },
        { header: "IP number", width: 18 },
        { header: "Days worked", align: "right", width: 11 },
        { header: "Wages", align: "right", width: 12 },
        { header: "Employee 0.75%", align: "right", width: 13 },
        { header: "Employer 3.25%", align: "right", width: 13 },
        { header: "Total", align: "right", width: 12 },
      ],
      rows,
      totals: ["Total", null, null, sumOf(rows, 3), sumOf(rows, 4), sumOf(rows, 5), sumOf(rows, 6)],
      notes: [`Employer code: ${identity?.esiEstablishmentCode ?? "not set"}`, `Challan total payable: ${money(sumOf(rows, 6))}`],
    });
  }

  if (kind === "pt") {
    const rows = withData
      .filter((item) => item.statutory!.professionalTax > 0)
      .map((item): ReportCell[] => [item.employeeName, item.employeeCode ?? "", Number(item.grossPay), item.statutory!.professionalTax]);
    return ok({
      ...base,
      title: "Professional tax report",
      columns: [
        { header: "Employee", width: 28 },
        { header: "Code", width: 12 },
        { header: "Gross pay", align: "right", width: 14 },
        { header: "Professional tax", align: "right", width: 16 },
      ],
      rows,
      totals: ["Total", null, sumOf(rows, 2), sumOf(rows, 3)],
    });
  }

  const rows = withData.map((item): ReportCell[] => [
    item.employeeName,
    profiles.get(item.userOrganizationId).pan ?? "",
    item.statutory!.taxRegime === "old" ? "Old" : "New",
    Number(item.grossPay),
    item.statutory!.tds,
  ]);
  return ok({
    ...base,
    title: "TDS on salary (section 192) report",
    columns: [
      { header: "Employee", width: 26 },
      { header: "PAN", width: 14 },
      { header: "Regime", width: 9 },
      { header: "Gross pay", align: "right", width: 14 },
      { header: "TDS deducted", align: "right", width: 14 },
    ],
    rows,
    totals: ["Total", null, null, sumOf(rows, 3), sumOf(rows, 4)],
    notes: [`TAN: ${identity?.tan ?? "not set"}`, "PAN is shown in full: share this file only with people who file returns."],
  });
};

/** EPFO ECR text file: one `#~#`-separated line per member. */
export const buildPfEcr = async (
  organizationId: string,
  requesterId: string,
  runId: string,
): Promise<ServiceResult<{ fileName: string; text: string }>> => {
  const run = await getRun(organizationId, requesterId, runId);
  if (!run.ok) return run;
  const profiles = await loadEmployeeStatutoryMap(organizationId);
  const lines: string[] = [];
  const missing: string[] = [];
  for (const item of run.data.items) {
    const s = item.statutory;
    if (!s || s.pfEmployee <= 0) continue;
    const uan = profiles.get(item.userOrganizationId).uan;
    if (!uan) {
      missing.push(item.employeeName);
      continue;
    }
    const ncp = Math.max(
      Math.round(Number(item.workingDays) - Number(item.presentDays) - Number(item.halfDays) / 2 - Number(item.paidLeaveDays)),
      0,
    );
    lines.push(
      [
        uan,
        item.employeeName.replace(/#/g, ""),
        Math.round(Number(item.grossPay)),
        Math.round(s.pfWages),
        Math.round(s.epsWages),
        Math.round(s.epsWages),
        Math.round(s.pfEmployee),
        Math.round(s.pfEps),
        Math.round(s.pfEpfDiff),
        ncp,
        0,
      ].join("#~#"),
    );
  }
  if (missing.length > 0) {
    return fail("invalid", `Add a UAN for: ${missing.join(", ")}`);
  }
  if (lines.length === 0) return fail("invalid", "No PF contributions in this run");
  return ok({
    fileName: `ecr-${run.data.run.periodStart}-to-${run.data.run.periodEnd}.txt`,
    text: `${lines.join("\n")}\n`,
  });
};

export const buildForm16 = async (
  organizationId: string,
  employeeId: string,
  fy: string,
  organizationName: string,
): Promise<ServiceResult<ReportTable>> => {
  const match = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!match) return fail("invalid", "Financial year looks like 2026-27");
  const year = financialYearOf(`${match[1]}-04-01`);
  const rows = await db
    .select({ item: items, periodStart: runs.periodStart, periodEnd: runs.periodEnd })
    .from(items)
    .innerJoin(runs, and(eq(runs.id, items.runId), eq(runs.organizationId, items.organizationId)))
    .where(
      and(
        eq(items.organizationId, organizationId),
        eq(items.userId, employeeId),
        eq(runs.status, "finalized"),
        gte(runs.periodStart, year.from),
        lte(runs.periodEnd, year.to),
      ),
    )
    .orderBy(asc(runs.periodStart));
  if (rows.length === 0) return fail("not-found", "No finalized payroll for this employee in that year");

  const first = rows[0].item;
  const profiles = await loadEmployeeStatutoryMap(organizationId, [first.userOrganizationId]);
  const profile = profiles.get(first.userOrganizationId);
  const { identity } = await loadStatutorySettings(organizationId);

  const table = rows.map(({ item, periodStart }): ReportCell[] => [
    periodStart.slice(0, 7),
    Number(item.grossPay),
    item.statutory?.pfEmployee ?? 0,
    item.statutory?.professionalTax ?? 0,
    item.statutory?.tds ?? 0,
  ]);
  const gross = sumOf(table, 1);
  const pf = sumOf(table, 2);
  const pt = sumOf(table, 3);
  const tds = sumOf(table, 4);
  const regime = profile.taxRegime;
  const computed = annualTax(gross, regime, pt, profile.declaredDeductions);
  const tax = rupees(computed.total);
  const taxable = computed.taxable;

  const quarterOf = (periodStart: string) => {
    const month = Number(periodStart.slice(5, 7));
    return month >= 4 && month <= 6 ? 0 : month >= 7 && month <= 9 ? 1 : month >= 10 ? 2 : 3;
  };
  const quarters = ["Quarter 1", "Quarter 2", "Quarter 3", "Quarter 4"].map((label) => ({ label, paid: 0, tax: 0 }));
  for (const { item, periodStart } of rows) {
    const q = quarters[quarterOf(periodStart)];
    q.paid = rupees(q.paid + Number(item.grossPay));
    q.tax = rupees(q.tax + (item.statutory?.tds ?? 0));
  }

  return ok({
    form16: {
      employerName: organizationName,
      employerTan: identity?.tan ?? "",
      employerPan: identity?.employerPan ?? "",
      employeeName: first.employeeName,
      employeeCode: first.employeeCode ?? "",
      employeePan: profile.pan ?? "",
      designation: first.jobTitle ?? "",
      assessmentYear: `${year.start + 1}-${String(year.start + 2).slice(2)}`,
      periodFrom: year.from,
      periodTo: year.to,
      regime: regime === "old" ? "Old" : "New",
      quarters,
      gross,
      standardDeduction: STANDARD_DEDUCTION[regime],
      professionalTax: pt,
      declaredDeductions: profile.declaredDeductions,
      taxable,
      taxPayable: tax,
      tdsDeducted: tds,
      balance: rupees(tax - tds),
      placeDate: new Date().toISOString().slice(0, 10).split("-").reverse().join("-"),
    },
    organizationName,
    title: `Annual salary and tax statement FY ${year.label}`,
    subtitle: `${first.employeeName}${first.employeeCode ? ` (${first.employeeCode})` : ""}`,
    fileName: `form16-${first.employeeName}-${year.label}`,
    columns: [
      { header: "Month", width: 14 },
      { header: "Gross salary", align: "right", width: 16 },
      { header: "PF (employee)", align: "right", width: 16 },
      { header: "Professional tax", align: "right", width: 16 },
      { header: "TDS deducted", align: "right", width: 16 },
    ],
    rows: table,
    totals: ["Total", gross, pf, pt, tds],
    notes: [
      `Employee PAN: ${profile.pan ?? "not on file"}    Employer TAN: ${identity?.tan ?? "not set"}    Employer PAN: ${identity?.employerPan ?? "not set"}`,
      `Tax regime: ${regime === "old" ? "Old" : "New"}    Standard deduction: ${money(STANDARD_DEDUCTION[regime])}${regime === "old" ? `    Professional tax: ${money(pt)}    Declared deductions: ${money(profile.declaredDeductions)}` : ""}`,
      `Taxable income: ${money(taxable)}    Tax on income incl. 4% cess: ${money(tax)}    TDS deducted: ${money(tds)}    Balance: ${money(rupees(tax - tds))}`,
      "This is a Part B style summary computed from finalized payroll. It is not the TRACES-issued Form 16; Part A must be downloaded from TRACES after TDS is deposited and filed.",
    ],
  });
};
