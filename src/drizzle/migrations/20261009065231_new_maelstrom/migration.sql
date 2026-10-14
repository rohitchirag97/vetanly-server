ALTER TABLE "user_organizations" ADD COLUMN "employee_code" varchar(32);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "job_title" varchar(100);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "department" varchar(100);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "employment_type" varchar(24);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "hire_date" date;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "compensation_type" varchar(16);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "compensation_amount" numeric(12,2);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "compensation_currency" varchar(3);--> statement-breakpoint
ALTER TABLE "user_organizations" ADD COLUMN "pay_frequency" varchar(16);--> statement-breakpoint
CREATE UNIQUE INDEX "user_organizations_org_employee_code_unique" ON "user_organizations" ("organization_id","employee_code");