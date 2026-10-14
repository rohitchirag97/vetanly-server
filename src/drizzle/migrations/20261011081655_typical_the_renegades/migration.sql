CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" varchar(2000) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_regularizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"date" date NOT NULL,
	"requested_check_in" timestamp with time zone,
	"requested_check_out" timestamp with time zone,
	"reason" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"user_name" varchar(255),
	"role" varchar(30),
	"method" varchar(10) NOT NULL,
	"path" varchar(500) NOT NULL,
	"action" varchar(200) NOT NULL,
	"summary" varchar(1000),
	"details" jsonb,
	"status_code" integer NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(300),
	"prev_hash" varchar(64) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"doc_type" varchar(24) NOT NULL,
	"name" varchar(150) NOT NULL,
	"storage_key" varchar(300) NOT NULL,
	"content_type" varchar(50) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_exits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"exit_type" varchar(16) NOT NULL,
	"status" varchar(12) NOT NULL,
	"resignation_date" date NOT NULL,
	"notice_days" integer DEFAULT 0 NOT NULL,
	"last_working_day" date NOT NULL,
	"reason" varchar(500),
	"notes" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "employee_lifecycle_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"title" varchar(150) NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date_of_birth" date,
	"address_line1" varchar(200),
	"address_line2" varchar(200),
	"city" varchar(100),
	"state" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"emergency_contact_name" varchar(100),
	"emergency_contact_relation" varchar(50),
	"emergency_contact_phone" varchar(20),
	"bank_account_holder" varchar(100),
	"bank_name" varchar(100),
	"bank_account_number" varchar(200),
	"bank_account_last4" varchar(4),
	"bank_ifsc" varchar(20),
	"upi_id" varchar(100),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_statutory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"uan" varchar(12),
	"esi_number" varchar(17),
	"pan_encrypted" varchar(200),
	"gender" varchar(10),
	"pf_applicable" boolean DEFAULT true NOT NULL,
	"esi_applicable" boolean DEFAULT true NOT NULL,
	"tax_regime" varchar(4) DEFAULT 'new' NOT NULL,
	"declared_deductions" numeric(12,2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(40) NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" varchar(500),
	"link" varchar(200),
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_statutory_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"pf_enabled" boolean DEFAULT false NOT NULL,
	"pf_wage_ceiling" numeric(12,2) DEFAULT '15000' NOT NULL,
	"pf_cap_wages" boolean DEFAULT true NOT NULL,
	"pf_establishment_code" varchar(32),
	"esi_enabled" boolean DEFAULT false NOT NULL,
	"esi_wage_ceiling" numeric(12,2) DEFAULT '21000' NOT NULL,
	"esi_establishment_code" varchar(32),
	"pt_enabled" boolean DEFAULT false NOT NULL,
	"pt_state" varchar(8),
	"pt_flat_amount" numeric(8,2),
	"tds_enabled" boolean DEFAULT false NOT NULL,
	"tan" varchar(10),
	"employer_pan" varchar(10),
	"employer_address" varchar(300),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" varchar(10) NOT NULL,
	"approved_minutes" integer DEFAULT 0 NOT NULL,
	"note" varchar(300),
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"employee_name" varchar(110) NOT NULL,
	"employee_code" varchar(32),
	"job_title" varchar(100),
	"department_name" varchar(100),
	"compensation_type" varchar(16) NOT NULL,
	"compensation_amount" numeric(12,2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"working_days" numeric(5,1) NOT NULL,
	"present_days" numeric(5,1) NOT NULL,
	"half_days" numeric(5,1) NOT NULL,
	"paid_leave_days" numeric(5,1) NOT NULL,
	"unpaid_leave_days" numeric(5,1) NOT NULL,
	"absent_days" numeric(5,1) NOT NULL,
	"incomplete_days" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"late_count" integer DEFAULT 0 NOT NULL,
	"late_minutes" integer DEFAULT 0 NOT NULL,
	"base_pay" numeric(12,2) NOT NULL,
	"overtime_pay" numeric(12,2) NOT NULL,
	"allowances_pay" numeric(12,2) DEFAULT '0' NOT NULL,
	"gross_pay" numeric(12,2) NOT NULL,
	"late_fine" numeric(12,2) NOT NULL,
	"component_deductions" numeric(12,2) DEFAULT '0' NOT NULL,
	"loan_deduction" numeric(12,2) NOT NULL,
	"total_deductions" numeric(12,2) NOT NULL,
	"net_pay" numeric(12,2) NOT NULL,
	"component_lines" jsonb DEFAULT '[]' NOT NULL,
	"loan_lines" jsonb DEFAULT '[]' NOT NULL,
	"statutory" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"utc_offset_minutes" integer DEFAULT 0 NOT NULL,
	"generated_by_user_id" uuid,
	"finalized_by_user_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_user_id" uuid NOT NULL,
	"actor_name" varchar(110) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_organization_id" uuid,
	"target_organization_name" varchar(52),
	"target_user_id" uuid,
	"reason" varchar(500),
	"before_values" jsonb,
	"after_values" jsonb,
	"ip_address" varchar(64),
	"user_agent" varchar(300),
	"prev_hash" varchar(64) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_name" varchar(110) NOT NULL,
	"text" varchar(2000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"user_id" uuid PRIMARY KEY,
	"session_id" uuid NOT NULL,
	"user_agent" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "status" varchar(16) DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "payment_method" varchar(20);--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD COLUMN "review_note" varchar(500);--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "weekly_off_days" varchar(20) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "auto_deduct_loans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "paid_holidays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "overtime_approval_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "full_day_threshold_percent" numeric(5,2) DEFAULT '90' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "half_day_threshold_percent" numeric(5,2) DEFAULT '50' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "deactivation_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "deactivated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "salary_components" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" varchar(254);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE("email");--> statement-breakpoint
CREATE INDEX "announcements_org_created_idx" ON "announcements" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "attendance_regularizations_org_status_idx" ON "attendance_regularizations" ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "attendance_regularizations_employee_date_idx" ON "attendance_regularizations" ("user_organization_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_id_unique" ON "audit_logs" ("id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_seq_idx" ON "audit_logs" ("organization_id","seq");--> statement-breakpoint
CREATE INDEX "employee_documents_org_user_idx" ON "employee_documents" ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_exits_org_user_unique" ON "employee_exits" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "employee_lifecycle_tasks_org_user_idx" ON "employee_lifecycle_tasks" ("organization_id","user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_profiles_org_user_unique" ON "employee_profiles" ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_statutory_profiles_employee_unique" ON "employee_statutory_profiles" ("user_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_org_date_unique" ON "holidays" ("organization_id","date");--> statement-breakpoint
CREATE INDEX "notifications_user_org_created_idx" ON "notifications" ("user_id","organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_statutory_settings_org_unique" ON "organization_statutory_settings" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "overtime_approvals_employee_date_unique" ON "overtime_approvals" ("user_organization_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_items_run_employee_unique" ON "payroll_items" ("run_id","user_organization_id");--> statement-breakpoint
CREATE INDEX "payroll_items_org_user_idx" ON "payroll_items" ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_org_id_id_unique" ON "payroll_runs" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_org_period_unique" ON "payroll_runs" ("organization_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_created_idx" ON "platform_audit_logs" ("created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_org_created_idx" ON "platform_audit_logs" ("target_organization_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_notes_org_created_idx" ON "platform_notes" ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_JxgozgL2HtSC_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_exits" ADD CONSTRAINT "employee_exits_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_exits" ADD CONSTRAINT "employee_exits_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_lifecycle_tasks" ADD CONSTRAINT "employee_lifecycle_tasks_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_lifecycle_tasks" ADD CONSTRAINT "employee_lifecycle_tasks_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD CONSTRAINT "employee_recoverable_repayments_B293htSfMSfh_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD CONSTRAINT "employee_recoverable_repayments_C4KJQy9qSmiJ_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "employee_statutory_profiles" ADD CONSTRAINT "employee_statutory_profiles_vOB02j8jsqTw_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_statutory_profiles" ADD CONSTRAINT "employee_statutory_profiles_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_statutory_settings" ADD CONSTRAINT "organization_statutory_settings_cgsvstrYAhfa_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "overtime_approvals" ADD CONSTRAINT "overtime_approvals_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "overtime_approvals" ADD CONSTRAINT "overtime_approvals_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "overtime_approvals" ADD CONSTRAINT "overtime_approvals_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_run_org_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "payroll_runs"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_generated_by_user_id_users_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalized_by_user_id_users_id_fkey" FOREIGN KEY ("finalized_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_audit_logs_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_no_update_delete
BEFORE UPDATE OR DELETE ON platform_audit_logs
FOR EACH ROW EXECUTE FUNCTION platform_audit_logs_block_change();
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_no_truncate
BEFORE TRUNCATE ON platform_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_logs_block_change();
