import { describe, expect, test } from "bun:test";

import { defaultLedgerNames, payrollLines, settlementLines, voucherTotals } from "@/services/accounting-journal";
import { journalCsv, tallyXml } from "@/services/accounting-format";
import { emptyBreakup } from "@/services/statutory-calc";

const names = defaultLedgerNames();
const statutory = { ...emptyBreakup("new"), pfEmployee: 1800, pfEps: 1250, pfEpfDiff: 550, pfAdmin: 75, pfEdli: 75, esiEmployee: 0, esiEmployer: 0, professionalTax: 200, tds: 1000 };

// Gross 25,500 incl. 500 bonus; deductions: fine 100, PF 1,800, PT 200, TDS 1,000, canteen 300, loan 2,000.
const item = {
  grossPay: "25500.00",
  bonus: "500.00",
  lateFine: "100.00",
  loanDeduction: "2000.00",
  reimbursements: "750.00",
  netPay: (25500 - 100 - 1800 - 200 - 1000 - 300 - 2000 + 750).toFixed(2),
  componentLines: [
    { name: "HRA", kind: "earning" as const, amount: "5000.00" },
    { name: "Provident fund (employee)", kind: "deduction" as const, amount: "1800.00" },
    { name: "Professional tax", kind: "deduction" as const, amount: "200.00" },
    { name: "Income tax (TDS)", kind: "deduction" as const, amount: "1000.00" },
    { name: "Canteen", kind: "deduction" as const, amount: "300.00" },
  ],
  statutory,
};

const amountOf = (lines: ReturnType<typeof payrollLines>, ledger: string) => {
  const line = lines.find((l) => l.ledger === ledger);
  return line ? (line.debitCents - line.creditCents) / 100 : 0;
};

describe("payroll journal", () => {
  const lines = payrollLines([item, item], names, null);

  test("balances", () => {
    const totals = voucherTotals(lines);
    expect(totals.debitCents).toBe(totals.creditCents);
  });

  test("books each amount to its ledger", () => {
    expect(amountOf(lines, "Salaries & Wages")).toBe(2 * 25000);
    expect(amountOf(lines, "Bonus to Staff")).toBe(2 * 500);
    expect(amountOf(lines, "Staff Reimbursements")).toBe(2 * 750);
    expect(amountOf(lines, "Employer's Contribution to PF")).toBe(2 * 1950);
    // Employee 1,800 + employer 1,950, credited.
    expect(amountOf(lines, "PF Payable")).toBe(-2 * 3750);
    expect(amountOf(lines, "Professional Tax Payable")).toBe(-400);
    expect(amountOf(lines, "TDS on Salary Payable")).toBe(-2000);
    expect(amountOf(lines, "Other Salary Deductions")).toBe(-600);
    expect(amountOf(lines, "Loans & Advances to Staff")).toBe(-4000);
    expect(amountOf(lines, "Fines Recovered from Staff")).toBe(-200);
    expect(amountOf(lines, "Salary Payable")).toBe(-2 * Number(item.netPay));
    // No ESI was due, so no ESI lines.
    expect(lines.some((l) => l.ledger.startsWith("ESI") || l.ledger.includes("ESI"))).toBe(false);
  });

  test("custom ledger names are used, and two keys sharing a name are merged", () => {
    const merged = payrollLines([item], { ...names, bonus: "Salaries & Wages" }, "Mumbai");
    expect(amountOf(merged, "Salaries & Wages")).toBe(25500);
    expect(merged.every((l) => l.costCentre === "Mumbai")).toBe(true);
  });
});

describe("settlement journal", () => {
  test("grosses the net salary back up and balances", () => {
    const lines = settlementLines(
      {
        statutory,
        netPayable: (20000 + 8000 + 50000 - 10000 - 5000).toFixed(2),
        lines: [
          { kind: "salary", label: "Salary", amount: "20000.00" },
          { kind: "leave_encashment", label: "Leave", amount: "8000.00" },
          { kind: "gratuity", label: "Gratuity", amount: "50000.00" },
          { kind: "notice_recovery", label: "Notice", amount: "10000.00" },
          { kind: "loan_recovery", label: "Loan", amount: "5000.00" },
        ],
      },
      names,
      null,
    );
    const totals = voucherTotals(lines);
    expect(totals.debitCents).toBe(totals.creditCents);
    expect(amountOf(lines, "Salaries & Wages")).toBe(20000 + 1800 + 200 + 1000);
    expect(amountOf(lines, "Gratuity")).toBe(50000);
    expect(amountOf(lines, "Full & Final Settlement Payable")).toBe(-63000);
  });
});

describe("file formats", () => {
  const voucher = { key: "k", kind: "payroll" as const, number: "PAY/2026-09", date: "2026-09-30", narration: 'Salary "Sept" & co', lines: payrollLines([item], names, "Mumbai") };

  test("Tally: debits negative and deemed positive, text escaped, dates compact", () => {
    const text = tallyXml([voucher], [{ name: "Salary Payable", group: "Current Liabilities" }]);
    expect(text).toContain("<DATE>20260930</DATE>");
    expect(text).toContain("<LEDGERNAME>Salaries &amp; Wages</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <AMOUNT>-25000.00</AMOUNT>");
    expect(text).toContain("Salary &quot;Sept&quot; &amp; co");
    expect(text).toContain('<LEDGER NAME="Salary Payable" ACTION="Create">');
    expect(text).toContain("<NAME>Mumbai</NAME>");
  });

  test("CSV quotes text with commas and quotes", () => {
    const text = journalCsv([voucher]);
    expect(text.split("\r\n")[0]).toBe("﻿Journal Date,Journal Number,Account,Debit,Credit,Description,Location");
    expect(text).toContain('"Salary ""Sept"" & co"');
  });
});
