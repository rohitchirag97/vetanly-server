CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"category" varchar(24) NOT NULL,
	"amount" numeric(12,2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"expense_date" date NOT NULL,
	"description" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"receipt_storage_key" varchar(300),
	"receipt_name" varchar(150),
	"receipt_content_type" varchar(100),
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(500),
	"payroll_run_id" uuid,
	"paid_at" timestamp with time zone,
	"payment_note" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "reimbursements" numeric(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "reimbursement_lines" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_claims_org_status_idx" ON "expense_claims" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "expense_claims_org_employee_idx" ON "expense_claims" ("organization_id","user_organization_id");--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");