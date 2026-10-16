import type { ReactElement } from "react";

import type { MessageType } from "@/drizzle/schema";
import { LoanNocEmail } from "@/emails/loan-noc-email";
import { SalarySlipEmail } from "@/emails/salary-slip-email";
import { loadLoanNoc } from "@/services/loan-noc.services";
import { buildLoanNocPdf } from "@/services/loan-noc-pdf";
import { loadSlipDelivery } from "@/services/payroll.services";
import { buildSalarySlipPdf, salarySlipFilename } from "@/services/salary-slip-pdf";

/**
 * What one message says: the recipient's current phone and email (read at send time, so an unlinked
 * account stops further delivery), the template variables, the PDF and the email version.
 */
export type MessageContent = {
  recipientName: string;
  phone: string | null; // digits with country code; null when no real phone is linked
  email: string | null; // only an address Google verified
  variables: Record<string, string>;
  pdf: { buffer: Buffer; filename: string } | null;
  emailMessage: { subject: string; react: ReactElement } | null;
};

const money = (currency: string, amount: string | number) =>
  `${currency} ${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const realPhone = (phone: string) => (phone.startsWith("g") ? null : phone.replace(/\D/g, ""));

export const buildMessageContent = async (organizationId: string, messageType: MessageType, relatedId: string | null): Promise<MessageContent> => {
  if (messageType === "salary_slip") {
    const delivery = relatedId ? await loadSlipDelivery(organizationId, relatedId) : null;
    if (!delivery) throw new Error("The salary slip no longer exists");
    const { item, run, organizationName } = delivery.pdf;
    const period = `${day(run.periodStart)} to ${day(run.periodEnd)}`;
    return {
      recipientName: item.employeeName,
      phone: realPhone(delivery.phone),
      email: delivery.email,
      variables: {
        employee_name: item.employeeName,
        organization_name: organizationName,
        period,
        gross_pay: money(item.currencyCode, item.grossPay),
        deductions: money(item.currencyCode, item.totalDeductions),
        net_pay: money(item.currencyCode, item.netPay),
      },
      pdf: { buffer: await buildSalarySlipPdf(delivery.pdf), filename: salarySlipFilename(delivery.pdf) },
      emailMessage: {
        subject: `Your salary slip for ${period} - ${organizationName}`,
        react: SalarySlipEmail({
          employeeName: item.employeeName,
          organizationName,
          period,
          grossPay: money(item.currencyCode, item.grossPay),
          totalDeductions: money(item.currencyCode, item.totalDeductions),
          netPay: money(item.currencyCode, item.netPay),
        }),
      },
    };
  }
  if (messageType === "loan_noc") {
    const loaded = relatedId ? await loadLoanNoc(organizationId, relatedId) : null;
    if (!loaded?.ok) throw new Error("The loan NOC is no longer available");
    const { noc, phone, email } = loaded.data;
    const kind = noc.type === "loan" ? "loan" : "salary advance";
    return {
      recipientName: noc.employeeName,
      phone: realPhone(phone),
      email,
      variables: {
        employee_name: noc.employeeName,
        organization_name: noc.organizationName,
        kind,
        amount: money(noc.currencyCode, noc.principalAmount),
        reference: noc.reference,
      },
      pdf: { buffer: await buildLoanNocPdf(noc), filename: `${noc.reference}.pdf` },
      emailMessage: {
        subject: `Your no objection certificate ${noc.reference} - ${noc.organizationName}`,
        react: LoanNocEmail({ employeeName: noc.employeeName, organizationName: noc.organizationName, kind, amount: money(noc.currencyCode, noc.principalAmount), reference: noc.reference }),
      },
    };
  }
  throw new Error(`No content for message type ${messageType}`);
};
