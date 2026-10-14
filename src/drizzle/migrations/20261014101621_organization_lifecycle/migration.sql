ALTER TABLE "organizations" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;