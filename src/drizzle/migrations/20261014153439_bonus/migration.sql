CREATE TABLE "bonus_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"employee_name" varchar(120) NOT NULL,
	"eligible" boolean NOT NULL,
	"reason" varchar(200),
	"monthly_wage" numeric(12,2) DEFAULT '0' NOT NULL,
	"days_worked" numeric(6,1) DEFAULT '0' NOT NULL,
	"bonus_wages" numeric(12,2) DEFAULT '0' NOT NULL,
	"calculated_amount" numeric(12,2) DEFAULT '0' NOT NULL,
	"final_amount" numeric(12,2) DEFAULT '0' NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"paid_in_payroll_run_id" uuid,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bonus_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"percentage" numeric(5,2) NOT NULL,
	"eligibility_ceiling" numeric(12,2) NOT NULL,
	"calculation_ceiling" numeric(12,2) NOT NULL,
	"payout" varchar(8) DEFAULT 'payroll' NOT NULL,
	"total_amount" numeric(14,2) DEFAULT '0' NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"payment_reference" varchar(120),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "bonus" numeric(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "bonus_lines" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "bonus_items_run_idx" ON "bonus_items" ("run_id");--> statement-breakpoint
CREATE INDEX "bonus_items_employee_idx" ON "bonus_items" ("user_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_runs_org_fy_unique" ON "bonus_runs" ("organization_id","financial_year");--> statement-breakpoint
ALTER TABLE "bonus_items" ADD CONSTRAINT "bonus_items_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "bonus_items" ADD CONSTRAINT "bonus_items_run_id_bonus_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "bonus_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_approved_by_user_id_users_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id");