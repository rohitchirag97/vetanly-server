CREATE TABLE "platform_plan_offers" (
	"plan_id" uuid,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_plan_offers_pkey" PRIMARY KEY("plan_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "platform_plans" ADD COLUMN "visibility" varchar(16) DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE INDEX "platform_plan_offers_org_idx" ON "platform_plan_offers" ("organization_id");--> statement-breakpoint
ALTER TABLE "platform_plan_offers" ADD CONSTRAINT "platform_plan_offers_plan_id_platform_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform_plan_offers" ADD CONSTRAINT "platform_plan_offers_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;