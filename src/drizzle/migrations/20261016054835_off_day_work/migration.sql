CREATE TABLE "off_day_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"requested_outcome" varchar(16),
	"requested_at" timestamp with time zone,
	"outcome" varchar(16),
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"leave_credit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "off_day_work_policy" varchar(16) DEFAULT 'manager' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "weekly_off_work_multiplier" numeric(4,2) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD COLUMN "holiday_work_multiplier" numeric(4,2) DEFAULT '2' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "off_day_days" numeric(5,1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "off_day_pay" numeric(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "off_day_pending_days" numeric(5,1) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "off_day_work_employee_date_unique" ON "off_day_work" ("user_organization_id","work_date");--> statement-breakpoint
ALTER TABLE "off_day_work" ADD CONSTRAINT "off_day_work_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "off_day_work" ADD CONSTRAINT "off_day_work_decided_by_user_id_users_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "off_day_work" ADD CONSTRAINT "off_day_work_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");