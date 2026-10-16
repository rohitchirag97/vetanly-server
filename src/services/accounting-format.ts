import ExcelJS from "exceljs";

import type { Voucher } from "@/services/accounting-journal";

/** Accounting export files: Tally import XML, a journal CSV (Zoho Books, QuickBooks, others), and Excel. */

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const amount = (cents: number) => (cents / 100).toFixed(2);

/**
 * Tally Prime / ERP 9 import (Gateway of Tally > Import > Vouchers). In Tally a debit is entered with
 * ISDEEMEDPOSITIVE Yes and a negative amount. Ledger masters can be included so missing ledgers are
 * created under their groups; Tally reports the ones that already exist and imports the rest.
 */
export const tallyXml = (vouchers: Voucher[], ledgerMasters: { name: string; group: string }[] = []) => {
  const masters = ledgerMasters
    .map(
      (ledger) => `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${xml(ledger.name)}" ACTION="Create">
      <NAME.LIST><NAME>${xml(ledger.name)}</NAME></NAME.LIST>
      <PARENT>${xml(ledger.group)}</PARENT>
      <ISBILLWISEON>No</ISBILLWISEON>
     </LEDGER>
    </TALLYMESSAGE>`,
    )
    .join("");
  const entries = vouchers
    .map((voucher) => {
      const lines = voucher.lines
        .map((line) => {
          const isDebit = line.debitCents > 0;
          const value = isDebit ? -line.debitCents : line.creditCents;
          const costCentre = line.costCentre
            ? `
       <CATEGORYALLOCATIONS.LIST>
        <CATEGORY>Primary Cost Category</CATEGORY>
        <COSTCENTREALLOCATIONS.LIST>
         <NAME>${xml(line.costCentre)}</NAME>
         <AMOUNT>${amount(value)}</AMOUNT>
        </COSTCENTREALLOCATIONS.LIST>
       </CATEGORYALLOCATIONS.LIST>`
            : "";
          return `
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${xml(line.ledger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
       <AMOUNT>${amount(value)}</AMOUNT>${costCentre}
      </ALLLEDGERENTRIES.LIST>`;
        })
        .join("");
      return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${voucher.date.replace(/-/g, "")}</DATE>
      <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER>
      <NARRATION>${xml(voucher.narration)}</NARRATION>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${lines}
     </VOUCHER>
    </TALLYMESSAGE>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
   </REQUESTDESC>
   <REQUESTDATA>${masters}${entries}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
};

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * One row per journal line. The columns match the manual-journal import of Zoho Books and QuickBooks
 * (map "Journal Number", "Journal Date", "Account", "Debit", "Credit"); other software can map them too.
 */
export const journalCsv = (vouchers: Voucher[]) => {
  const rows = [["Journal Date", "Journal Number", "Account", "Debit", "Credit", "Description", "Location"]];
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      rows.push([
        voucher.date,
        voucher.number,
        line.ledger,
        line.debitCents ? amount(line.debitCents) : "",
        line.creditCents ? amount(line.creditCents) : "",
        voucher.narration,
        line.costCentre ?? "",
      ]);
    }
  }
  // A byte-order mark so Excel reads the file as UTF-8.
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
};

export const journalXlsx = async (vouchers: Voucher[], title: string): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Journal");
  sheet.addRow([title]).font = { bold: true, size: 13 };
  sheet.addRow([]);
  const header = sheet.addRow(["Date", "Voucher", "Ledger", "Debit", "Credit", "Cost centre", "Narration"]);
  header.font = { bold: true };
  for (const voucher of vouchers) {
    voucher.lines.forEach((line, index) => {
      sheet.addRow([
        index === 0 ? voucher.date : "",
        index === 0 ? voucher.number : "",
        line.ledger,
        line.debitCents ? line.debitCents / 100 : null,
        line.creditCents ? line.creditCents / 100 : null,
        line.costCentre ?? "",
        index === 0 ? voucher.narration : "",
      ]);
    });
    const debit = voucher.lines.reduce((sum, l) => sum + l.debitCents, 0) / 100;
    const total = sheet.addRow(["", "", "Total", debit, debit, "", ""]);
    total.font = { bold: true };
    sheet.addRow([]);
  }
  sheet.getColumn(4).numFmt = "#,##0.00";
  sheet.getColumn(5).numFmt = "#,##0.00";
  [12, 22, 34, 14, 14, 16, 50].forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
