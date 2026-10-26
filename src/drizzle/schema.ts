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
  unique,
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

export type AttendanceSource = "kiosk" | "manual" | "regularization" | "gps";

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

export type PlatformBillingPeriod = "monthly" | "annual" | "five_year";
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
    // Lets admins and HR set an employee's check-in and check-out directly, without a correction request.
    adminAttendanceEdit: boolean("admin_attendance_edit").notNull().default(false),
    // What happens to a day worked on a weekly off or holiday nobody has decided on yet.
    offDayWorkPolicy: varchar("off_day_work_policy", { length: 16 }).$type<OffDayWorkPolicy>().notNull().default("manager"),
    // Pay for that day, in days' wages. For holidays it includes holiday pay already given, so 2 means double wages.
    weeklyOffWorkMultiplier: numeric("weekly_off_work_multiplier", { precision: 4, scale: 2 }).notNull().default("1"),
    holidayWorkMultiplier: numeric("holiday_work_multiplier", { precision: 4, scale: 2 }).notNull().default("2"),
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

/**
 * An office, site or store. Employees and kiosks belong to one; holidays and professional tax can
 * differ by branch; admins and HR can be limited to some branches (branch_managers); and a branch with
 * coordinates can let its employees check in by GPS from their phone, inside the geofence.
 */
export const branchesTable = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: varchar("name", { length: 100 }).notNull(),
    code: varchar("code", { length: 32 }),
    addressLine1: varchar("address_line1", { length: 200 }),
    addressLine2: varchar("address_line2", { length: 200 }),
    city: varchar("city", { length: 100 }),
    state: varchar("state", { length: 100 }),
    postalCode: varchar("postal_code", { length: 20 }),
    // Professional tax slabs for this branch's state; null follows the organization's statutory setting.
    ptState: varchar("pt_state", { length: 8 }),
    ptFlatAmount: numeric("pt_flat_amount", { precision: 8, scale: 2 }),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    geofenceRadiusMeters: integer("geofence_radius_meters").notNull().default(200),
    gpsCheckIn: boolean("gps_check_in").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("branches_org_id_id_unique").on(table.organizationId, table.id),
    uniqueIndex("branches_org_name_unique").on(table.organizationId, table.name),
  ],
);

/** Admins and HR limited to these branches. Someone with no rows here manages the whole organization. */
export const branchManagersTable = pgTable(
  "branch_managers",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branchesTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userOrganizationId, table.branchId] }),
    index("branch_managers_branch_idx").on(table.branchId),
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
    // A holiday for one branch only (a state holiday); null applies to every branch.
    branchId: uuid("branch_id").references(() => branchesTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("holidays_org_date_branch_unique").on(table.organizationId, table.date, table.branchId).nullsNotDistinct(),
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
    branchId: uuid("branch_id"),
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
    foreignKey({
      name: "user_organizations_branch_org_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branchesTable.organizationId, branchesTable.id],
    }),
    index("user_organizations_branch_idx").on(table.branchId),
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
    // A+, A-, B+, B-, AB+, AB-, O+ or O-. Gender is kept on the statutory profile (PT slabs use it).
    bloodGroup: varchar("blood_group", { length: 3 }),
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

/**
 * Full & final settlement for a leaver (see services/settlement.services.ts): final salary, leave
 * encashment, gratuity, notice recovery, loan recovery, unpaid expense claims and manual lines.
 */
export type SettlementStatus = "draft" | "finalized" | "paid" | "cancelled";
export type SettlementLineKind =
  | "salary"
  | "leave_encashment"
  | "gratuity"
  | "reimbursement"
  | "other_earning"
  | "notice_recovery"
  | "loan_recovery"
  | "other_deduction";
export type SettlementLine = {
  kind: SettlementLineKind;
  label: string;
  amount: string;
  // Links back to what the line settles: the loan, the expense claim, or bonuses paid with the final salary.
  recoverableId?: string;
  claimId?: string;
  bonusItemIds?: string[];
};
/** What the preparer chose; the lines are worked out from these. */
export type SettlementInputs = {
  salaryFrom: string;
  encashDays: number;
  dailyRate: number;
  includeGratuity: boolean;
  waiveNoticeRecovery: boolean;
  extraLines: { kind: "other_earning" | "other_deduction"; label: string; amount: number }[];
  utcOffsetMinutes: number;
};

export const finalSettlementsTable = pgTable(
  "final_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    status: varchar("status", { length: 12 }).$type<SettlementStatus>().notNull().default("draft"),
    lastWorkingDay: date("last_working_day", { mode: "string" }).notNull(),
    // The final salary covers salaryFrom..lastWorkingDay; payroll runs skip the employee from salaryFrom.
    salaryFrom: date("salary_from", { mode: "string" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    inputs: jsonb("inputs").$type<SettlementInputs>().notNull(),
    lines: jsonb("lines").$type<SettlementLine[]>().notNull().default([]),
    // The final salary's statutory breakup (PF, ESI, PT, TDS) for reports and the statement.
    statutory: jsonb("statutory").$type<StatutoryBreakup>(),
    totalEarnings: numeric("total_earnings", { precision: 12, scale: 2 }).notNull().default("0"),
    totalDeductions: numeric("total_deductions", { precision: 12, scale: 2 }).notNull().default("0"),
    // Negative when the employee owes the company.
    netPayable: numeric("net_payable", { precision: 12, scale: 2 }).notNull().default("0"),
    notes: varchar("notes", { length: 1000 }),
    preparedByUserId: uuid("prepared_by_user_id").references(() => usersTable.id),
    finalizedByUserId: uuid("finalized_by_user_id").references(() => usersTable.id),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentMethod: varchar("payment_method", { length: 30 }),
    paymentReference: varchar("payment_reference", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "final_settlements_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    index("final_settlements_org_status_idx").on(table.organizationId, table.status),
    index("final_settlements_employee_idx").on(table.userOrganizationId),
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
    branchId: uuid("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
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
    // GPS check-ins: where the phone was, how precise it said it was, and how far from the branch.
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    accuracyMeters: integer("accuracy_meters"),
    distanceMeters: integer("distance_meters"),
    branchId: uuid("branch_id"),
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
    // Unused days that move into the next year, at most this many; null carries nothing.
    carryForwardMaxDays: numeric("carry_forward_max_days", { precision: 5, scale: 1 }),
    // Compensatory off: the balance comes only from credits for days worked off-schedule.
    isCompOff: boolean("is_comp_off").notNull().default(false),
    // How long a comp-off credit can be used after the worked day; null never expires.
    compOffValidityDays: integer("comp_off_validity_days"),
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

export type OffDayWorkPolicy = "manager" | "pay" | "comp_off";
export type OffDayOutcome = "comp_off" | "pay" | "none";

/**
 * A day worked on a weekly off or holiday: what the employee asked for and what was decided.
 * Rows exist only once someone has requested or decided; the worked days come from attendance.
 */
export const offDayWorkTable = pgTable(
  "off_day_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    workDate: date("work_date").notNull(),
    requestedOutcome: varchar("requested_outcome", { length: 16 }).$type<"comp_off" | "pay">(),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    outcome: varchar("outcome", { length: 16 }).$type<OffDayOutcome>(),
    // Null with an outcome: settled automatically by the organization's policy at payroll.
    decidedByUserId: uuid("decided_by_user_id").references(() => usersTable.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    leaveCreditId: uuid("leave_credit_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "off_day_work_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    uniqueIndex("off_day_work_employee_date_unique").on(table.userOrganizationId, table.workDate),
  ],
);

/** Extra days added to a leave balance, e.g. a comp-off for working a weekly off or holiday. */
export const leaveCreditsTable = pgTable(
  "leave_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userOrganizationId: uuid("user_organization_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    workedOn: date("worked_on").notNull(),
    days: numeric("days", { precision: 3, scale: 1 }).notNull(),
    reason: varchar("reason", { length: 300 }),
    grantedByUserId: uuid("granted_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "leave_credits_employee_org_fk",
      columns: [table.organizationId, table.userOrganizationId],
      foreignColumns: [userOrganizationsTable.organizationId, userOrganizationsTable.id],
    }),
    foreignKey({
      name: "leave_credits_type_org_fk",
      columns: [table.organizationId, table.leaveTypeId],
      foreignColumns: [leaveTypesTable.organizationId, leaveTypesTable.id],
    }),
    // One credit per worked day, so the same day cannot be granted twice.
    uniqueIndex("leave_credits_employee_type_day_unique").on(table.userOrganizationId, table.leaveTypeId, table.workedOn),
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

/**
 * Report delivery add-on (see services/messaging.services.ts). Sending documents by email or WhatsApp
 * needs the add-on; every message is charged from the organization's prepaid wallet at the platform's
 * per-message rates. WhatsApp goes through Vetanly's own WhatsApp service or the organization's own
 * provider (any HTTP API). Login OTPs never use any of this: they always go through Vetanly's service.
 */
export type MessagingChannel = "email" | "whatsapp";
export type MessagingProviderKind = "vetanly" | "custom_http";
export type MessageType = "salary_slip" | "loan_noc" | "test";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "simulated";

/** Per-message rates in rupees; a null override follows the platform rate. */
export type MessagingRates = { email: number; whatsappVetanly: number; whatsappCustom: number };

export const platformMessagingSettingsTable = pgTable("platform_messaging_settings", {
  id: integer("id").primaryKey().default(1),
  emailRate: numeric("email_rate", { precision: 10, scale: 3 }).notNull().default("0"),
  whatsappVetanlyRate: numeric("whatsapp_vetanly_rate", { precision: 10, scale: 3 }).notNull().default("0.350"),
  whatsappCustomRate: numeric("whatsapp_custom_rate", { precision: 10, scale: 3 }).notNull().default("0.050"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messagingSettingsTable = pgTable("messaging_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id),
  addonEnabled: boolean("addon_enabled").notNull().default(false),
  addonRequestedAt: timestamp("addon_requested_at", { withTimezone: true }),
  // The WhatsApp provider in use; null means WhatsApp is not set up.
  whatsappProviderId: uuid("whatsapp_provider_id"),
  balance: numeric("balance", { precision: 14, scale: 3 }).notNull().default("0"),
  lowBalanceThreshold: numeric("low_balance_threshold", { precision: 12, scale: 2 }).notNull().default("100"),
  lowBalanceNotifiedAt: timestamp("low_balance_notified_at", { withTimezone: true }),
  // Platform overrides of the per-message rates for this organization.
  rateOverrides: jsonb("rate_overrides").$type<Partial<MessagingRates>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A provider an organization sends through. Settings that are not secret live in config; API keys and
 * tokens live in secrets, each value encrypted, and are never sent back to the browser.
 */
export type CustomHttpConfig = {
  url: string;
  method: "POST" | "PUT" | "GET";
  headers: { name: string; value: string }[];
  // JSON with {{placeholders}}; see services/messaging-template.ts.
  bodyTemplate: string;
  // Where the provider's message id is in its response, e.g. "data.messageId".
  responseIdPath?: string;
  // How to read the provider's delivery-status callbacks.
  statusWebhook?: {
    messageIdPath: string;
    statusPath: string;
    errorPath?: string;
    statusMap: { sent?: string[]; delivered?: string[]; read?: string[]; failed?: string[] };
  };
};

export const messagingProvidersTable = pgTable(
  "messaging_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    kind: varchar("kind", { length: 16 }).$type<MessagingProviderKind>().notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    config: jsonb("config").$type<Partial<CustomHttpConfig>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    // Unguessable token in this provider's status-callback URL.
    webhookToken: varchar("webhook_token", { length: 64 }).notNull(),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOk: boolean("last_test_ok"),
    lastTestMessage: varchar("last_test_message", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messaging_providers_org_idx").on(table.organizationId),
    uniqueIndex("messaging_providers_webhook_token_unique").on(table.webhookToken),
  ],
);

/** Which of the provider's templates each Vetanly message uses, and the variables it fills, in order. */
export const messagingTemplatesTable = pgTable(
  "messaging_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => messagingProvidersTable.id, { onDelete: "cascade" }),
    messageType: varchar("message_type", { length: 16 }).$type<MessageType>().notNull(),
    templateName: varchar("template_name", { length: 120 }).notNull(),
    language: varchar("language", { length: 16 }).notNull().default("en"),
    params: jsonb("params").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("messaging_templates_provider_type_unique").on(table.providerId, table.messageType)],
);

export const messageLogsTable = pgTable(
  "message_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    channel: varchar("channel", { length: 10 }).$type<MessagingChannel>().notNull(),
    providerId: uuid("provider_id"),
    providerKind: varchar("provider_kind", { length: 16 }).$type<MessagingProviderKind | "email">().notNull(),
    messageType: varchar("message_type", { length: 16 }).$type<MessageType>().notNull(),
    // The document sent: payroll item, recoverable (loan) id; null for a test.
    relatedId: uuid("related_id"),
    recipientUserId: uuid("recipient_user_id"),
    // Masked for display; the real address is read from the user at send time.
    recipientMasked: varchar("recipient_masked", { length: 80 }).notNull(),
    // Only tests carry a typed-in destination.
    testDestination: varchar("test_destination", { length: 20 }),
    status: varchar("status", { length: 10 }).$type<MessageStatus>().notNull().default("queued"),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    error: varchar("error", { length: 500 }),
    charge: numeric("charge", { precision: 10, scale: 3 }).notNull().default("0"),
    refunded: boolean("refunded").notNull().default(false),
    requestedByUserId: uuid("requested_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("message_logs_org_created_idx").on(table.organizationId, table.createdAt),
    index("message_logs_provider_message_idx").on(table.providerMessageId),
  ],
);

export type WalletTransactionKind = "top_up" | "charge" | "refund" | "adjustment";

export const walletTransactionsTable = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    kind: varchar("kind", { length: 12 }).$type<WalletTransactionKind>().notNull(),
    // Positive adds to the balance, negative takes from it.
    amount: numeric("amount", { precision: 14, scale: 3 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 14, scale: 3 }).notNull(),
    messageLogId: uuid("message_log_id"),
    reference: varchar("reference", { length: 120 }),
    note: varchar("note", { length: 300 }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("wallet_transactions_org_created_idx").on(table.organizationId, table.createdAt)],
);

export type TopUpStatus = "pending" | "credited" | "cancelled";

/** An owner asks to add balance; the platform credits it once paid. */
export const walletTopUpRequestsTable = pgTable(
  "wallet_top_up_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    status: varchar("status", { length: 10 }).$type<TopUpStatus>().notNull().default("pending"),
    note: varchar("note", { length: 300 }),
    requestedByUserId: uuid("requested_by_user_id"),
    resolvedByUserId: uuid("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("wallet_top_up_requests_status_idx").on(table.status)],
);

/**
 * Company property handed to employees: laptops, phones, SIM cards, ID cards, vehicles, tools.
 * available <-> assigned through asset_assignments; in_repair and retired (lost, sold, scrapped) take
 * it out of use. A leaver's unreturned assets show on their full & final settlement.
 */
export type AssetCategory = "laptop" | "desktop" | "mobile" | "sim" | "id_card" | "access_card" | "vehicle" | "furniture" | "tool" | "other";
export type AssetStatus = "available" | "assigned" | "in_repair" | "retired";
export type AssetCondition = "new" | "good" | "fair" | "damaged";

export const assetsTable = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    assetTag: varchar("asset_tag", { length: 40 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    category: varchar("category", { length: 16 }).$type<AssetCategory>().notNull(),
    serialNumber: varchar("serial_number", { length: 80 }),
    brand: varchar("brand", { length: 60 }),
    model: varchar("model", { length: 80 }),
    purchaseDate: date("purchase_date"),
    purchaseCost: numeric("purchase_cost", { precision: 12, scale: 2 }),
    warrantyUntil: date("warranty_until"),
    branchId: uuid("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
    condition: varchar("condition", { length: 10 }).$type<AssetCondition>().notNull().default("good"),
    status: varchar("status", { length: 12 }).$type<AssetStatus>().notNull().default("available"),
    // The open assignment's employee, kept here so the register needs no join to show who holds it.
    holderMembershipId: uuid("holder_membership_id"),
    notes: varchar("notes", { length: 500 }),
    retiredReason: varchar("retired_reason", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("assets_org_tag_unique").on(table.organizationId, table.assetTag),
    index("assets_org_status_idx").on(table.organizationId, table.status),
    index("assets_holder_idx").on(table.holderMembershipId),
  ],
);

export const assetAssignmentsTable = pgTable(
  "asset_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    userOrganizationId: uuid("user_organization_id").notNull(),
    assignedOn: date("assigned_on").notNull(),
    conditionOut: varchar("condition_out", { length: 10 }).$type<AssetCondition>().notNull(),
    notesOut: varchar("notes_out", { length: 300 }),
    assignedByUserId: uuid("assigned_by_user_id").references(() => usersTable.id),
    // The employee confirms they received it.
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    returnedOn: date("returned_on"),
    conditionIn: varchar("condition_in", { length: 10 }).$type<AssetCondition>(),
    notesIn: varchar("notes_in", { length: 300 }),
    receivedByUserId: uuid("received_by_user_id").references(() => usersTable.id),
    // Set when the asset was lost while with the employee instead of returned.
    lost: boolean("lost").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("asset_assignments_asset_idx").on(table.assetId),
    index("asset_assignments_employee_idx").on(table.userOrganizationId),
  ],
);

/** Ledger names (by key, see services/accounting-journal.ts) and how vouchers are split for cost centres. */
export type AccountingSplit = "none" | "branch" | "department";

export const accountingSettingsTable = pgTable("accounting_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id),
  ledgers: jsonb("ledgers").$type<Record<string, string>>().notNull().default({}),
  splitBy: varchar("split_by", { length: 12 }).$type<AccountingSplit>().notNull().default("none"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Each download, with the vouchers in it, so the screen can warn before something is imported twice. */
export const accountingExportsTable = pgTable(
  "accounting_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    format: varchar("format", { length: 8 }).notNull(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    voucherKeys: jsonb("voucher_keys").$type<string[]>().notNull().default([]),
    exportedByUserId: uuid("exported_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("accounting_exports_org_idx").on(table.organizationId, table.createdAt)],
);

/**
 * Statutory bonus under the Payment of Bonus Act, per financial year (see services/bonus.services.ts).
 * draft -> approved -> paid; approved bonuses paid "with payroll" are picked up by the next payroll run.
 */
export type BonusRunStatus = "draft" | "approved" | "paid";
export type BonusPayout = "payroll" | "direct";

export const bonusRunsTable = pgTable(
  "bonus_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    status: varchar("status", { length: 12 }).$type<BonusRunStatus>().notNull().default("draft"),
    // 8.33 (the minimum) to 20 (the maximum) per cent of bonus wages.
    percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull(),
    // Employees earning more than this a month (basic + DA) are not covered by the Act.
    eligibilityCeiling: numeric("eligibility_ceiling", { precision: 12, scale: 2 }).notNull(),
    // Monthly wages counted for the bonus are capped here (7,000 or the state minimum wage, if higher).
    calculationCeiling: numeric("calculation_ceiling", { precision: 12, scale: 2 }).notNull(),
    payout: varchar("payout", { length: 8 }).$type<BonusPayout>().notNull().default("payroll"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    approvedByUserId: uuid("approved_by_user_id").references(() => usersTable.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentReference: varchar("payment_reference", { length: 120 }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("bonus_runs_org_fy_unique").on(table.organizationId, table.financialYear)],
);

export const bonusItemsTable = pgTable(
  "bonus_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => bonusRunsTable.id, { onDelete: "cascade" }),
    userOrganizationId: uuid("user_organization_id").notNull(),
    employeeName: varchar("employee_name", { length: 120 }).notNull(),
    eligible: boolean("eligible").notNull(),
    // Why an employee is not eligible, or a note about how the amount was reached.
    reason: varchar("reason", { length: 200 }),
    monthlyWage: numeric("monthly_wage", { precision: 12, scale: 2 }).notNull().default("0"),
    daysWorked: numeric("days_worked", { precision: 6, scale: 1 }).notNull().default("0"),
    bonusWages: numeric("bonus_wages", { precision: 12, scale: 2 }).notNull().default("0"),
    calculatedAmount: numeric("calculated_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // What is actually paid; starts at the calculated amount and can be adjusted before approval.
    finalAmount: numeric("final_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    included: boolean("included").notNull().default(true),
    // Set when a finalized payroll run paid it.
    paidInPayrollRunId: uuid("paid_in_payroll_run_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [
    index("bonus_items_run_idx").on(table.runId),
    index("bonus_items_employee_idx").on(table.userOrganizationId),
  ],
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
    branchId: uuid("branch_id"),
    branchName: varchar("branch_name", { length: 100 }),
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
    // Statutory bonus paid with this salary: inside gross (taxable), outside PF, ESI and PT wages.
    bonus: numeric("bonus", { precision: 12, scale: 2 }).notNull().default("0"),
    // Days worked on a weekly off or holiday and paid for, and that pay; pending ones await a decision.
    offDayDays: numeric("off_day_days", { precision: 5, scale: 1 }).notNull().default("0"),
    offDayPay: numeric("off_day_pay", { precision: 12, scale: 2 }).notNull().default("0"),
    offDayPendingDays: numeric("off_day_pending_days", { precision: 5, scale: 1 }).notNull().default("0"),
    bonusLines: jsonb("bonus_lines").$type<{ bonusItemId: string; label: string; amount: string }[]>().notNull().default([]),
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
