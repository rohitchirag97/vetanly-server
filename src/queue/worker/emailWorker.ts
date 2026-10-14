import { Worker, type Job } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import type { LoanNocWhatsAppJob, SalarySlipWhatsAppJob } from "@/queue/types";
import { LoanNocEmail } from "@/emails/loan-noc-email";
import { SalarySlipEmail } from "@/emails/salary-slip-email";
import { loadLoanNoc } from "@/services/loan-noc.services";
import { buildLoanNocPdf } from "@/services/loan-noc-pdf";
import { loadSlipDelivery } from "@/services/payroll.services";
import { buildSalarySlipPdf, salarySlipFilename } from "@/services/salary-slip-pdf";
import { sendPdfEmail } from "@/utils/mailer";

const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, "$1***$2");

const money = (currency: string, amount: string | number) =>
  `${currency} ${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

async function sendSalarySlip(job: Job<SalarySlipWhatsAppJob>) {
  const delivery = await loadSlipDelivery(job.data.organizationId, job.data.itemId);
  if (!delivery) throw new Error("Salary slip no longer exists");
  // The address is read at send time, so an unlinked Google account stops further delivery.
  if (!delivery.email) throw new Error("Employee no longer has a linked Google email");
  const { item, run, organizationName } = delivery.pdf;
  const period = `${day(run.periodStart)} to ${day(run.periodEnd)}`;
  await sendPdfEmail({
    to: delivery.email,
    subject: `Your salary slip for ${period} - ${organizationName}`,
    react: SalarySlipEmail({
      employeeName: item.employeeName,
      organizationName,
      period,
      grossPay: money(item.currencyCode, item.grossPay),
      totalDeductions: money(item.currencyCode, item.totalDeductions),
      netPay: money(item.currencyCode, item.netPay),
    }),
    filename: salarySlipFilename(delivery.pdf),
    pdf: await buildSalarySlipPdf(delivery.pdf),
    idempotencyKey: `salary-slip-email/${job.data.itemId}/${job.id}-${job.timestamp}`,
  });
  console.info(`[email] job ${job.id} sent salary slip to ${maskEmail(delivery.email)}`);
}

async function sendLoanNoc(job: Job<LoanNocWhatsAppJob>) {
  const loaded = await loadLoanNoc(job.data.organizationId, job.data.recoverableId);
  if (!loaded.ok) throw new Error(loaded.message ?? "Loan NOC is no longer available");
  const { noc, email } = loaded.data;
  if (!email) throw new Error("Employee no longer has a linked Google email");
  await sendPdfEmail({
    to: email,
    subject: `Your no objection certificate ${noc.reference} - ${noc.organizationName}`,
    react: LoanNocEmail({
      employeeName: noc.employeeName,
      organizationName: noc.organizationName,
      kind: noc.type === "loan" ? "loan" : "salary advance",
      amount: money(noc.currencyCode, noc.principalAmount),
      reference: noc.reference,
    }),
    filename: `${noc.reference}.pdf`,
    pdf: await buildLoanNocPdf(noc),
    idempotencyKey: `loan-noc-email/${job.data.recoverableId}/${job.id}-${job.timestamp}`,
  });
  console.info(`[email] job ${job.id} sent loan NOC to ${maskEmail(email)}`);
}

export function createEmailWorker() {
  return new Worker<SalarySlipWhatsAppJob | LoanNocWhatsAppJob>(
    queueNames.email,
    async (job) => {
      if (job.name === "sendSalarySlip") return sendSalarySlip(job as Job<SalarySlipWhatsAppJob>);
      if (job.name === "sendLoanNoc") return sendLoanNoc(job as Job<LoanNocWhatsAppJob>);
      throw new Error(`Unsupported email queue job: ${job.name}`);
    },
    { connection: getQueueConnection(), concurrency: 5 },
  );
}
