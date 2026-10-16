CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"assigned_on" date NOT NULL,
	"condition_out" varchar(10) NOT NULL,
	"notes_out" varchar(300),
	"assigned_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"returned_on" date,
	"condition_in" varchar(10),
	"notes_in" varchar(300),
	"received_by_user_id" uuid,
	"lost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"asset_tag" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" varchar(16) NOT NULL,
	"serial_number" varchar(80),
	"brand" varchar(60),
	"model" varchar(80),
	"purchase_date" date,
	"purchase_cost" numeric(12,2),
	"warranty_until" date,
	"branch_id" uuid,
	"condition" varchar(10) DEFAULT 'good' NOT NULL,
	"status" varchar(12) DEFAULT 'available' NOT NULL,
	"holder_membership_id" uuid,
	"notes" varchar(500),
	"retired_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "asset_assignments_asset_idx" ON "asset_assignments" ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_assignments_employee_idx" ON "asset_assignments" ("user_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_tag_unique" ON "assets" ("organization_id","asset_tag");--> statement-breakpoint
CREATE INDEX "assets_org_status_idx" ON "assets" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "assets_holder_idx" ON "assets" ("holder_membership_id");--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assigned_by_user_id_users_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_received_by_user_id_users_id_fkey" FOREIGN KEY ("received_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;