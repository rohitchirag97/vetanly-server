ALTER TABLE "organizations" ADD COLUMN "trial_ends_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "upgrade_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN "paid_until" date;