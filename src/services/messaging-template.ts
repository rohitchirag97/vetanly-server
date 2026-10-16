import type { MessageType } from "@/drizzle/schema";

/**
 * Pure helpers for messaging: the variables each Vetanly message offers to a provider template,
 * filling {{placeholders}} in a custom provider's request, and reading values out of its JSON.
 */

/** Variables each message type provides, in their default template order. */
export const MESSAGE_VARIABLES: Record<MessageType, { key: string; label: string; example: string }[]> = {
  salary_slip: [
    { key: "employee_name", label: "Employee name", example: "Asha Patel" },
    { key: "organization_name", label: "Organization", example: "Asha Corporation" },
    { key: "period", label: "Pay period", example: "2026-09-01 to 2026-09-30" },
    { key: "gross_pay", label: "Gross pay", example: "INR 45000.00" },
    { key: "deductions", label: "Deductions", example: "INR 3800.00" },
    { key: "net_pay", label: "Net pay", example: "INR 41200.00" },
  ],
  loan_noc: [
    { key: "employee_name", label: "Employee name", example: "Asha Patel" },
    { key: "organization_name", label: "Organization", example: "Asha Corporation" },
    { key: "kind", label: "Loan or salary advance", example: "loan" },
    { key: "amount", label: "Amount", example: "INR 50000.00" },
    { key: "reference", label: "NOC reference", example: "NOC-2026-0012" },
  ],
  test: [
    { key: "recipient_name", label: "Recipient name", example: "Asha Patel" },
    { key: "organization_name", label: "Organization", example: "Asha Corporation" },
  ],
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  salary_slip: "Salary slip",
  loan_noc: "Loan NOC",
  test: "Test message",
};

/** Message types with a PDF attached. */
export const HAS_DOCUMENT: Record<MessageType, boolean> = { salary_slip: true, loan_noc: true, test: false };

export type RenderContext = {
  phone: string; // digits with country code, no "+"
  recipientName: string;
  template: string;
  language: string;
  params: string[];
  documentUrl: string | null;
  documentFilename: string | null;
  reference: string; // Vetanly's message id, for the provider's idempotency
  secrets: Record<string, string>;
};

/** Every placeholder a custom provider can use, for the setup screen. */
export const PLACEHOLDERS: { name: string; description: string }[] = [
  { name: "{{phone}}", description: "Recipient number with country code, digits only (919876543210)" },
  { name: "{{phone_plus}}", description: "Recipient number with a leading + (+919876543210)" },
  { name: "{{recipient_name}}", description: "Recipient's name" },
  { name: "{{template}}", description: "Template or campaign name from the template mapping" },
  { name: "{{language}}", description: "Template language code" },
  { name: "{{param1}} … {{param9}}", description: "Template variables in the mapped order" },
  { name: "{{params_json}}", description: "All template variables as a JSON array; use without quotes" },
  { name: "{{document_url}}", description: "Link to the PDF (empty for a test message)" },
  { name: "{{document_filename}}", description: "PDF file name" },
  { name: "{{reference}}", description: "Vetanly's id for this message, for idempotency" },
  { name: "{{secret.NAME}}", description: "A saved secret, e.g. {{secret.apiKey}}" },
];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const valueOf = (name: string, ctx: RenderContext): string | null => {
  if (name.startsWith("secret.")) return ctx.secrets[name.slice(7)] ?? null;
  const param = /^param(\d+)$/.exec(name);
  if (param) return ctx.params[Number(param[1]) - 1] ?? "";
  switch (name) {
    case "phone":
      return ctx.phone;
    case "phone_plus":
      return `+${ctx.phone}`;
    case "recipient_name":
      return ctx.recipientName;
    case "template":
      return ctx.template;
    case "language":
      return ctx.language;
    case "document_url":
      return ctx.documentUrl ?? "";
    case "document_filename":
      return ctx.documentFilename ?? "";
    case "reference":
      return ctx.reference;
    default:
      return null;
  }
};

/** Placeholders in a template that are not known (typos, or secrets not saved). */
export const unknownPlaceholders = (text: string, secretNames: string[]) =>
  [...text.matchAll(PLACEHOLDER)]
    .map((match) => match[1]!)
    .filter((name) => {
      if (name === "params_json") return false;
      if (name.startsWith("secret.")) return !secretNames.includes(name.slice(7));
      return valueOf(name, { phone: "", recipientName: "", template: "", language: "", params: [], documentUrl: null, documentFilename: null, reference: "", secrets: {} }) === null;
    });

/** Fills a header or URL: plain text. */
export const renderText = (text: string, ctx: RenderContext) =>
  text.replace(PLACEHOLDER, (_, name: string) => (name === "params_json" ? JSON.stringify(ctx.params) : (valueOf(name, ctx) ?? "")));

/**
 * Fills a JSON body. Values are escaped for use inside JSON strings ("{{phone}}"), so a name with a
 * quote cannot break the request; {{params_json}} is inserted as a raw array. The result must parse.
 */
export const renderJsonBody = (template: string, ctx: RenderContext) => {
  const filled = template.replace(PLACEHOLDER, (_, name: string) =>
    name === "params_json" ? JSON.stringify(ctx.params) : JSON.stringify(valueOf(name, ctx) ?? "").slice(1, -1),
  );
  return JSON.parse(filled) as unknown;
};

/** Reads "a.b.0.c" from parsed JSON. */
export const readPath = (value: unknown, path: string): unknown => {
  let current: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(part) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
};

export type MappedStatus = "sent" | "delivered" | "read" | "failed";

/** A provider's status word mapped to ours, ignoring case; null if unknown. */
export const mapStatus = (raw: unknown, statusMap: Partial<Record<MappedStatus, string[]>>): MappedStatus | null => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  for (const status of ["failed", "read", "delivered", "sent"] as MappedStatus[]) {
    if ((statusMap[status] ?? []).some((word) => word.trim().toLowerCase() === value)) return status;
  }
  return null;
};

const RANK: Record<string, number> = { queued: 0, simulated: 0, sent: 1, delivered: 2, read: 3 };

/** Statuses only move forward (a late "sent" after "read" is ignored); failure is final unless already read. */
export const nextStatus = (current: string, incoming: MappedStatus) => {
  if (current === "failed") return null;
  if (incoming === "failed") return current === "read" ? null : "failed";
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : null;
};

/** Phone in display form with the middle hidden. */
export const maskPhone = (digits: string) => `+${digits.slice(0, 4)}${"•".repeat(Math.max(digits.length - 6, 0))}${digits.slice(-2)}`;
export const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, "$1•••$2");
