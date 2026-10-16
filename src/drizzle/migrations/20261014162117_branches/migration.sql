CREATE TABLE "branch_managers" (
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid,
	"branch_id" uuid,
	CONSTRAINT "branch_managers_pkey" PRIMARY KEY("user_organization_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"code" varchar(32),
	"address_line1" varchar(200),
	"address_line2" varchar(200),
	"city" varchar(100),
	"state" varchar(100),
	"postal_code" varchar(20),
	"pt_state" varchar(8),
	"pt_flat_amount" numeric(8,2),
	"latitude" numeric(9,6),
	"longitude" numeric(9,6),
	"geofence_radius_meters" integer DEFAULT 200 NOT NULL,
	"gps_check_in" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "holidays_org_date_unique";--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "latitude" numeric(9,6);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "longitude" numeric(9,6);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "accuracy_meters" integer;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "distance_meters" integer;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "holidays" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "branch_name" varchar(100);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_org_date_branch_unique" UNIQUE NULLS NOT DISTINCT("organization_id","date","branch_id");--> statement-breakpoint
CREATE INDEX "branch_managers_branch_idx" ON "branch_managers" ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_org_id_id_unique" ON "branches" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_org_name_unique" ON "branches" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "user_organizations_branch_idx" ON "user_organizations" ("branch_id");--> statement-breakpoint
ALTER TABLE "branch_managers" ADD CONSTRAINT "branch_managers_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "branch_managers" ADD CONSTRAINT "branch_managers_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_branch_org_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id");