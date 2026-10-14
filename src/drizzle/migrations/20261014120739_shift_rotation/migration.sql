CREATE TABLE "shift_roster_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"date" date NOT NULL,
	"shift_id" uuid,
	"source" varchar(8) DEFAULT 'manual' NOT NULL,
	"note" varchar(200),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_rotation_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"rotation_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"cycle_offset" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"pattern" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"requester_membership_id" uuid NOT NULL,
	"colleague_membership_id" uuid NOT NULL,
	"date" date NOT NULL,
	"reason" varchar(300),
	"status" varchar(20) DEFAULT 'awaiting_colleague' NOT NULL,
	"reviewed_by_user_id" uuid,
	"review_note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shift_roster_overrides_employee_date_unique" ON "shift_roster_overrides" ("user_organization_id","date");--> statement-breakpoint
CREATE INDEX "shift_roster_overrides_org_date_idx" ON "shift_roster_overrides" ("organization_id","date");--> statement-breakpoint
CREATE INDEX "shift_rotation_assignments_employee_idx" ON "shift_rotation_assignments" ("user_organization_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_rotations_org_name_unique" ON "shift_rotations" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "shift_swap_requests_org_status_idx" ON "shift_swap_requests" ("organization_id","status");--> statement-breakpoint
ALTER TABLE "shift_roster_overrides" ADD CONSTRAINT "shift_roster_overrides_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "shift_roster_overrides" ADD CONSTRAINT "shift_roster_overrides_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "shift_roster_overrides" ADD CONSTRAINT "shift_roster_overrides_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "shift_rotation_assignments" ADD CONSTRAINT "shift_rotation_assignments_a7UxdvpS5AmV_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "shift_rotation_assignments" ADD CONSTRAINT "shift_rotation_assignments_rotation_id_shift_rotations_id_fkey" FOREIGN KEY ("rotation_id") REFERENCES "shift_rotations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shift_rotation_assignments" ADD CONSTRAINT "shift_rotation_assignments_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "shift_rotations" ADD CONSTRAINT "shift_rotations_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requester_org_fk" FOREIGN KEY ("organization_id","requester_membership_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_colleague_org_fk" FOREIGN KEY ("organization_id","colleague_membership_id") REFERENCES "user_organizations"("organization_id","id");