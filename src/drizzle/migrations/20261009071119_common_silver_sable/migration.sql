CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"code" varchar(32),
	"description" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"grace_period_minutes" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_org_id_id_unique" ON "departments" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_org_name_unique" ON "departments" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_org_code_unique" ON "departments" ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_org_id_id_unique" ON "shifts" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_org_name_unique" ON "shifts" ("organization_id","name");--> statement-breakpoint
INSERT INTO "departments" ("organization_id", "name")
SELECT DISTINCT "organization_id", trim("department")
FROM "user_organizations"
WHERE "department" IS NOT NULL AND trim("department") <> ''
ON CONFLICT ("organization_id", "name") DO NOTHING;--> statement-breakpoint
UPDATE "user_organizations" AS membership
SET "department_id" = department.id
FROM "departments" AS department
WHERE membership.organization_id = department.organization_id
  AND trim(membership.department) = department.name;--> statement-breakpoint
ALTER TABLE "user_organizations" DROP COLUMN "department";--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_department_org_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "departments"("organization_id","id");--> statement-breakpoint
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_shift_org_fk" FOREIGN KEY ("organization_id","shift_id") REFERENCES "shifts"("organization_id","id");