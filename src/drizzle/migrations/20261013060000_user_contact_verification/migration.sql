ALTER TABLE "users" ADD COLUMN "phone_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Users who have already signed in did so with an OTP, so their phone is verified.
UPDATE "users" SET "phone_verified" = true WHERE "id" IN (SELECT "user_id" FROM "user_sessions");
