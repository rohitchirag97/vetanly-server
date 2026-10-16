import PDFDocument from "pdfkit";

import { isDeduction } from "@/services/settlement-calc";
import type { SettlementStatement } from "@/services/settlement.services";

// The built-in PDF fonts lack the rupee glyph, so amounts use the currency code.
const money = (value: string | number, currency: string) =>
  `${currency} ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EXIT_TYPES: Record<string, string> = {
  resignation: "Resignation",
  termination: "Termination",
  retirement: "Retirement",
  other: "Other",
};

/** The full & final settlement statement the employee signs to acknowledge receipt. */
export const buildSettlementPdf = ({ organizationName, employee, exit, settlement }: SettlementStatement): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const m = (value: string | number) => money(value, settlement.currencyCode);
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(label, left, y, { width: width * 0.68 });
      const after = doc.y;
      doc.text(value, left + width * 0.7, y, { width: width * 0.3, align: "right" });
      doc.y = Math.max(after, doc.y);
      doc.moveDown(0.3);
    };
    const rule = () => {
      doc.moveDown(0.3).moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#cccccc").stroke().moveDown(0.5);
    };

    doc.font("Helvetica-Bold").fontSize(16).text(organizationName, { align: "center" });
    doc.font("Helvetica").fontSize(11).text("Full & Final Settlement Statement", { align: "center" });
    if (settlement.status === "draft") doc.fillColor("#b45309").fontSize(9).text("DRAFT - NOT FINAL", { align: "center" }).fillColor("#000000");
    doc.moveDown();

    row("Employee", employee.employeeName);
    if (employee.employeeCode) row("Employee code", employee.employeeCode);
    if (employee.jobTitle) row("Designation", employee.jobTitle);
    if (employee.hireDate) row("Date of joining", employee.hireDate);
    row("Last working day", exit.lastWorkingDay);
    row("Reason for leaving", EXIT_TYPES[exit.exitType] ?? exit.exitType);
    rule();

    doc.font("Helvetica-Bold").fontSize(11).text("Earnings", left).moveDown(0.3);
    const earnings = settlement.lines.filter((line) => !isDeduction(line.kind));
    if (earnings.length === 0) row("None", m(0));
    for (const line of earnings) row(line.label, m(line.amount));
    row("Total earnings", m(settlement.totalEarnings), true);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(11).text("Deductions and recoveries", left).moveDown(0.3);
    const deductions = settlement.lines.filter((line) => isDeduction(line.kind));
    if (deductions.length === 0) row("None", m(0));
    for (const line of deductions) row(line.label, m(line.amount));
    row("Total deductions", m(settlement.totalDeductions), true);
    rule();

    const net = Number(settlement.netPayable);
    doc.font("Helvetica-Bold").fontSize(13);
    row(net >= 0 ? "Net amount payable to the employee" : "Net amount recoverable from the employee", m(Math.abs(net)), true);
    if (settlement.statutory) {
      const s = settlement.statutory;
      doc.font("Helvetica").fontSize(8).fillColor("#555555").text(
        `Final salary is shown after PF ${m(s.pfEmployee)}, ESI ${m(s.esiEmployee)}, professional tax ${m(s.professionalTax)} and TDS ${m(s.tds)}.`,
        left,
        doc.y,
        { width },
      ).fillColor("#000000");
    }
    if (settlement.paidAt) {
      doc.moveDown(0.5).font("Helvetica").fontSize(10).text(
        `Paid on ${settlement.paidAt.toISOString().slice(0, 10)} by ${settlement.paymentMethod?.replace("_", " ")}${settlement.paymentReference ? `, reference ${settlement.paymentReference}` : ""}.`,
        left,
      );
    }

    doc.moveDown(1.5).font("Helvetica").fontSize(10).text(
      `I, ${employee.employeeName}, acknowledge receipt of the above amount in full and final settlement of all my dues from ${organizationName}, and confirm I have no further claims against the organization.`,
      left,
      doc.y,
      { width },
    );
    doc.moveDown(3);
    const y = doc.y;
    doc.text("Employee's signature", left, y);
    doc.text("Authorised signatory", left, y, { width, align: "right" });
    doc.moveDown(0.3).fontSize(9).fillColor("#555555").text("Date: ____________", left).fillColor("#000000");
    doc.end();
  });
