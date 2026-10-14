ALTER TABLE "organizations" ALTER COLUMN "name" SET DATA TYPE varchar(52) USING "name"::varchar(52);--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "slug" SET DATA TYPE varchar(52) USING "slug"::varchar(52);--> statement-breakpoint
ALTER TABLE "user_organizations" ALTER COLUMN "role" SET DATA TYPE varchar(52) USING "role"::varchar(52);--> statement-breakpoint
ALTER TABLE "user_organizations" ALTER COLUMN "role" SET DEFAULT 'employee';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "fname" SET DATA TYPE varchar(52) USING "fname"::varchar(52);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "lname" SET DATA TYPE varchar(52) USING "lname"::varchar(52);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone" SET DATA TYPE varchar(15) USING "phone"::varchar(15);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_key" UNIQUE("phone");