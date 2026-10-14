CREATE TABLE "organization_payroll_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"overtime_calculation_method" varchar(32) DEFAULT 'hourly_rate_multiplier' NOT NULL,
	"overtime_fixed_amount_per_hour" numeric(12,2),
	"overtime_hourly_rate_multiplier" numeric(6,3) DEFAULT '1.5' NOT NULL,
	"overtime_hours_per_workday" numeric(5,2),
	"salary_days_per_month" numeric(5,2),
	"late_fine_method" varchar(24) DEFAULT 'none' NOT NULL,
	"late_fine_amount" numeric(12,2),
	"late_fine_cap_per_pay_period" numeric(12,2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_payroll_settings_org_unique" ON "organization_payroll_settings" ("organization_id");--> statement-breakpoint
ALTER TABLE "organization_payroll_settings" ADD CONSTRAINT "organization_payroll_settings_IWuV8AoyJOqI_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");