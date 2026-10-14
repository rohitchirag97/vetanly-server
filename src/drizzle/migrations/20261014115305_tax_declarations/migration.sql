CREATE TABLE "tax_declaration_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"declaration_id" uuid NOT NULL,
	"section" varchar(20) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"description" varchar(200),
	"declared_amount" numeric(12,2) NOT NULL,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"verified_amount" numeric(12,2),
	"review_note" varchar(500),
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"proof_storage_key" varchar(300),
	"proof_name" varchar(150),
	"proof_uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_declaration_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"declaration_closes_on" date,
	"proof_deadline" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"tax_regime" varchar(4) DEFAULT 'new' NOT NULL,
	"senior_self" boolean DEFAULT false NOT NULL,
	"senior_parents" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tax_declaration_items_declaration_idx" ON "tax_declaration_items" ("declaration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_declaration_settings_org_fy_unique" ON "tax_declaration_settings" ("organization_id","financial_year");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_declarations_employee_fy_unique" ON "tax_declarations" ("user_organization_id","financial_year");--> statement-breakpoint
CREATE INDEX "tax_declarations_org_fy_idx" ON "tax_declarations" ("organization_id","financial_year");--> statement-breakpoint
ALTER TABLE "tax_declaration_items" ADD CONSTRAINT "tax_declaration_items_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "tax_declaration_items" ADD CONSTRAINT "tax_declaration_items_declaration_id_tax_declarations_id_fkey" FOREIGN KEY ("declaration_id") REFERENCES "tax_declarations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tax_declaration_items" ADD CONSTRAINT "tax_declaration_items_reviewed_by_user_id_users_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "tax_declaration_settings" ADD CONSTRAINT "tax_declaration_settings_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");