CREATE TABLE "final_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"last_working_day" date NOT NULL,
	"salary_from" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"inputs" jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]' NOT NULL,
	"statutory" jsonb,
	"total_earnings" numeric(12,2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(12,2) DEFAULT '0' NOT NULL,
	"net_payable" numeric(12,2) DEFAULT '0' NOT NULL,
	"notes" varchar(1000),
	"prepared_by_user_id" uuid,
	"finalized_by_user_id" uuid,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"payment_method" varchar(30),
	"payment_reference" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "final_settlements_org_status_idx" ON "final_settlements" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "final_settlements_employee_idx" ON "final_settlements" ("user_organization_id");--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_prepared_by_user_id_users_id_fkey" FOREIGN KEY ("prepared_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_finalized_by_user_id_users_id_fkey" FOREIGN KEY ("finalized_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");