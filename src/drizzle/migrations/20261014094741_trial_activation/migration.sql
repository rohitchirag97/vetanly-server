ALTER TABLE "organizations" ALTER COLUMN "trial_ends_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "trial_ends_at" DROP NOT NULL;