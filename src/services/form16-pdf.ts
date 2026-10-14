import PDFDocument from "pdfkit";

export type Form16Data = {
  employerName: string;
  employerTan: string;
  employerPan: string;
  employeeName: string;
  employeeCode: string;
  employeePan: string;
  designation: string;
  assessmentYear: string;
  periodFrom: string;
  periodTo: string;
  regime: "Old" | "New";
  quarters: { label: string; paid: number; tax: number }[];
  gross: number;
  standardDeduction: number;
  professionalTax: number;
  declaredDeductions: number;
  taxable: number;
  taxPayable: number;
  tdsDeducted: number;
  balance: number;
  placeDate: string;
};

// The built-in PDF fonts lack the rupee glyph.
const money = (value: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso: string) => iso.split("-").reverse().join("-");

/** Form 16 layout: boxed Part A style certificate with a Part B style computation. */
export const buildForm16Pdf = (data: Form16Data): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const margin = 36;
    const doc = new PDFDocument({ size: "A4", margin });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const x0 = margin;
    const width = doc.page.width - margin * 2;
    const half = width / 2;
    let y = margin;

    const cell = (
      x: number,
      top: number,
      w: number,
      h: number,
      text: string,
      opts: { bold?: boolean; align?: "left" | "center" | "right"; size?: number; fill?: string } = {},
    ) => {
      doc.lineWidth(0.7).strokeColor("#000000");
      if (opts.fill) doc.rect(x, top, w, h).fillAndStroke(opts.fill, "#000000");
      else doc.rect(x, top, w, h).stroke();
      doc
        .fillColor("#000000")
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.size ?? 9)
        .text(text, x + 4, top + (h - (opts.size ?? 9)) / 2 - 1, {
          width: w - 8,
          height: h,
          align: opts.align ?? "left",
          lineBreak: false,
          ellipsis: true,
        });
    };
    const row = (
      h: number,
      cells: { w: number; text: string; bold?: boolean; align?: "left" | "center" | "right"; fill?: string }[],
    ) => {
      let x = x0;
      for (const c of cells) {
        cell(x, y, c.w, h, c.text, c);
        x += c.w;
      }
      y += h;
    };
    // Title block
    row(18, [{ w: width, text: "FORM NO. 16", bold: true, align: "center" }]);
    row(16, [{ w: width, text: "[See rule 31(1)(a)]", align: "center" }]);
    row(18, [{ w: width, text: "PART A", bold: true, align: "center" }]);
    row(18, [
      {
        w: width,
        text: "Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source on Salary",
        bold: true,
        align: "center",
      },
    ]);

    // Employer / employee
    const pair = (leftLabel: string, leftValue: string, rightLabel: string, rightValue: string, h = 36) => {
      const top = y;
      cell(x0, top, half, h, "");
      cell(x0 + half, top, half, h, "");
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000");
      doc.text(leftLabel, x0 + 4, top + 5, { width: half - 8, lineBreak: false });
      doc.text(rightLabel, x0 + half + 4, top + 5, { width: half - 8, lineBreak: false });
      doc.font("Helvetica").fontSize(10);
      doc.text(leftValue || "-", x0 + 4, top + 19, { width: half - 8, lineBreak: false, ellipsis: true });
      doc.text(rightValue || "-", x0 + half + 4, top + 19, { width: half - 8, lineBreak: false, ellipsis: true });
      y += h;
    };
    pair("Name of the Employer", data.employerName, "Name and Designation of the Employee",
      data.designation ? `${data.employeeName}, ${data.designation}` : data.employeeName);
    pair("PAN of the Deductor", data.employerPan, "PAN of the Employee", data.employeePan);
    pair("TAN of the Deductor", data.employerTan, "Employee Reference No. provided by the Employer", data.employeeCode);

    // Assessment year and period
    const third = width / 3;
    row(18, [
      { w: third, text: "Assessment Year", bold: true, align: "center", fill: "#EDEDED" },
      { w: third, text: "Period From", bold: true, align: "center", fill: "#EDEDED" },
      { w: third, text: "Period To", bold: true, align: "center", fill: "#EDEDED" },
    ]);
    row(20, [
      { w: third, text: data.assessmentYear, align: "center" },
      { w: third, text: dmy(data.periodFrom), align: "center" },
      { w: third, text: dmy(data.periodTo), align: "center" },
    ]);

    // Quarterly summary
    row(20, [
      {
        w: width,
        text: "Summary of amount paid/credited and tax deducted at source thereon in respect of the employee",
        bold: true,
        align: "center",
      },
    ]);
    const qw = [width * 0.28, width * 0.36, width * 0.36];
    row(20, [
      { w: qw[0], text: "Quarter(s)", bold: true, align: "center", fill: "#EDEDED" },
      { w: qw[1], text: "Amount paid / credited (Rs.)", bold: true, align: "center", fill: "#EDEDED" },
      { w: qw[2], text: "Tax deducted (Rs.)", bold: true, align: "center", fill: "#EDEDED" },
    ]);
    for (const q of data.quarters) {
      row(18, [
        { w: qw[0], text: q.label, align: "center" },
        { w: qw[1], text: money(q.paid), align: "right" },
        { w: qw[2], text: money(q.tax), align: "right" },
      ]);
    }
    row(18, [
      { w: qw[0], text: "Total", bold: true, align: "center" },
      { w: qw[1], text: money(data.quarters.reduce((s, q) => s + q.paid, 0)), bold: true, align: "right" },
      { w: qw[2], text: money(data.quarters.reduce((s, q) => s + q.tax, 0)), bold: true, align: "right" },
    ]);

    // Part B computation
    y += 10;
    row(18, [{ w: width, text: "PART B", bold: true, align: "center" }]);
    row(20, [
      {
        w: width,
        text: `Details of salary paid and tax computed (${data.regime} tax regime)`,
        bold: true,
        align: "center",
      },
    ]);
    const lw = width * 0.72;
    const rw = width - lw;
    const line = (label: string, value: number, bold = false) =>
      row(19, [
        { w: lw, text: label, bold },
        { w: rw, text: money(value), bold, align: "right" },
      ]);
    row(18, [
      { w: lw, text: "Particulars", bold: true, fill: "#EDEDED" },
      { w: rw, text: "Amount (Rs.)", bold: true, align: "center", fill: "#EDEDED" },
    ]);
    line("1. Gross salary", data.gross);
    line("2. Less: Standard deduction under section 16(ia)", data.standardDeduction);
    if (data.regime === "Old") {
      line("3. Less: Tax on employment (professional tax) under section 16(iii)", data.professionalTax);
      line("4. Less: Deductions declared by the employee (Chapter VI-A)", data.declaredDeductions);
    }
    line("Total taxable income", data.taxable, true);
    line("Tax payable including 4% health and education cess", data.taxPayable);
    line("Less: Tax deducted at source", data.tdsDeducted);
    line(data.balance >= 0 ? "Balance tax payable" : "Excess tax deducted", Math.abs(data.balance), true);

    // Verification
    y += 10;
    row(18, [{ w: width, text: "Verification", bold: true, align: "center" }]);
    const verifyHeight = 46;
    cell(x0, y, width, verifyHeight, "");
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#000000")
      .text(
        `It is certified that tax of Rs. ${money(data.tdsDeducted)} has been deducted at source from the salary of ${data.employeeName} for the period stated above, based on the books of account and payroll records of the employer.`,
        x0 + 6,
        y + 6,
        { width: width - 12 },
      );
    y += verifyHeight;
    row(36, [
      { w: half, text: `Place / Date: ${data.placeDate}` },
      { w: half, text: "Signature of person responsible for deduction of tax" },
    ]);

    y += 10;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#555555")
      .text(
        "Computed from finalized payroll. This is not the TRACES-issued Form 16: challan and receipt details of Part A come from TRACES after TDS is deposited and filed.",
        x0,
        y,
        { width },
      );

    doc.end();
  });
