import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { buildForm16Pdf } from "@/services/form16-pdf";
import type { ReportCell, ReportTable } from "@/services/report.services";

const fmt = (cell: ReportCell) => {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") {
    return Number.isInteger(cell)
      ? String(cell)
      : cell.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return cell;
};

// Spreadsheet formulas can be injected through user-controlled text such as names and reasons.
const safeText = (cell: ReportCell): ReportCell =>
  typeof cell === "string" && /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;

export const buildXlsx = async (table: ReportTable): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31));
  const width = table.columns.length;

  sheet.addRow([table.organizationName]).font = { bold: true, size: 14 };
  sheet.addRow([`${table.title} — ${table.subtitle}`]).font = { bold: true };
  sheet.addRow([`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`]).font = {
    italic: true,
    color: { argb: "FF777777" },
  };
  sheet.addRow([]);

  const header = sheet.addRow(table.columns.map((column) => column.header));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3F51B5" } };
  });
  const headerRowNumber = header.number;

  for (const row of table.rows) sheet.addRow(row.map(safeText));
  if (table.totals) {
    const totals = sheet.addRow(table.totals.map(safeText));
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: "thin" } };
    });
  }
  if (table.notes?.length) {
    sheet.addRow([]);
    for (const note of table.notes) sheet.addRow([note]).font = { italic: true };
  }

  table.columns.forEach((column, index) => {
    const col = sheet.getColumn(index + 1);
    col.width = column.width ?? 14;
    if (column.align === "right") col.alignment = { horizontal: "right" };
  });
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: width },
  };

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const buildPdf = (table: ReportTable): Promise<Buffer> =>
  table.form16 ? buildForm16Pdf(table.form16) : buildTablePdf(table);

const buildTablePdf = (table: ReportTable): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const margin = 36;
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const usable = doc.page.width - margin * 2;
    const weights = table.columns.map((column) => column.width ?? 14);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((weight) => (weight / totalWeight) * usable);
    // Wide registers (31 day columns, 23 wage columns) need a smaller font to fit on one landscape page.
    const fontSize = table.compact ? 6.5 : 8;
    const pad = table.compact ? 1.5 : 3;
    const rowHeight = table.compact ? 15 : 18;
    const bottom = () => doc.page.height - margin - 14;

    const drawRow = (cells: ReportCell[], y: number, style: "head" | "body" | "total") => {
      if (style === "head") doc.rect(margin, y - 3, usable, rowHeight).fill("#3F51B5");
      doc
        .fillColor(style === "head" ? "#FFFFFF" : "#111111")
        .font(style === "body" ? "Helvetica" : "Helvetica-Bold")
        .fontSize(fontSize);
      let x = margin;
      cells.forEach((cell, index) => {
        doc.text(String(fmt(cell)), x + pad, y, {
          width: widths[index] - pad * 2,
          height: rowHeight - 4,
          ellipsis: true,
          lineBreak: false,
          align: table.columns[index].align ?? "left",
        });
        x += widths[index];
      });
      if (style === "total") {
        doc.moveTo(margin, y - 3).lineTo(margin + usable, y - 3).strokeColor("#999999").stroke();
      }
    };

    const drawTitle = () => {
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text(table.organizationName, margin, margin);
      doc.font("Helvetica").fontSize(10).fillColor("#444444").text(`${table.title} — ${table.subtitle}`);
      return doc.y + 10;
    };

    let y = drawTitle();
    drawRow(table.columns.map((column) => column.header), y, "head");
    y += rowHeight;

    table.rows.forEach((row, index) => {
      if (y + rowHeight > bottom()) {
        doc.addPage();
        y = margin;
        drawRow(table.columns.map((column) => column.header), y, "head");
        y += rowHeight;
      }
      if (index % 2 === 1) doc.rect(margin, y - 3, usable, rowHeight).fill("#F3F4F8");
      drawRow(row, y, "body");
      y += rowHeight;
    });

    if (table.totals) {
      if (y + rowHeight > bottom()) {
        doc.addPage();
        y = margin;
      }
      drawRow(table.totals, y + 2, "total");
      y += rowHeight + 2;
    }
    if (table.notes?.length) {
      y += 10;
      doc.fillColor("#333333").font("Helvetica").fontSize(8);
      for (const note of table.notes) {
        if (y + 24 > bottom()) {
          doc.addPage();
          y = margin;
        }
        doc.text(note, margin, y, { width: usable });
        y = doc.y + 4;
      }
    }
    if (table.rows.length === 0) {
      doc.fillColor("#777777").font("Helvetica").fontSize(10).text("No records for this selection.", margin, y + 8);
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // The page number sits below the bottom margin; without this pdfkit would start a new page for it.
      doc.page.margins.bottom = 0;
      doc
        .fillColor("#777777")
        .font("Helvetica")
        .fontSize(8)
        .text(`Page ${i + 1} of ${range.count}`, margin, doc.page.height - margin - 4, {
          width: usable,
          align: "right",
          lineBreak: false,
        });
    }
    doc.end();
  });
