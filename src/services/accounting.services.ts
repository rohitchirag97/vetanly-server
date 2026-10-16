import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  accountingExportsTable as exportsTable,
  accountingSettingsTable as settingsTable,
  bonusItemsTable,
  bonusRunsTable,
  branchesTable,
  departmentsTable,
  finalSettlementsTable,
  payrollItemsTable,
  payrollRunsTable,
  userOrganizationsTable as memberships,
  usersTable,
  type AccountingSplit,
} from "@/drizzle/schema";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { journalCsv, journalXlsx, tallyXml } from "@/services/accounting-format";
import {
  bonusLines,
  defaultLedgerNames,
  LEDGER_KEYS,
  LEDGERS,
  payrollLines,
  settlementLines,
  voucherTotals,
  type LedgerNames,
  type Voucher,
} from "@/services/accounting-journal";
import { fail, ok } from "@/utils/result";
import type { accountingExportSchema, accountingRangeSchema, accountingSettingsSchema } from "@/validator/accounting.validator";

/**
 * Accounting export: journal vouchers for finalized payroll, full & final settlements and bonuses paid
 * outside payroll, in Tally XML, CSV or Excel. Owners and admins of the whole organization only.
 */

const IST_OFFSET_MS = 330 * 60_000;
const istDate = (value: Date) => new Date(value.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const loadSettings = async (organizationId: string) => {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.organizationId, organizationId)).limit(1);
  const ledgers = { ...defaultLedgerNames() };
  for (const key of LEDGER_KEYS) {
    const name = row?.ledgers[key]?.trim();
    if (name) ledgers[key] = name;
  }
  return { ledgers, splitBy: (row?.splitBy ?? "none") as AccountingSplit };
};

export const getAccountingSettings = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const settings = await loadSettings(organizationId);
  return ok({
    ...settings,
    definitions: LEDGER_KEYS.map((key) => ({ key, label: LEDGERS[key].label, defaultName: LEDGERS[key].name, group: LEDGERS[key].group })),
  });
};

export const saveAccountingSettings = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof accountingSettingsSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  // Only names that differ from the default are stored, so better defaults later reach everyone else.
  const ledgers = Object.fromEntries(
    Object.entries(input.ledgers).filter(([key, name]) => LEDGER_KEYS.includes(key as never) && name.trim() && name.trim() !== LEDGERS[key as keyof typeof LEDGERS].name),
  );
  await db
    .insert(settingsTable)
    .values({ organizationId, ledgers, splitBy: input.splitBy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.organizationId, set: { ledgers, splitBy: input.splitBy, updatedAt: new Date() } });
  return getAccountingSettings(organizationId, requesterId);
};

/** Branch and department of every member, for cost centres. */
const memberGroups = async (organizationId: string) => {
  const rows = await db
    .select({ id: memberships.id, branch: branchesTable.name, department: departmentsTable.name, fname: usersTable.fname, lname: usersTable.lname, code: memberships.employeeCode })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .leftJoin(branchesTable, eq(branchesTable.id, memberships.branchId))
    .leftJoin(departmentsTable, eq(departmentsTable.id, memberships.departmentId))
    .where(eq(memberships.organizationId, organizationId));
  return new Map(rows.map((row) => [row.id, { ...row, name: `${row.fname} ${row.lname}`.trim() }]));
};

const UNASSIGNED: Record<AccountingSplit, string | null> = { none: null, branch: "No branch", department: "No department" };

const groupName = (split: AccountingSplit, member: { branch: string | null; department: string | null } | undefined) =>
  split === "branch" ? (member?.branch ?? UNASSIGNED.branch) : split === "department" ? (member?.department ?? UNASSIGNED.department) : null;

/** Splits records into cost-centre groups (one group when not splitting). */
const groupBy = <T>(records: T[], centreOf: (record: T) => string | null) => {
  const groups = new Map<string | null, T[]>();
  for (const record of records) {
    const centre = centreOf(record);
    groups.set(centre, [...(groups.get(centre) ?? []), record]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
};

const suffix = (centre: string | null) => (centre ? `/${centre}` : "");

const buildVouchers = async (organizationId: string, from: string, to: string, names: LedgerNames, split: AccountingSplit) => {
  const vouchers: Voucher[] = [];
  const members = await memberGroups(organizationId);

  // Payroll: finalized runs whose period ends in the range.
  const runs = await db
    .select()
    .from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.organizationId, organizationId), eq(payrollRunsTable.status, "finalized"), gte(payrollRunsTable.periodEnd, from), lte(payrollRunsTable.periodEnd, to)))
    .orderBy(payrollRunsTable.periodEnd);
  const items = runs.length
    ? await db.select().from(payrollItemsTable).where(inArray(payrollItemsTable.runId, runs.map((run) => run.id)))
    : [];
  for (const run of runs) {
    const runItems = items.filter((item) => item.runId === run.id);
    const centreOf = (item: (typeof items)[number]) =>
      split === "branch" ? (item.branchName ?? UNASSIGNED.branch) : split === "department" ? (item.departmentName ?? UNASSIGNED.department) : null;
    for (const [centre, group] of groupBy(runItems, centreOf)) {
      vouchers.push({
        key: `payroll:${run.id}${suffix(centre)}`,
        kind: "payroll",
        number: `PAY/${run.periodEnd}${suffix(centre)}`,
        date: run.periodEnd,
        narration: `Salary for ${run.periodStart} to ${run.periodEnd}, ${group.length} employee(s)${centre ? `, ${centre}` : ""}`,
        lines: payrollLines(group, names, centre),
      });
    }
  }

  // Full & final settlements finalized in the range (booked when finalized, not when paid).
  const settlements = await db
    .select()
    .from(finalSettlementsTable)
    .where(and(eq(finalSettlementsTable.organizationId, organizationId), inArray(finalSettlementsTable.status, ["finalized", "paid"])));
  for (const settlement of settlements) {
    if (!settlement.finalizedAt) continue;
    const date = istDate(settlement.finalizedAt);
    if (date < from || date > to) continue;
    const member = members.get(settlement.userOrganizationId);
    const centre = groupName(split, member);
    vouchers.push({
      key: `settlement:${settlement.id}`,
      kind: "settlement",
      number: `FNF/${member?.code ?? settlement.id.slice(0, 8)}`,
      date,
      narration: `Full & final settlement of ${member?.name ?? "an employee"}, last working day ${settlement.lastWorkingDay}`,
      lines: settlementLines(settlement, names, centre),
    });
  }

  // Bonuses paid directly; a bonus paid with payroll is already in that payroll's voucher.
  const bonusRuns = await db
    .select()
    .from(bonusRunsTable)
    .where(and(eq(bonusRunsTable.organizationId, organizationId), eq(bonusRunsTable.status, "paid"), eq(bonusRunsTable.payout, "direct")));
  for (const run of bonusRuns) {
    if (!run.paidAt) continue;
    const date = istDate(run.paidAt);
    if (date < from || date > to) continue;
    const paid = await db
      .select({ membershipId: bonusItemsTable.userOrganizationId, amount: bonusItemsTable.finalAmount, inPayroll: bonusItemsTable.paidInPayrollRunId })
      .from(bonusItemsTable)
      .where(and(eq(bonusItemsTable.runId, run.id), eq(bonusItemsTable.included, true)));
    const direct = paid.filter((item) => !item.inPayroll && Number(item.amount) > 0);
    for (const [centre, group] of groupBy(direct, (item) => groupName(split, members.get(item.membershipId)))) {
      vouchers.push({
        key: `bonus:${run.id}${suffix(centre)}`,
        kind: "bonus",
        number: `BONUS/${run.financialYear}${suffix(centre)}`,
        date,
        narration: `Statutory bonus ${run.financialYear} paid outside payroll, ${group.length} employee(s)${run.paymentReference ? `, ref ${run.paymentReference}` : ""}${centre ? `, ${centre}` : ""}`,
        lines: bonusLines(group.map((item) => item.amount), names, centre),
      });
    }
  }
  return vouchers.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
};

/** When each voucher was last downloaded, from the export log. */
const lastExported = async (organizationId: string) => {
  const rows = await db
    .select({ keys: exportsTable.voucherKeys, createdAt: exportsTable.createdAt, format: exportsTable.format })
    .from(exportsTable)
    .where(eq(exportsTable.organizationId, organizationId))
    .orderBy(desc(exportsTable.createdAt))
    .limit(500);
  const map = new Map<string, { at: Date; format: string }>();
  for (const row of rows) for (const key of row.keys) if (!map.has(key)) map.set(key, { at: row.createdAt, format: row.format });
  return map;
};

export const previewJournal = async (organizationId: string, requesterId: string, input: z.infer<typeof accountingRangeSchema>) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const settings = await loadSettings(organizationId);
  const vouchers = await buildVouchers(organizationId, input.from, input.to, settings.ledgers, settings.splitBy);
  const exported = await lastExported(organizationId);
  return ok({
    splitBy: settings.splitBy,
    vouchers: vouchers.map((voucher) => {
      const totals = voucherTotals(voucher.lines);
      return {
        ...voucher,
        lines: voucher.lines.map((line) => ({ ledger: line.ledger, debit: line.debitCents / 100, credit: line.creditCents / 100, costCentre: line.costCentre })),
        total: totals.debitCents / 100,
        balanced: totals.debitCents === totals.creditCents,
        lastExport: exported.get(voucher.key) ?? null,
      };
    }),
  });
};

const CONTENT_TYPES = {
  tally: "application/xml",
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export const exportJournal = async (organizationId: string, requesterId: string, input: z.infer<typeof accountingExportSchema>) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const settings = await loadSettings(organizationId);
  let vouchers = await buildVouchers(organizationId, input.from, input.to, settings.ledgers, settings.splitBy);
  if (input.keys) vouchers = vouchers.filter((voucher) => input.keys!.includes(voucher.key));
  if (vouchers.length === 0) return fail("invalid", "Nothing to export in this period");
  const unbalanced = vouchers.find((voucher) => {
    const totals = voucherTotals(voucher.lines);
    return totals.debitCents !== totals.creditCents;
  });
  if (unbalanced) return fail("conflict", `Voucher ${unbalanced.number} does not balance; it was not exported`);

  const usedLedgers = new Set(vouchers.flatMap((voucher) => voucher.lines.map((line) => line.ledger)));
  const masters = input.includeLedgers
    ? LEDGER_KEYS.filter((key) => usedLedgers.has(settings.ledgers[key]))
        .map((key) => ({ name: settings.ledgers[key], group: LEDGERS[key].group }))
        .filter((ledger, index, all) => all.findIndex((other) => other.name === ledger.name) === index)
    : [];
  const base = `journal-${input.from}-to-${input.to}`;
  const body =
    input.format === "tally"
      ? Buffer.from(tallyXml(vouchers, masters), "utf8")
      : input.format === "csv"
        ? Buffer.from(journalCsv(vouchers), "utf8")
        : await journalXlsx(vouchers, `Journal ${input.from} to ${input.to}`);

  await db.insert(exportsTable).values({
    organizationId,
    format: input.format,
    fromDate: input.from,
    toDate: input.to,
    voucherKeys: vouchers.map((voucher) => voucher.key),
    exportedByUserId: requesterId,
  });
  return ok({
    body,
    contentType: CONTENT_TYPES[input.format],
    fileName: `${base}${input.format === "tally" ? "-tally.xml" : input.format === "csv" ? ".csv" : ".xlsx"}`,
  });
};
