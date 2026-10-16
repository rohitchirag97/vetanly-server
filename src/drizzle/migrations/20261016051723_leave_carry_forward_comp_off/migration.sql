CREATE TABLE "leave_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"days" numeric(3,1) NOT NULL,
	"reason" varchar(300),
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "carry_forward_max_days" numeric(5,1);--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "is_comp_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "comp_off_validity_days" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_credits_employee_type_day_unique" ON "leave_credits" ("user_organization_id","leave_type_id","worked_on");--> statement-breakpoint
ALTER TABLE "leave_credits" ADD CONSTRAINT "leave_credits_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "leave_credits" ADD CONSTRAINT "leave_credits_granted_by_user_id_users_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "leave_credits" ADD CONSTRAINT "leave_credits_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "leave_credits" ADD CONSTRAINT "leave_credits_type_org_fk" FOREIGN KEY ("organization_id","leave_type_id") REFERENCES "leave_types"("organization_id","id");