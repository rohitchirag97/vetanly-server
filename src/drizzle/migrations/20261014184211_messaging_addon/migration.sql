CREATE TABLE "message_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"channel" varchar(10) NOT NULL,
	"provider_id" uuid,
	"provider_kind" varchar(16) NOT NULL,
	"message_type" varchar(16) NOT NULL,
	"related_id" uuid,
	"recipient_user_id" uuid,
	"recipient_masked" varchar(80) NOT NULL,
	"test_destination" varchar(20),
	"status" varchar(10) DEFAULT 'queued' NOT NULL,
	"provider_message_id" varchar(200),
	"error" varchar(500),
	"charge" numeric(10,3) DEFAULT '0' NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"name" varchar(80) NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"secrets" jsonb DEFAULT '{}' NOT NULL,
	"webhook_token" varchar(64) NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_settings" (
	"organization_id" uuid PRIMARY KEY,
	"addon_enabled" boolean DEFAULT false NOT NULL,
	"addon_requested_at" timestamp with time zone,
	"whatsapp_provider_id" uuid,
	"balance" numeric(14,3) DEFAULT '0' NOT NULL,
	"low_balance_threshold" numeric(12,2) DEFAULT '100' NOT NULL,
	"low_balance_notified_at" timestamp with time zone,
	"rate_overrides" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"message_type" varchar(16) NOT NULL,
	"template_name" varchar(120) NOT NULL,
	"language" varchar(16) DEFAULT 'en' NOT NULL,
	"params" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_messaging_settings" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"email_rate" numeric(10,3) DEFAULT '0' NOT NULL,
	"whatsapp_hazripro_rate" numeric(10,3) DEFAULT '0.350' NOT NULL,
	"whatsapp_custom_rate" numeric(10,3) DEFAULT '0.050' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_top_up_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"amount" numeric(12,2) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"note" varchar(300),
	"requested_by_user_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"amount" numeric(14,3) NOT NULL,
	"balance_after" numeric(14,3) NOT NULL,
	"message_log_id" uuid,
	"reference" varchar(120),
	"note" varchar(300),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_logs_org_created_idx" ON "message_logs" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "message_logs_provider_message_idx" ON "message_logs" ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messaging_providers_org_idx" ON "messaging_providers" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_providers_webhook_token_unique" ON "messaging_providers" ("webhook_token");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_templates_provider_type_unique" ON "messaging_templates" ("provider_id","message_type");--> statement-breakpoint
CREATE INDEX "wallet_top_up_requests_status_idx" ON "wallet_top_up_requests" ("status");--> statement-breakpoint
CREATE INDEX "wallet_transactions_org_created_idx" ON "wallet_transactions" ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "messaging_providers" ADD CONSTRAINT "messaging_providers_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "messaging_templates" ADD CONSTRAINT "messaging_templates_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "messaging_templates" ADD CONSTRAINT "messaging_templates_provider_id_messaging_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "messaging_providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wallet_top_up_requests" ADD CONSTRAINT "wallet_top_up_requests_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
-- The single platform-wide rates row.
INSERT INTO "platform_messaging_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
