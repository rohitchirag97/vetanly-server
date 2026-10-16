import type { PayrollComponentLine, SettlementLine, StatutoryBreakup } from "@/drizzle/schema";

/**
 * Journal vouchers for accounting software, worked out in paise so every voucher balances exactly.
 * Payroll is booked on accrual: expenses are debited and what is owed to employees, the PF and ESI
 * funds and the tax department is credited. The salary payment itself is booked from the bank later.
 */

export type LedgerKey =
  | "salaries"
  | "bonus"
  | "reimbursements"
  | "employerPf"
  | "employerEsi"
  | "leaveEncashment"
  | "gratuity"
  | "salaryPayable"
  | "pfPayable"
  | "esiPayable"
  | "ptPayable"
  | "tdsPayable"
  | "employeeLoans"
  | "finesRecovered"
  | "noticeRecovery"
  | "otherDeductions"
  | "settlementPayable"
  | "bonusPayable";

/** Default ledger names and the Tally group each belongs under. */
export const LEDGERS: Record<LedgerKey, { name: string; group: string; label: string }> = {
  salaries: { name: "Salaries & Wages", group: "Indirect Expenses", label: "Salaries (basic, overtime, allowances)" },
  bonus: { name: "Bonus to Staff", group: "Indirect Expenses", label: "Bonus" },
  reimbursements: { name: "Staff Reimbursements", group: "Indirect Expenses", label: "Expense claims reimbursed" },
  employerPf: { name: "Employer's Contribution to PF", group: "Indirect Expenses", label: "Employer PF, admin and EDLI charges" },
  employerEsi: { name: "Employer's Contribution to ESI", group: "Indirect Expenses", label: "Employer ESI" },
  leaveEncashment: { name: "Leave Encashment", group: "Indirect Expenses", label: "Leave encashment (final settlement)" },
  gratuity: { name: "Gratuity", group: "Indirect Expenses", label: "Gratuity (final settlement)" },
  salaryPayable: { name: "Salary Payable", group: "Current Liabilities", label: "Net salary owed to employees" },
  pfPayable: { name: "PF Payable", group: "Current Liabilities", label: "PF to deposit (employee + employer)" },
  esiPayable: { name: "ESI Payable", group: "Current Liabilities", label: "ESI to deposit (employee + employer)" },
  ptPayable: { name: "Professional Tax Payable", group: "Duties & Taxes", label: "Professional tax deducted" },
  tdsPayable: { name: "TDS on Salary Payable", group: "Duties & Taxes", label: "TDS deducted (section 192)" },
  employeeLoans: { name: "Loans & Advances to Staff", group: "Loans & Advances (Asset)", label: "Loan and advance recoveries" },
  finesRecovered: { name: "Fines Recovered from Staff", group: "Indirect Incomes", label: "Late fines" },
  noticeRecovery: { name: "Notice Pay Recovery", group: "Indirect Incomes", label: "Notice pay recovered" },
  otherDeductions: { name: "Other Salary Deductions", group: "Current Liabilities", label: "Other deductions from salary" },
  settlementPayable: { name: "Full & Final Settlement Payable", group: "Current Liabilities", label: "Net full & final settlement owed" },
  bonusPayable: { name: "Bonus Payable", group: "Current Liabilities", label: "Bonus paid outside payroll" },
};

export const LEDGER_KEYS = Object.keys(LEDGERS) as LedgerKey[];

export type LedgerNames = Record<LedgerKey, string>;

export const defaultLedgerNames = (): LedgerNames =>
  Object.fromEntries(LEDGER_KEYS.map((key) => [key, LEDGERS[key].name])) as LedgerNames;

export type JournalLine = { ledger: string; debitCents: number; creditCents: number; costCentre: string | null };

export type Voucher = {
  /** Stable id of what the voucher books, e.g. "payroll:<runId>:Mumbai". */
  key: string;
  kind: "payroll" | "settlement" | "bonus";
  number: string;
  date: string;
  narration: string;
  lines: JournalLine[];
};

const cents = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 100);

/** Collects debits and credits by ledger, then nets each ledger to one side. */
class Builder {
  private totals = new Map<string, number>();
  constructor(private readonly names: LedgerNames, private readonly costCentre: string | null) {}
  debit(key: LedgerKey, amountCents: number) {
    if (amountCents) this.totals.set(this.names[key], (this.totals.get(this.names[key]) ?? 0) + amountCents);
  }
  credit(key: LedgerKey, amountCents: number) {
    this.debit(key, -amountCents);
  }
  lines(): JournalLine[] {
    const lines = [...this.totals]
      .filter(([, net]) => net !== 0)
      .map(([ledger, net]) => ({ ledger, debitCents: Math.max(net, 0), creditCents: Math.max(-net, 0), costCentre: this.costCentre }));
    // Debits first, as accountants write them.
    return [...lines.filter((l) => l.debitCents), ...lines.filter((l) => l.creditCents)];
  }
}

export type PayrollItemForJournal = {
  grossPay: string;
  bonus: string;
  lateFine: string;
  loanDeduction: string;
  netPay: string;
  reimbursements: string;
  componentLines: PayrollComponentLine[];
  statutory: StatutoryBreakup | null;
};

/** Statutory deductions appear among the deduction lines under these names (see payroll-calc). */
const STATUTORY_DEDUCTIONS: Record<string, LedgerKey> = {
  "Provident fund (employee)": "pfPayable",
  "ESI (employee)": "esiPayable",
  "Professional tax": "ptPayable",
  "Income tax (TDS)": "tdsPayable",
};

const employerContributions = (builder: Builder, statutory: StatutoryBreakup | null) => {
  if (!statutory) return;
  const pf = cents(statutory.pfEps) + cents(statutory.pfEpfDiff) + cents(statutory.pfAdmin) + cents(statutory.pfEdli);
  builder.debit("employerPf", pf);
  builder.credit("pfPayable", pf);
  builder.debit("employerEsi", cents(statutory.esiEmployer));
  builder.credit("esiPayable", cents(statutory.esiEmployer));
};

/** One salary voucher for a group of payroll items (a whole run, or one branch or department of it). */
export const payrollLines = (items: PayrollItemForJournal[], names: LedgerNames, costCentre: string | null) => {
  const builder = new Builder(names, costCentre);
  for (const item of items) {
    const bonus = cents(item.bonus);
    builder.debit("salaries", cents(item.grossPay) - bonus);
    builder.debit("bonus", bonus);
    builder.debit("reimbursements", cents(item.reimbursements));
    builder.credit("finesRecovered", cents(item.lateFine));
    builder.credit("employeeLoans", cents(item.loanDeduction));
    for (const line of item.componentLines.filter((l) => l.kind === "deduction")) {
      builder.credit(STATUTORY_DEDUCTIONS[line.name] ?? "otherDeductions", cents(line.amount));
    }
    builder.credit("salaryPayable", cents(item.netPay));
    employerContributions(builder, item.statutory);
  }
  return builder.lines();
};

export type SettlementForJournal = { lines: SettlementLine[]; statutory: StatutoryBreakup | null; netPayable: string };

/**
 * A full & final settlement. Its salary line is net of PF, ESI, PT and TDS, so the expense is grossed
 * back up from the statutory breakup and those deductions are credited to their ledgers.
 */
export const settlementLines = (settlement: SettlementForJournal, names: LedgerNames, costCentre: string | null) => {
  const builder = new Builder(names, costCentre);
  const s = settlement.statutory;
  for (const line of settlement.lines) {
    const amount = cents(line.amount);
    switch (line.kind) {
      case "salary": {
        const withheld = s ? cents(s.pfEmployee) + cents(s.esiEmployee) + cents(s.professionalTax) + cents(s.tds) : 0;
        builder.debit("salaries", amount + withheld);
        if (s) {
          builder.credit("pfPayable", cents(s.pfEmployee));
          builder.credit("esiPayable", cents(s.esiEmployee));
          builder.credit("ptPayable", cents(s.professionalTax));
          builder.credit("tdsPayable", cents(s.tds));
        }
        break;
      }
      case "leave_encashment":
        builder.debit("leaveEncashment", amount);
        break;
      case "gratuity":
        builder.debit("gratuity", amount);
        break;
      case "reimbursement":
        builder.debit("reimbursements", amount);
        break;
      case "other_earning":
        builder.debit("salaries", amount);
        break;
      case "notice_recovery":
        builder.credit("noticeRecovery", amount);
        break;
      case "loan_recovery":
        builder.credit("employeeLoans", amount);
        break;
      case "other_deduction":
        builder.credit("otherDeductions", amount);
        break;
    }
  }
  employerContributions(builder, s);
  // Net owed to the employee (or, when negative, owed by them) balances the voucher.
  builder.credit("settlementPayable", cents(settlement.netPayable));
  return builder.lines();
};

/** A bonus paid outside payroll: the expense against what is owed to employees. */
export const bonusLines = (amounts: string[], names: LedgerNames, costCentre: string | null) => {
  const builder = new Builder(names, costCentre);
  const total = amounts.reduce((sum, amount) => sum + cents(amount), 0);
  builder.debit("bonus", total);
  builder.credit("bonusPayable", total);
  return builder.lines();
};

export const voucherTotals = (lines: JournalLine[]) => ({
  debitCents: lines.reduce((sum, l) => sum + l.debitCents, 0),
  creditCents: lines.reduce((sum, l) => sum + l.creditCents, 0),
});
