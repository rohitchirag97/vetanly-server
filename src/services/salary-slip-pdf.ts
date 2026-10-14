import PDFDocument from "pdfkit";

import type { PayrollItem, PayrollRunRow } from "@/services/payroll.services";

type SlipData = { item: PayrollItem; run: PayrollRunRow; organizationName: string };

export const salarySlipFilename = ({ item, run }: SlipData) => {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    [
      "salary-slip",
      slug(item.employeeName),
      item.employeeCode ? slug(item.employeeCode) : null,
      run.periodStart,
      run.periodEnd,
      item.id.slice(0, 8),
    ]
      .filter(Boolean)
      .join("_") + ".pdf"
  );
};

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

// The built-in PDF fonts lack the rupee glyph, so amounts use the currency code.
const money = (value: string, currency: string) =>
  `${currency} ${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const buildSalarySlipPdf = ({ item: i, run, organizationName }: SlipData): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const m = (v: string) => money(v, i.currencyCode);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const rule = () => {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#cccccc").stroke();
      doc.moveDown(0.6);
    };
    const pair = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      doc.text(label, left, y, { width: width * 0.6 });
      doc.text(value, left, y, { width, align: "right" });
    };

    doc.font("Helvetica-Bold").fontSize(18).text(organizationName, { align: "center" });
    doc.font("Helvetica").fontSize(11).text(`Salary slip: ${run.periodStart} to ${run.periodEnd}`, { align: "center" });
    if (run.status !== "finalized") {
      doc.fillColor("#d97706").fontSize(9).text("DRAFT - NOT FINALIZED", { align: "center" }).fillColor("black");
    }
    doc.moveDown();
    rule();

    doc.fontSize(10).font("Helvetica");
    doc.text(`Employee: ${i.employeeName}`);
    doc.text(`Code: ${i.employeeCode ?? "-"}    Designation: ${i.jobTitle ?? "-"}    Department: ${i.departmentName ?? "-"}`);
    const basis = i.compensationType === "fixed_salary" ? "per pay period" : i.compensationType === "daily" ? "per day" : "per hour";
    doc.text(`Pay basis: ${m(i.compensationAmount)} ${basis}`);
    doc.moveDown(0.6);
    rule();

    doc.text(
      `Working days: ${i.workingDays}   Present: ${i.presentDays}   Half days: ${i.halfDays}   Paid leave: ${i.paidLeaveDays}   Unpaid leave: ${i.unpaidLeaveDays}   Absent: ${i.absentDays}`,
    );
    doc.text(`Hours worked: ${hours(i.workedMinutes)}   Overtime: ${hours(i.overtimeMinutes)}`);
    doc.moveDown(0.6);
    rule();

    doc.font("Helvetica-Bold").fontSize(11).text("Earnings");
    doc.moveDown(0.3);
    pair("Basic pay", m(i.basePay));
    doc.moveDown(0.3);
    pair("Overtime", m(i.overtimePay));
    for (const line of i.componentLines.filter((l) => l.kind === "earning")) {
      doc.moveDown(0.3);
      pair(line.name, m(line.amount));
    }
    doc.moveDown(0.3);
    pair("Gross pay", m(i.grossPay), true);
    doc.moveDown();

    doc.font("Helvetica-Bold").fontSize(11).text("Deductions", left);
    doc.moveDown(0.3);
    pair(`Late fine (${i.lateCount} late)`, m(i.lateFine));
    for (const line of i.componentLines.filter((l) => l.kind === "deduction")) {
      doc.moveDown(0.3);
      pair(line.name, m(line.amount));
    }
    for (const line of i.loanLines) {
      doc.moveDown(0.3);
      pair(line.label, m(line.amount));
    }
    doc.moveDown(0.3);
    pair("Total deductions", m(i.totalDeductions), true);
    doc.moveDown();

    // Expense claims paid back: outside gross and deductions, added to net pay.
    if (Number(i.reimbursements) > 0) {
      doc.font("Helvetica-Bold").fontSize(11).text("Reimbursements", left);
      for (const line of i.reimbursementLines) {
        doc.moveDown(0.3);
        pair(line.label, m(line.amount));
      }
      doc.moveDown(0.3);
      pair("Total reimbursements", m(i.reimbursements), true);
      doc.moveDown();
    }
    rule();

    doc.font("Helvetica-Bold").fontSize(14);
    const y = doc.y;
    doc.text("Net pay", left, y);
    doc.text(m(i.netPay), left, y, { width, align: "right" });
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(8).fillColor("#777777").text("This is a system-generated salary slip.", left, doc.y, { width, align: "center" });
    doc.end();
  });
