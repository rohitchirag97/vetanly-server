import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export enum UserRole {
  SUPER_ADMIN = "super_admin",
  ADMIN = "admin",
  HR = "hr",
  EMPLOYEE = "employee",
}

export type EmploymentType =
  | "full_time"
  | "part_time"
  | "contractor"
  | "intern";

// deleted: data was erased after a scheduled deletion; the row stays only because GST invoices must be kept.
export type PlatformOrganizationStatus = "active" | "suspended" | "pending_deletion" | "deleted";

export type CompensationType = "hourly" | "daily" | "fixed_salary";

export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

export type OvertimeCalculationMethod =
  | "fixed_per_hour"
  | "hourly_rate_multiplier"
  | "equivalent_days";

export type LateFineMethod = "none" | "fixed_per_occurrence" | "per_minute";

export type AttendanceEventType = "check_in" | "check_out";

export type AttendanceSource = "kiosk" | "manual" | "regularization";

export type FaceVerificationStatus = "verified" | "not_applicable" | "failed";

export type EmployeeRecoverableType = "loan" | "salary_advance";

export type RecoverableStatus =
  | "pending"
  | "approved"
  | "disbursed"
  | "active"
  | "completed"
  | "rejected"
  | "cancelled";

export type RecoverableRepaymentSource = "payroll" | "manual" | "employee";
export type RepaymentStatus = "pending" | "confirmed" | "rejected";

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  fname: varchar("fname", { length: 52 }).notNull(),
  lname: varchar("lname", { length: 52 }).notNull(),
  phone: varchar("phone", { length: 15 }).unique().notNull(),
  email: varchar("email", { length: 254 }).unique(),
  // Phone is verified by OTP login, email by Google sign-in.
  phoneVerified: boolean("phone_verified").notNull().default(false),
  emailVerified: boolean("email_verified").notNull().default(false),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
});

// One row per user: the single session allowed to use the API. Logging in elsewhere replaces it.
export const userSessionsTable = pgTable("user_sessions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  userAgent: varchar("user_agent", { length: 300 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationsTable = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 40 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    body: varchar("body", { length: 500 }),
    link: varchar("link", { length: 200 }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_user_org_created_idx").on(table.userId, table.organizationId, table.createdAt),
  ],
);

// Append-only: database triggers reject UPDATE, DELETE and TRUNCATE (see the audit_logs migration).
// No foreign keys on purpose, so deleting a user or organization can never cascade into the log.
export const auditLogsTable = pgTable(
  "audit_logs",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid("id").notNull().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id"),
    userName: varchar("user_name", { length: 255 }),
    role: varchar("role", { length: 30 }),
    method: varchar("method", { length: 10 }).notNull(),
    path: varchar("path", { length: 500 }).notNull(),
    action: varchar("action", { length: 200 }).notNull(),
    summary: varchar("summary", { length: 1000 }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    statusCode: integer("status_code").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 300 }),
    prevHash: varchar("prev_hash", { length: 64 }).notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_logs_id_unique").on(table.id),
    index("audit_logs_org_seq_idx").on(table.organizationId, table.seq),
  ],
);

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 52 }).notNull(),
  slug: varchar("slug", { length: 52 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  status: varchar("status", { length: 24 })
    .$type<PlatformOrganizationStatus>()
    .notNull()
    .default("active"),
  suspendedReason: varchar("suspended_reason", { length: 500 }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  // Existing organizations predate platform reporting, so their creation date stays unknown.
  createdAt: timestamp("created_at", { withTimezone: true }),
  // Empty until the owner starts the 14-day free trial; the workspace stays locked until then.
  // See services/billing-access.services.ts for every access state.
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  // Set when the owner asks to upgrade; cleared once a paid period is recorded.
  upgradeRequestedAt: timestamp("upgrade_requested_at", { withTimezone: true }),
  // Set when the owner pauses the organization (is_active false); cleared when they reactivate it.
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  // With status pending_deletion: when the purge job erases the organization. The owner can cancel until then.
  deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
});

export const platformNotesTable = pgTable(
  "platform_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    authorUserId: uuid("author_user_id").notNull(),
    authorName: varchar("author_name", { length: 110 }).notNull(),
    text: varchar("text", { length: 2000 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_notes_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

// Kept independent of customer rows so the platform history survives later account purges.
export const platformAuditLogsTable = pgTable(
  "platform_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorName: varchar("actor_name", { length: 110 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    targetOrganizationId: uuid("target_organization_id"),
    targetOrganizationName: varchar("target_organization_name", { length: 52 }),
    targetUserId: uuid("target_user_id"),
    reason: varchar("reason", { length: 500 }),
    beforeValues: jsonb("before_values").$type<Record<string, unknown>>(),
    afterValues: jsonb("after_values").$type<Record<string, unknown>>(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 300 }),
    prevHash: varchar("prev_hash", { length: 64 }).notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_audit_logs_created_idx").on(table.createdAt),
    index("platform_audit_logs_org_created_idx").on(
      table.targetOrganizationId,
      table.createdAt,
    ),
  ],
);

export type PlatformBillingPeriod = "monthly" | "annual";
// public: listed on every owner's Billing page. custom: only for organizations it is offered to.
export type PlatformPlanVisibility = "public" | "custom";
export type PlatformSubscriptionStatus = "active" | "trial" | "past_due" | "cancelled";
export type PlatformInvoiceStatus = "open" | "paid" | "void";
export type PlatformInvoiceWhatsAppStatus = "not_sent" | "queued" | "sent" | "failed";

export const platformPlansTable = pgTable(
  "platform_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }),
    currencyCode: varchar("currency_code", { length: 3 }).notNull().default("INR"),
    priceAmount: numeric("price_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    billingPeriod: varchar("billing_period", { length: 16 }).$type<PlatformBillingPeriod>().notNull().default("monthly"),
    includedEmployees: integer("included_employees").notNull().default(0),
    overagePrice: numeric("overage_price", { precision: 12, scale: 2 }).notNull().default("0"),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    visibility: varchar("visibility", { length: 16 }).$type<PlatformPlanVisibility>().notNull().default("public"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("platform_plans_name_unique").on(table.name)],
);

/** Custom plans offered to one organization; its owner sees them on the Billing page. */
export const platformPlanOffersTable = pgTable(
  "platform_plan_offers",
  {
    planId: uuid("plan_id").notNull().references(() => platformPlansTable.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.organizationId] }),
    index("platform_plan_offers_org_idx").on(table.organizationId),
  ],
);

export const platformBillingProfilesTable = pgTable("platform_billing_profiles", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  legalName: varchar("legal_name", { length: 160 }).notNull(),
  gstin: varchar("gstin", { length: 15 }),
  addressLine1: varchar("address_line1", { length: 200 }).notNull(),
  addressLine2: varchar("address_line2", { length: 200 }),
  city: varchar("city", { length: 100 }).notNull(),
  state: varchar("state", { length: 100 }).notNull(),
  postalCode: varchar("postal_code", { length: 20 }).notNull(),
  country: varchar("country", { length: 100 }).notNull().default("India"),
  email: varchar("email", { length: 254 }),
  whatsappPhone: varchar("whatsapp_phone", { length: 20 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformSubscriptionsTable = pgTable(
  "platform_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull().references(() => platformPlansTable.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).$type<PlatformSubscriptionStatus>().notNull().default("active"),
    startsAt: date("starts_at", { mode: "string" }).notNull().defaultNow(),
    nextBillingAt: date("next_billing_at", { mode: "string" }),
    // Last day the organization has paid for, inclusive. Access stays full through this date.
    paidUntil: date("paid_until", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("platform_subscriptions_org_unique").on(table.organizationId)],
);

export const platformInvoicesTable = pgTable(
  "platform_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNumber: varchar("invoice_number", { length: 40 }).notNull(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).$type<PlatformInvoiceStatus>().notNull().default("open"),
    currencyCode: varchar("currency_code", { length: 3 }).notNull().default("INR"),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("18"),
    taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull(),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
    billTo: jsonb("bill_to").$type<Record<string, string | null>>().notNull(),
    notes: varchar("notes", { length: 1000 }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueDate: date("due_date", { mode: "string" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentMethod: varchar("payment_method", { length: 30 }),
    paymentReference: varchar("payment_reference", { length: 120 }),
    whatsappStatus: varchar("whatsapp_status", { length: 16 }).$type<PlatformInvoiceWhatsAppStatus>().notNull().default("not_sent"),
    whatsappDestination: varchar("whatsapp_destination", { length: 20 }),
    whatsappSentAt: timestamp("whatsapp_sent_at", { withTimezone: true }),
    whatsappError: varchar("whatsapp_error", { length: 500 }),
    pdfStorageKey: varchar("pdf_storage_key", { length: 300 }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("platform_invoices_number_unique").on(table.invoiceNumber),
    index("platform_invoices_org_created_idx").on(table.organizationId, table.createdAt),
    index("platform_invoices_status_due_idx").on(table.status, table.dueDate),
  ],
);

export const platformInvoiceItemsTable = pgTable(
  "platform_invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id").notNull().references(() => platformInvoicesTable.id, { onDelete: "cascade" }),
    description: varchar("description", { length: 240 }).notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    lineSubtotal: numeric("line_subtotal", { precision: 12, scale: 2 }).notNull(),
    lineTax: numeric("line_tax", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
  },
  (table) => [index("platform_invoice_items_invoice_idx").on(table.invoiceId)],
);

export const organizationPayrollSettingsTable = pgTable(
  "organization_payroll_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    overtimeCalculationMethod: varchar("overtime_calculation_method", {
      length: 32,
    })
      .$type<OvertimeCalculationMethod>()
      .notNull()
      .default("hourly_rate_multiplier"),
    overtimeFixedAmountPerHour: numeric("overtime_fixed_amount_per_hour", {
      precision: 12,
      scale: 2,
    }),
    overtimeHourlyRateMultiplier: numeric("overtime_hourly_rate_multiplier", {
      precision: 6,
      scale: 3,
    })
      .notNull()
      .default("1.5"),
    overtimeHoursPerWorkday: numeric("overtime_hours_per_workday", {
      precision: 5,
      scale: 2,
    }),
    salaryDaysPerMonth: numeric("salary_days_per_month", {
      precision: 5,
      scale: 2,
    }),
    lateFineMethod: varchar("late_fine_method", { length: 24 })
      .$type<LateFineMethod>()
      .notNull()
      .default("none"),
    lateFineAmount: numeric("late_fine_amount", {
      precision: 12,
      scale: 2,
    }),
    lateFineCapPerPayPeriod: numeric("late_fine_cap_per_pay_period", {
      precision: 12,
      scale: 2,
    }),
    weeklyOffDays: varchar("weekly_off_days", { length: 20 }).notNull().default("0"),
    autoDeductLoans: boolean("auto_deduct_loans").notNull().default(false),
    paidHolidays: boolean("paid_holidays").notNull().default(false),
    overtimeApprovalRequired: boolean("overtime_approval_required").notNull().default(false),
    fullDayThresholdPercent: numeric("full_day_threshold_percent", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("90"),
    halfDayThresholdPercent: numeric("half_day_threshold_percent", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("50"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_payroll_settings_org_unique").on(
      table.organizationId,
    ),
  ],
);

export const departmentsTable = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: varchar("name", { length: 100 }).notNull(),
    code: varchar("code", { length: 32 }),
    description: varchar("description", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("departments_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("departments_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
    uniqueIndex("departments_org_code_unique").on(
      table.organizationId,
      table.code,
    ),
  ],
);

export const shiftsTable = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: varchar("name", { length: 100 }).notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    gracePeriodMinutes: integer("grace_period_minutes").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("shifts_org_id_id_unique").on(table.organizationId, table.id),
    uniqueIndex("shifts_org_name_unique").on(table.organizationId, table.name),
  ],
);

/**
 * Shift rotation (see services/roster.services.ts). The shift an employee works on a date is, in order:
 * a roster override for that day, else their rotation pattern, else their default shift.
 */

/** One step of a rotation: a shift (or a day off when shiftId is null) repeated for some days. */
export type ShiftRotationStep = { shiftId: string | null; days: number };

export const shiftRotationsTable = pgTable(
  "shift_rotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: varchar("name", { length: 100 }).notNull(),
    // The steps in order; the cycle repeats after the last one.
    pattern: jsonb("pattern").$type<ShiftRotationStep[]>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("shift_rotations_org_name_unique").on(table.organizationId, table.name)],
);

/** Puts an employee on a rotation from a date. Ranges for one employee never overlap. */
export const shiftRotationAssignmentsTable = pgTable(
  "shift_rotation_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    rotationId: uuid("rotation_id")
      .notNull()
      .references(() => shiftRotationsTable.id, { onDelete: "cascade" }),
    userOrganizationId: uuid("user_organization_id").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    // Last day on this rotation, inclusive; null while it continues.
    endsOn: date("ends_on", { mode: "string" }),
    // Which day of the cycle startsOn falls on (0-based), so crews can be staggered.
    cycleOffset: integer("cycle_offset").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "shift_rotation_assignments_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    index("shift_rotation_assignments_employee_idx").on(table.userOrganizationId, table.startsOn),
  ],
);

/** A single day's shift set by hand or by an approved swap; shiftId null means a day off. */
export const shiftRosterOverridesTable = pgTable(
  "shift_roster_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    shiftId: uuid("shift_id"),
    source: varchar("source", { length: 8 }).$type<"manual" | "swap">().notNull().default("manual"),
    note: varchar("note", { length: 200 }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "shift_roster_overrides_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    uniqueIndex("shift_roster_overrides_employee_date_unique").on(table.userOrganizationId, table.date),
    index("shift_roster_overrides_org_date_idx").on(table.organizationId, table.date),
  ],
);

// The colleague accepts first, then a manager approves; either can turn it down.
export type ShiftSwapStatus = "awaiting_colleague" | "awaiting_manager" | "approved" | "rejected" | "cancelled";

/** Two employees exchange their shifts on one date. */
export const shiftSwapRequestsTable = pgTable(
  "shift_swap_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    requesterMembershipId: uuid("requester_membership_id").notNull(),
    colleagueMembershipId: uuid("colleague_membership_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    reason: varchar("reason", { length: 300 }),
    status: varchar("status", { length: 20 }).$type<ShiftSwapStatus>().notNull().default("awaiting_colleague"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewNote: varchar("review_note", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "shift_swap_requests_requester_org_fk",
      columns: [table.organizationId, table.requesterMembershipId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    foreignKey({
      name: "shift_swap_requests_colleague_org_fk",
      columns: [table.organizationId, table.colleagueMembershipId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    index("shift_swap_requests_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const holidaysTable = pgTable(
  "holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    date: date("date").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
  },
  (table) => [
    uniqueIndex("holidays_org_date_unique").on(table.organizationId, table.date),
  ],
);

export const userOrganizationsTable = pgTable(
  "user_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    role: varchar("role", { length: 52 }).notNull().default(UserRole.EMPLOYEE),
    isActive: boolean("is_active").notNull().default(true),
    includeInPayroll: boolean("include_in_payroll").notNull().default(false),
    deactivationReason: varchar("deactivation_reason", { length: 500 }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedByUserId: uuid("deactivated_by_user_id"),
    employeeCode: varchar("employee_code", { length: 32 }),
    jobTitle: varchar("job_title", { length: 100 }),
    departmentId: uuid("department_id"),
    shiftId: uuid("shift_id"),
    employmentType: varchar("employment_type", {
      length: 24,
    }).$type<EmploymentType>(),
    hireDate: date("hire_date"),
    compensationType: varchar("compensation_type", {
      length: 16,
    }).$type<CompensationType>(),
    compensationAmount: numeric("compensation_amount", {
      precision: 12,
      scale: 2,
    }),
    compensationCurrency: varchar("compensation_currency", { length: 3 }),
    payFrequency: varchar("pay_frequency", {
      length: 16,
    }).$type<PayFrequency>(),
    salaryComponents: jsonb("salary_components")
      .$type<SalaryComponent[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    foreignKey({
      name: "user_organizations_department_org_fk",
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [departmentsTable.organizationId, departmentsTable.id],
    }),
    foreignKey({
      name: "user_organizations_shift_org_fk",
      columns: [table.organizationId, table.shiftId],
      foreignColumns: [shiftsTable.organizationId, shiftsTable.id],
    }),
    uniqueIndex("user_organizations_org_employee_code_unique").on(
      table.organizationId,
      table.employeeCode,
    ),
    uniqueIndex("user_organizations_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export type EmployeeDocumentType =
  | "id_proof"
  | "address_proof"
  | "contract"
  | "offer_letter"
  | "certificate"
  | "other";

export type LifecycleKind = "onboarding" | "offboarding";
export type ExitType = "resignation" | "termination" | "retirement" | "other";
export type ExitStatus = "notice" | "completed" | "cancelled";

export const employeeProfilesTable = pgTable(
  "employee_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    dateOfBirth: date("date_of_birth"),
    addressLine1: varchar("address_line1", { length: 200 }),
    addressLine2: varchar("address_line2", { length: 200 }),
    city: varchar("city", { length: 100 }),
    state: varchar("state", { length: 100 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 100 }),
    emergencyContactName: varchar("emergency_contact_name", { length: 100 }),
    emergencyContactRelation: varchar("emergency_contact_relation", { length: 50 }),
    emergencyContactPhone: varchar("emergency_contact_phone", { length: 20 }),
    bankAccountHolder: varchar("bank_account_holder", { length: 100 }),
    bankName: varchar("bank_name", { length: 100 }),
    bankAccountNumber: varchar("bank_account_number", { length: 200 }),
    bankAccountLast4: varchar("bank_account_last4", { length: 4 }),
    bankIfsc: varchar("bank_ifsc", { length: 20 }),
    upiId: varchar("upi_id", { length: 100 }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (table) => [
    uniqueIndex("employee_profiles_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const employeeDocumentsTable = pgTable(
  "employee_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    docType: varchar("doc_type", { length: 24 })
      .$type<EmployeeDocumentType>()
      .notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    storageKey: varchar("storage_key", { length: 300 }).notNull(),
    contentType: varchar("content_type", { length: 50 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("employee_documents_org_user_idx").on(table.organizationId, table.userId),
  ],
);

export const employeeLifecycleTasksTable = pgTable(
  "employee_lifecycle_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    kind: varchar("kind", { length: 12 }).$type<LifecycleKind>().notNull(),
    title: varchar("title", { length: 150 }).notNull(),
    isDone: boolean("is_done").notNull().default(false),
    doneAt: timestamp("done_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("employee_lifecycle_tasks_org_user_idx").on(
      table.organizationId,
      table.userId,
      table.kind,
    ),
  ],
);

export const employeeExitsTable = pgTable(
  "employee_exits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    exitType: varchar("exit_type", { length: 16 }).$type<ExitType>().notNull(),
    status: varchar("status", { length: 12 }).$type<ExitStatus>().notNull(),
    resignationDate: date("resignation_date").notNull(),
    noticeDays: integer("notice_days").notNull().default(0),
    lastWorkingDay: date("last_working_day").notNull(),
    reason: varchar("reason", { length: 500 }),
    notes: varchar("notes", { length: 1000 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    uniqueIndex("employee_exits_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const kioskDevicesTable = pgTable(
  "kiosk_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    deviceIdentifier: varchar("device_identifier", { length: 100 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    locationName: varchar("location_name", { length: 100 }),
    apiKeyHash: varchar("api_key_hash", { length: 64 }),
    appVersion: varchar("app_version", { length: 32 }),
    faceModelName: varchar("face_model_name", { length: 64 }),
    faceModelVersion: varchar("face_model_version", { length: 32 }),
    faceMatchThreshold: numeric("face_match_threshold", {
      precision: 5,
      scale: 4,
    }),
    requireLiveness: boolean("require_liveness").notNull().default(false),
    lastTemplateSyncAt: timestamp("last_template_sync_at", {
      withTimezone: true,
    }),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("kiosk_devices_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("kiosk_devices_org_identifier_unique").on(
      table.organizationId,
      table.deviceIdentifier,
    ),
  ],
);

export const employeeFaceTemplatesTable = pgTable(
  "employee_face_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull(),
    embeddingDimension: integer("embedding_dimension").notNull(),
    modelName: varchar("model_name", { length: 64 }).notNull(),
    modelVersion: varchar("model_version", { length: 32 }).notNull(),
    qualityScore: numeric("quality_score", { precision: 5, scale: 4 }),
    enrolledByKioskId: uuid("enrolled_by_kiosk_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "face_templates_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [
        userOrganizationsTable.organizationId,
        userOrganizationsTable.id,
      ],
    }),
    foreignKey({
      name: "face_templates_kiosk_org_fk",
      columns: [table.organizationId, table.enrolledByKioskId],
      foreignColumns: [kioskDevicesTable.organizationId, kioskDevicesTable.id],
    }),
    index("face_templates_org_active_updated_idx").on(
      table.organizationId,
      table.isActive,
      table.updatedAt,
    ),
    index("face_templates_employee_idx").on(table.userOrganizationId),
  ],
);

export const attendanceLogsTable = pgTable(
  "attendance_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    kioskId: uuid("kiosk_id"),
    eventType: varchar("event_type", { length: 16 })
      .$type<AttendanceEventType>()
      .notNull(),
    source: varchar("source", { length: 16 })
      .$type<AttendanceSource>()
      .notNull()
      .default("kiosk"),
    faceVerificationStatus: varchar("face_verification_status", { length: 24 })
      .$type<FaceVerificationStatus>()
      .notNull()
      .default("not_applicable"),
    externalEventId: varchar("external_event_id", { length: 100 }),
    faceMatchScore: numeric("face_match_score", { precision: 5, scale: 4 }),
    livenessPassed: boolean("liveness_passed"),
    faceTemplateId: uuid("face_template_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "attendance_logs_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [
        userOrganizationsTable.organizationId,
        userOrganizationsTable.id,
      ],
    }),
    foreignKey({
      name: "attendance_logs_kiosk_org_fk",
      columns: [table.organizationId, table.kioskId],
      foreignColumns: [kioskDevicesTable.organizationId, kioskDevicesTable.id],
    }),
    uniqueIndex("attendance_logs_kiosk_external_event_unique").on(
      table.kioskId,
      table.externalEventId,
    ),
    index("attendance_logs_org_employee_occurred_idx").on(
      table.organizationId,
      table.userOrganizationId,
      table.occurredAt,
    ),
    index("attendance_logs_org_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export type RegularizationStatus = "pending" | "approved" | "rejected" | "cancelled";

export const announcementsTable = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 160 }).notNull(),
    body: varchar("body", { length: 2000 }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("announcements_org_created_idx").on(table.organizationId, table.createdAt)],
);

export const overtimeApprovalsTable = pgTable(
  "overtime_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    date: date("date").notNull(),
    status: varchar("status", { length: 10 }).$type<"approved" | "rejected">().notNull(),
    approvedMinutes: integer("approved_minutes").notNull().default(0),
    note: varchar("note", { length: 300 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "overtime_approvals_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    uniqueIndex("overtime_approvals_employee_date_unique").on(table.userOrganizationId, table.date),
  ],
);

export const attendanceRegularizationsTable = pgTable(
  "attendance_regularizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    date: date("date").notNull(),
    requestedCheckIn: timestamp("requested_check_in", { withTimezone: true }),
    requestedCheckOut: timestamp("requested_check_out", { withTimezone: true }),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<RegularizationStatus>()
      .notNull()
      .default("pending"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: varchar("review_note", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "attendance_regularizations_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    index("attendance_regularizations_org_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("attendance_regularizations_employee_date_idx").on(
      table.userOrganizationId,
      table.date,
    ),
  ],
);

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export const leaveTypesTable = pgTable(
  "leave_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: varchar("name", { length: 100 }).notNull(),
    isPaid: boolean("is_paid").notNull().default(true),
    annualAllowanceDays: numeric("annual_allowance_days", {
      precision: 5,
      scale: 1,
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("leave_types_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("leave_types_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export const leaveRequestsTable = pgTable(
  "leave_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    isHalfDay: boolean("is_half_day").notNull().default(false),
    days: numeric("days", { precision: 5, scale: 1 }).notNull(),
    reason: varchar("reason", { length: 500 }),
    status: varchar("status", { length: 16 })
      .$type<LeaveStatus>()
      .notNull()
      .default("pending"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(
      () => usersTable.id,
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: varchar("review_note", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "leave_requests_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [
        userOrganizationsTable.organizationId,
        userOrganizationsTable.id,
      ],
    }),
    foreignKey({
      name: "leave_requests_type_org_fk",
      columns: [table.organizationId, table.leaveTypeId],
      foreignColumns: [leaveTypesTable.organizationId, leaveTypesTable.id],
    }),
    index("leave_requests_org_employee_status_idx").on(
      table.organizationId,
      table.userOrganizationId,
      table.status,
    ),
    index("leave_requests_org_dates_idx").on(
      table.organizationId,
      table.startDate,
    ),
  ],
);

export const employeeRecoverablesTable = pgTable(
  "employee_recoverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    type: varchar("type", { length: 24 })
      .$type<EmployeeRecoverableType>()
      .notNull(),
    status: varchar("status", { length: 24 })
      .$type<RecoverableStatus>()
      .notNull()
      .default("pending"),
    principalAmount: numeric("principal_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    annualInterestRate: numeric("annual_interest_rate", {
      precision: 7,
      scale: 4,
    })
      .notNull()
      .default("0"),
    installmentCount: integer("installment_count"),
    installmentAmount: numeric("installment_amount", {
      precision: 12,
      scale: 2,
    }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
    firstRepaymentDate: date("first_repayment_date"),
    description: varchar("description", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "employee_recoverables_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [
        userOrganizationsTable.organizationId,
        userOrganizationsTable.id,
      ],
    }),
    uniqueIndex("employee_recoverables_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("employee_recoverables_org_employee_status_idx").on(
      table.organizationId,
      table.userOrganizationId,
      table.status,
    ),
  ],
);

export const employeeRecoverableRepaymentsTable = pgTable(
  "employee_recoverable_repayments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    recoverableId: uuid("recoverable_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    source: varchar("source", { length: 16 })
      .$type<RecoverableRepaymentSource>()
      .notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payrollPeriodStart: date("payroll_period_start"),
    payrollPeriodEnd: date("payroll_period_end"),
    reference: varchar("reference", { length: 100 }),
    notes: varchar("notes", { length: 500 }),
    status: varchar("status", { length: 16 })
      .$type<RepaymentStatus>()
      .notNull()
      .default("confirmed"),
    paymentMethod: varchar("payment_method", { length: 20 }),
    submittedByUserId: uuid("submitted_by_user_id").references(() => usersTable.id),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: varchar("review_note", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "employee_recoverable_repayments_recoverable_org_fk",
      columns: [table.organizationId, table.recoverableId],
      foreignColumns: [
        employeeRecoverablesTable.organizationId,
        employeeRecoverablesTable.id,
      ],
    }),
    index("employee_recoverable_repayments_org_recoverable_paid_idx").on(
      table.organizationId,
      table.recoverableId,
      table.paidAt,
    ),
  ],
);

export type PayrollRunStatus = "draft" | "finalized";

export type PayrollLoanLine = {
  recoverableId: string;
  label: string;
  amount: string;
};

export type PayrollReimbursementLine = {
  claimId: string;
  label: string;
  amount: string;
};

export type ExpenseCategory =
  | "travel"
  | "fuel"
  | "food"
  | "accommodation"
  | "phone_internet"
  | "office_supplies"
  | "client_meeting"
  | "medical"
  | "other";
// pending -> approved -> paid; or pending -> rejected / cancelled (by the employee).
export type ExpenseClaimStatus = "pending" | "approved" | "rejected" | "cancelled" | "paid";

/**
 * Money an employee spent for work and claims back. Approved claims are reimbursed in the next
 * payroll run as a separate line outside gross pay (no PF, ESI or TDS), or marked paid outside payroll.
 */
export const expenseClaimsTable = pgTable(
  "expense_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    category: varchar("category", { length: 24 }).$type<ExpenseCategory>().notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    status: varchar("status", { length: 16 }).$type<ExpenseClaimStatus>().notNull().default("pending"),
    receiptStorageKey: varchar("receipt_storage_key", { length: 300 }),
    receiptName: varchar("receipt_name", { length: 150 }),
    receiptContentType: varchar("receipt_content_type", { length: 100 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: varchar("review_note", { length: 500 }),
    // Set when a finalized payroll run reimbursed the claim; null when it was paid outside payroll.
    payrollRunId: uuid("payroll_run_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentNote: varchar("payment_note", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "expense_claims_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    index("expense_claims_org_status_idx").on(table.organizationId, table.status),
    index("expense_claims_org_employee_idx").on(table.organizationId, table.userOrganizationId),
  ],
);

export type SalaryComponentKind = "earning" | "deduction";
export type SalaryComponentCalc = "fixed" | "percent_basic";

/** An allowance (HRA, DA, TA...) or deduction (PF, ESI, professional tax...) set per employee. */
export type SalaryComponent = {
  name: string;
  kind: SalaryComponentKind;
  calc: SalaryComponentCalc;
  value: number;
};

export type PayrollComponentLine = {
  name: string;
  kind: SalaryComponentKind;
  amount: string;
};

/** Statutory amounts for one employee and one payroll run, in rupees. */
export type StatutoryBreakup = {
  pfWages: number;
  pfEmployee: number;
  pfEps: number;
  pfEpfDiff: number;
  pfAdmin: number;
  pfEdli: number;
  epsWages: number;
  esiWages: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  tds: number;
  taxRegime: TaxRegime;
};

export type TaxRegime = "new" | "old";

export const organizationStatutorySettingsTable = pgTable(
  "organization_statutory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    pfEnabled: boolean("pf_enabled").notNull().default(false),
    pfWageCeiling: numeric("pf_wage_ceiling", { precision: 12, scale: 2 }).notNull().default("15000"),
    pfCapWages: boolean("pf_cap_wages").notNull().default(true),
    pfEstablishmentCode: varchar("pf_establishment_code", { length: 32 }),
    esiEnabled: boolean("esi_enabled").notNull().default(false),
    esiWageCeiling: numeric("esi_wage_ceiling", { precision: 12, scale: 2 }).notNull().default("21000"),
    esiEstablishmentCode: varchar("esi_establishment_code", { length: 32 }),
    ptEnabled: boolean("pt_enabled").notNull().default(false),
    ptState: varchar("pt_state", { length: 8 }),
    ptFlatAmount: numeric("pt_flat_amount", { precision: 8, scale: 2 }),
    tdsEnabled: boolean("tds_enabled").notNull().default(false),
    tan: varchar("tan", { length: 10 }),
    employerPan: varchar("employer_pan", { length: 10 }),
    employerAddress: varchar("employer_address", { length: 300 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_statutory_settings_org_unique").on(table.organizationId),
  ],
);

export const employeeStatutoryProfilesTable = pgTable(
  "employee_statutory_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    uan: varchar("uan", { length: 12 }),
    esiNumber: varchar("esi_number", { length: 17 }),
    panEncrypted: varchar("pan_encrypted", { length: 200 }),
    gender: varchar("gender", { length: 10 }),
    pfApplicable: boolean("pf_applicable").notNull().default(true),
    esiApplicable: boolean("esi_applicable").notNull().default(true),
    taxRegime: varchar("tax_regime", { length: 4 }).$type<TaxRegime>().notNull().default("new"),
    declaredDeductions: numeric("declared_deductions", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "employee_statutory_profiles_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    uniqueIndex("employee_statutory_profiles_employee_unique").on(table.userOrganizationId),
  ],
);

/**
 * Income-tax declarations (see services/tax-declaration.services.ts). Each financial year an employee
 * picks a regime and declares investments by section; proofs are uploaded and reviewed line by line.
 * Monthly TDS uses declared amounts until the proof deadline, then verified amounts only.
 */
export type TaxDeclarationSection =
  | "80C"
  | "80CCD1B"
  | "80D_SELF"
  | "80D_PARENTS"
  | "HRA"
  | "24B"
  | "80E"
  | "80TTA"
  | "PREVIOUS_EMPLOYER";
export type TaxDeclarationItemStatus = "pending" | "accepted" | "rejected";

/** Window settings per organization and financial year; defaults apply when there is no row. */
export const taxDeclarationSettingsTable = pgTable(
  "tax_declaration_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    // Financial year label, e.g. "2026-27".
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    // Last day employees can add or change declarations; null keeps them open until the proof deadline.
    declarationClosesOn: date("declaration_closes_on", { mode: "string" }),
    // Last day to upload proofs. After it, only verified amounts reduce TDS.
    proofDeadline: date("proof_deadline", { mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("tax_declaration_settings_org_fy_unique").on(table.organizationId, table.financialYear)],
);

export const taxDeclarationsTable = pgTable(
  "tax_declarations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    taxRegime: varchar("tax_regime", { length: 4 }).$type<TaxRegime>().notNull().default("new"),
    // Raise the 80D limits from 25,000 to 50,000 for the employee and for parents aged 60 or more.
    seniorSelf: boolean("senior_self").notNull().default(false),
    seniorParents: boolean("senior_parents").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "tax_declarations_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    uniqueIndex("tax_declarations_employee_fy_unique").on(table.userOrganizationId, table.financialYear),
    index("tax_declarations_org_fy_idx").on(table.organizationId, table.financialYear),
  ],
);

export const taxDeclarationItemsTable = pgTable(
  "tax_declaration_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    declarationId: uuid("declaration_id")
      .notNull()
      .references(() => taxDeclarationsTable.id, { onDelete: "cascade" }),
    section: varchar("section", { length: 20 }).$type<TaxDeclarationSection>().notNull(),
    // What it is within the section, e.g. "ppf" or "lic" under 80C.
    kind: varchar("kind", { length: 40 }).notNull(),
    description: varchar("description", { length: 200 }),
    declaredAmount: numeric("declared_amount", { precision: 12, scale: 2 }).notNull(),
    // Section-specific facts: monthly rent and landlord for HRA, lender for home loans, TDS for a previous employer.
    details: jsonb("details").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    status: varchar("status", { length: 12 }).$type<TaxDeclarationItemStatus>().notNull().default("pending"),
    verifiedAmount: numeric("verified_amount", { precision: 12, scale: 2 }),
    reviewNote: varchar("review_note", { length: 500 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    proofStorageKey: varchar("proof_storage_key", { length: 300 }),
    proofName: varchar("proof_name", { length: 150 }),
    proofUploadedAt: timestamp("proof_uploaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tax_declaration_items_declaration_idx").on(table.declarationId)],
);

export const payrollRunsTable = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: varchar("status", { length: 16 })
      .$type<PayrollRunStatus>()
      .notNull()
      .default("draft"),
    utcOffsetMinutes: integer("utc_offset_minutes").notNull().default(0),
    generatedByUserId: uuid("generated_by_user_id").references(() => usersTable.id),
    finalizedByUserId: uuid("finalized_by_user_id").references(() => usersTable.id),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("payroll_runs_org_id_id_unique").on(table.organizationId, table.id),
    uniqueIndex("payroll_runs_org_period_unique").on(
      table.organizationId,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

export const payrollItemsTable = pgTable(
  "payroll_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    runId: uuid("run_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    employeeName: varchar("employee_name", { length: 110 }).notNull(),
    employeeCode: varchar("employee_code", { length: 32 }),
    jobTitle: varchar("job_title", { length: 100 }),
    departmentName: varchar("department_name", { length: 100 }),
    compensationType: varchar("compensation_type", { length: 16 })
      .$type<CompensationType>()
      .notNull(),
    compensationAmount: numeric("compensation_amount", { precision: 12, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    workingDays: numeric("working_days", { precision: 5, scale: 1 }).notNull(),
    presentDays: numeric("present_days", { precision: 5, scale: 1 }).notNull(),
    halfDays: numeric("half_days", { precision: 5, scale: 1 }).notNull(),
    paidLeaveDays: numeric("paid_leave_days", { precision: 5, scale: 1 }).notNull(),
    unpaidLeaveDays: numeric("unpaid_leave_days", { precision: 5, scale: 1 }).notNull(),
    absentDays: numeric("absent_days", { precision: 5, scale: 1 }).notNull(),
    incompleteDays: integer("incomplete_days").notNull().default(0),
    workedMinutes: integer("worked_minutes").notNull().default(0),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    lateCount: integer("late_count").notNull().default(0),
    lateMinutes: integer("late_minutes").notNull().default(0),
    basePay: numeric("base_pay", { precision: 12, scale: 2 }).notNull(),
    overtimePay: numeric("overtime_pay", { precision: 12, scale: 2 }).notNull(),
    allowancesPay: numeric("allowances_pay", { precision: 12, scale: 2 }).notNull().default("0"),
    grossPay: numeric("gross_pay", { precision: 12, scale: 2 }).notNull(),
    lateFine: numeric("late_fine", { precision: 12, scale: 2 }).notNull(),
    componentDeductions: numeric("component_deductions", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    loanDeduction: numeric("loan_deduction", { precision: 12, scale: 2 }).notNull(),
    totalDeductions: numeric("total_deductions", { precision: 12, scale: 2 }).notNull(),
    netPay: numeric("net_pay", { precision: 12, scale: 2 }).notNull(),
    componentLines: jsonb("component_lines")
      .$type<PayrollComponentLine[]>()
      .notNull()
      .default([]),
    loanLines: jsonb("loan_lines").$type<PayrollLoanLine[]>().notNull().default([]),
    // Approved expense claims paid back with this salary. Added to net pay, outside gross and deductions.
    reimbursements: numeric("reimbursements", { precision: 12, scale: 2 }).notNull().default("0"),
    reimbursementLines: jsonb("reimbursement_lines").$type<PayrollReimbursementLine[]>().notNull().default([]),
    statutory: jsonb("statutory").$type<StatutoryBreakup>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "payroll_items_run_org_fk",
      columns: [table.organizationId, table.runId],
      foreignColumns: [payrollRunsTable.organizationId, payrollRunsTable.id],
    }).onDelete("cascade"),
    uniqueIndex("payroll_items_run_employee_unique").on(table.runId, table.userOrganizationId),
    index("payroll_items_org_user_idx").on(table.organizationId, table.userId),
  ],
);
