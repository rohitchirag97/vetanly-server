CREATE TABLE "platform_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(500),
	"currency_code" varchar(3) DEFAULT 'INR' NOT NULL,
	"price_amount" numeric(12,2) DEFAULT '0' NOT NULL,
	"billing_period" varchar(16) DEFAULT 'monthly' NOT NULL,
	"included_employees" integer DEFAULT 0 NOT NULL,
	"overage_price" numeric(12,2) DEFAULT '0' NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_billing_profiles" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" varchar(160) NOT NULL,
	"gstin" varchar(15),
	"address_line1" varchar(200) NOT NULL,
	"address_line2" varchar(200),
	"city" varchar(100) NOT NULL,
	"state" varchar(100) NOT NULL,
	"postal_code" varchar(20) NOT NULL,
	"country" varchar(100) DEFAULT 'India' NOT NULL,
	"email" varchar(254),
	"whatsapp_phone" varchar(20),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_billing_profiles_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "platform_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"starts_at" date DEFAULT now() NOT NULL,
	"next_billing_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_subscriptions_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "platform_subscriptions_plan_id_platform_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform_plans"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "platform_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(40) NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'INR' NOT NULL,
	"subtotal" numeric(12,2) NOT NULL,
	"tax_rate" numeric(5,2) DEFAULT '18' NOT NULL,
	"tax_amount" numeric(12,2) NOT NULL,
	"total_amount" numeric(12,2) NOT NULL,
	"bill_to" jsonb NOT NULL,
	"notes" varchar(1000),
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" date,
	"paid_at" timestamp with time zone,
	"payment_method" varchar(30),
	"payment_reference" varchar(120),
	"whatsapp_status" varchar(16) DEFAULT 'not_sent' NOT NULL,
	"whatsapp_destination" varchar(20),
	"whatsapp_sent_at" timestamp with time zone,
	"whatsapp_error" varchar(500),
	"pdf_storage_key" varchar(300),
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_invoices_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "platform_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" varchar(240) NOT NULL,
	"quantity" numeric(10,2) NOT NULL,
	"unit_price" numeric(12,2) NOT NULL,
	"line_subtotal" numeric(12,2) NOT NULL,
	"line_tax" numeric(12,2) NOT NULL,
	"line_total" numeric(12,2) NOT NULL,
	CONSTRAINT "platform_invoice_items_invoice_id_platform_invoices_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform_invoices"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_plans_name_unique" ON "platform_plans" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_subscriptions_org_unique" ON "platform_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_number_unique" ON "platform_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "platform_invoices_org_created_idx" ON "platform_invoices" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_invoices_status_due_idx" ON "platform_invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "platform_invoice_items_invoice_idx" ON "platform_invoice_items" USING btree ("invoice_id");
