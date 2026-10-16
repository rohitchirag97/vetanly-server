CREATE TABLE "accounting_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"format" varchar(8) NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"voucher_keys" jsonb DEFAULT '[]' NOT NULL,
	"exported_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_settings" (
	"organization_id" uuid PRIMARY KEY,
	"ledgers" jsonb DEFAULT '{}' NOT NULL,
	"split_by" varchar(12) DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "accounting_exports_org_idx" ON "accounting_exports" ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_exported_by_user_id_users_id_fkey" FOREIGN KEY ("exported_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");