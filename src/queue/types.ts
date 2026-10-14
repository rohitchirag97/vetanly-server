export type SalarySlipWhatsAppJob = {
  organizationId: string;
  itemId: string;
  requestedByUserId: string;
};

export type LoanNocWhatsAppJob = {
  organizationId: string;
  recoverableId: string;
  requestedByUserId: string;
};

export type PlatformInvoiceWhatsAppJob = {
  invoiceId: string;
  requestedByUserId: string;
};

export type AttendanceJob = {
  organizationId: string;
  userOrganizationId: string;
  source: "kiosk" | "manual" | "regularization";
  kioskId?: string;
  eventType: "check_in" | "check_out";
  externalEventId?: string;
  occurredAt: string;
  faceMatchScore?: number;
  livenessPassed?: boolean;
  faceTemplateId?: string;
};
