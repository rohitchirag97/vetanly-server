import PDFDocument from "pdfkit";

import type { LoanNoc } from "@/services/loan-noc.services";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

export const buildLoanNocPdf = (noc: LoanNoc): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 60 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const kind = noc.type === "loan" ? "loan" : "salary advance";
    const amount = `${noc.currencyCode} ${Number(noc.principalAmount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

    doc.font("Helvetica-Bold").fontSize(18).text(noc.organizationName, { align: "center" });
    doc.moveDown(2);
    doc.fontSize(14).text("NO OBJECTION CERTIFICATE", { align: "center", underline: true });
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Reference: ${noc.reference}`, { continued: true }).text(`Date: ${fmtDate(noc.issuedAt)}`, { align: "right" });
    doc.moveDown(2);
    doc.fontSize(11).text("To whom it may concern,", { align: "left" });
    doc.moveDown();
    doc.text(
      `This is to certify that ${noc.employeeName}, an employee of ${noc.organizationName}, availed a ${kind} of ${amount}` +
        `${noc.disbursedAt ? ` which was disbursed on ${fmtDate(noc.disbursedAt)}` : ""}.`,
      { align: "justify", lineGap: 4 },
    );
    doc.moveDown();
    doc.text(
      `The amount has been repaid in full and the ${kind} was closed on ${fmtDate(noc.closedAt)}. ` +
        `${noc.organizationName} has no outstanding claim or dues against ${noc.employeeName} in respect of this ${kind}, ` +
        `and has no objection to this certificate being used for any lawful purpose.`,
      { align: "justify", lineGap: 4 },
    );
    doc.moveDown(5);
    doc.text("Authorised signatory");
    doc.text(noc.organizationName);
    doc.moveDown(3);
    doc.font("Helvetica").fontSize(8).fillColor("#777777").text("This is a system-generated certificate.", { align: "center" });
    doc.end();
  });
