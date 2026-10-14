CREATE TABLE "employee_recoverable_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"recoverable_id" uuid NOT NULL,
	"amount" numeric(12,2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"source" varchar(16) NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payroll_period_start" date,
	"payroll_period_end" date,
	"reference" varchar(100),
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_recoverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"type" varchar(24) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"principal_amount" numeric(12,2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"annual_interest_rate" numeric(7,4) DEFAULT '0' NOT NULL,
	"installment_count" integer,
	"installment_amount" numeric(12,2),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"disbursed_at" timestamp with time zone,
	"first_repayment_date" date,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "employee_recoverable_repayments_org_recoverable_paid_idx" ON "employee_recoverable_repayments" ("organization_id","recoverable_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_recoverables_org_id_id_unique" ON "employee_recoverables" ("organization_id","id");--> statement-breakpoint
CREATE INDEX "employee_recoverables_org_employee_status_idx" ON "employee_recoverables" ("organization_id","user_organization_id","status");--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD CONSTRAINT "employee_recoverable_repayments_U0ozbzpYuKcF_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_recoverable_repayments" ADD CONSTRAINT "employee_recoverable_repayments_recoverable_org_fk" FOREIGN KEY ("organization_id","recoverable_id") REFERENCES "employee_recoverables"("organization_id","id");--> statement-breakpoint
ALTER TABLE "employee_recoverables" ADD CONSTRAINT "employee_recoverables_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_recoverables" ADD CONSTRAINT "employee_recoverables_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");