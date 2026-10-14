CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_half_day" boolean DEFAULT false NOT NULL,
	"days" numeric(5,1) NOT NULL,
	"reason" varchar(500),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"annual_allowance_days" numeric(5,1),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "leave_requests_org_employee_status_idx" ON "leave_requests" ("organization_id","user_organization_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_org_dates_idx" ON "leave_requests" ("organization_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_org_id_id_unique" ON "leave_types" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_org_name_unique" ON "leave_types" ("organization_id","name");--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_type_org_fk" FOREIGN KEY ("organization_id","leave_type_id") REFERENCES "leave_types"("organization_id","id");--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");