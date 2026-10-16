import { join } from "node:path";
import PDFDocument from "pdfkit";
import { env } from "@/utils/env";

const LOGO_PATH = join(import.meta.dir, "../assets/vetanly-icon.png");

type InvoicePdf = {
  invoiceNumber: string;
  organizationName: string;
  status: string;
  currencyCode: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  billTo: Record<string, string | null>;
  notes: string | null;
  issuedAt: Date;
  dueDate: string | null;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  items: Array<{ description: string; quantity: string; unitPrice: string; lineSubtotal: string; lineTax: string; lineTotal: string }>;
};

const amount = (value: string, currency: string) =>
  `${currency} ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateLabel = (value: string | Date | null) => {
  if (!value) return "—";
  const parsed = value instanceof Date ? value : new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export const buildPlatformInvoicePdf = (invoice: InvoicePdf): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const rule = (color = "#cbd5e1") => doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(color).stroke();
    const sellerName = env.PLATFORM_BILLING_NAME || "VETANLY";
    const statusLabel = invoice.status.toUpperCase();

    doc.image(LOGO_PATH, left, 44, { width: 28 });
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a").text(sellerName, left + 38, 48);
    doc.font("Helvetica-Bold").fontSize(16).text("TAX INVOICE", left, 48, { width, align: "right" });
    if (env.PLATFORM_BILLING_ADDRESS) doc.font("Helvetica").fontSize(9).fillColor("#475569").text(env.PLATFORM_BILLING_ADDRESS, left, 76, { width: width * 0.55 });
    if (env.PLATFORM_BILLING_GSTIN) doc.text(`GSTIN: ${env.PLATFORM_BILLING_GSTIN}`, left, doc.y + 3, { width: width * 0.55 });
    if (env.PLATFORM_BILLING_EMAIL) doc.text(env.PLATFORM_BILLING_EMAIL, left, doc.y + 3, { width: width * 0.55 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(invoice.status === "paid" ? "#047857" : invoice.status === "void" ? "#b91c1c" : "#0369a1").text(statusLabel, left, 92, { width, align: "right" });
    doc.moveDown(2);
    rule();
    doc.moveDown(0.8);

    const metadataY = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text("INVOICE NUMBER", left, metadataY);
    doc.text("ISSUED", left + width * 0.53, metadataY);
    doc.text("DUE DATE", left + width * 0.76, metadataY);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(invoice.invoiceNumber, left, metadataY + 14);
    doc.font("Helvetica").text(dateLabel(invoice.issuedAt), left + width * 0.53, metadataY + 14);
    doc.text(dateLabel(invoice.dueDate), left + width * 0.76, metadataY + 14);
    doc.y = metadataY + 43;
    rule();
    doc.moveDown(0.8);

    const billTo = invoice.billTo;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text("BILL TO");
    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a").text(billTo.legalName || invoice.organizationName);
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    if (billTo.gstin) doc.text(`GSTIN: ${billTo.gstin}`);
    const address = [billTo.addressLine1, billTo.addressLine2, [billTo.city, billTo.state, billTo.postalCode].filter(Boolean).join(", "), billTo.country].filter(Boolean);
    for (const line of address) doc.text(line ?? "");
    if (billTo.email) doc.text(`Email: ${billTo.email}`);
    doc.moveDown(1.2);

    const columns = { description: left, quantity: left + width * 0.57, rate: left + width * 0.68, tax: left + width * 0.81, amount: left + width * 0.91 };
    const tableTop = doc.y;
    doc.save().rect(left, tableTop, width, 25).fill("#e2e8f0").restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#334155");
    doc.text("DESCRIPTION", columns.description + 8, tableTop + 8, { width: width * 0.52 });
    doc.text("QTY", columns.quantity, tableTop + 8, { width: width * 0.1, align: "right" });
    doc.text("RATE", columns.rate, tableTop + 8, { width: width * 0.12, align: "right" });
    doc.text("GST", columns.tax, tableTop + 8, { width: width * 0.09, align: "right" });
    doc.text("AMOUNT", columns.amount, tableTop + 8, { width: width * 0.09, align: "right" });
    doc.y = tableTop + 25;

    for (const item of invoice.items) {
      const rowTop = doc.y;
      const descriptionHeight = doc.font("Helvetica").fontSize(9).heightOfString(item.description, { width: width * 0.52 });
      const rowHeight = Math.max(31, descriptionHeight + 18);
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(item.description, columns.description + 8, rowTop + 9, { width: width * 0.52 });
      doc.text(item.quantity, columns.quantity, rowTop + 9, { width: width * 0.1, align: "right" });
      doc.text(amount(item.unitPrice, invoice.currencyCode), columns.rate, rowTop + 9, { width: width * 0.12, align: "right" });
      doc.text(amount(item.lineTax, invoice.currencyCode), columns.tax, rowTop + 9, { width: width * 0.09, align: "right" });
      doc.font("Helvetica-Bold").text(amount(item.lineTotal, invoice.currencyCode), columns.amount, rowTop + 9, { width: width * 0.09, align: "right" });
      doc.moveTo(left, rowTop + rowHeight).lineTo(left + width, rowTop + rowHeight).strokeColor("#e2e8f0").stroke();
      doc.y = rowTop + rowHeight;
      if (doc.y > doc.page.height - 170) doc.addPage();
    }

    doc.moveDown(1);
    const totalsX = left + width * 0.58;
    const totalLine = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(bold ? "#0f172a" : "#475569");
      doc.text(label, totalsX, y, { width: width * 0.2 });
      doc.text(value, left, y, { width, align: "right" });
      doc.moveDown(0.75);
    };
    totalLine("Subtotal", amount(invoice.subtotal, invoice.currencyCode));
    totalLine(`GST (${Number(invoice.taxRate)}%)`, amount(invoice.taxAmount, invoice.currencyCode));
    rule("#94a3b8");
    doc.moveDown(0.6);
    totalLine("Total due", amount(invoice.totalAmount, invoice.currencyCode), true);
    if (invoice.paidAt) {
      totalLine(`Paid ${dateLabel(invoice.paidAt)}${invoice.paymentMethod ? ` · ${invoice.paymentMethod.replaceAll("_", " ")}` : ""}`, amount(invoice.totalAmount, invoice.currencyCode));
      if (invoice.paymentReference) doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`Payment reference: ${invoice.paymentReference}`, totalsX, doc.y);
    }
    if (invoice.notes) {
      doc.moveDown(1.5);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text("Notes");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9).fillColor("#475569").text(invoice.notes, { width });
    }
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("This invoice was generated by the Vetanly platform console.", left, doc.y, { width, align: "center" });
    doc.end();
  });
