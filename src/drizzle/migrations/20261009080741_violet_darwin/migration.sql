CREATE TABLE "attendance_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"kiosk_id" uuid,
	"event_type" varchar(16) NOT NULL,
	"source" varchar(16) DEFAULT 'kiosk' NOT NULL,
	"face_verification_status" varchar(24) DEFAULT 'not_applicable' NOT NULL,
	"external_event_id" varchar(100),
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"device_identifier" varchar(100) NOT NULL,
	"name" varchar(100) NOT NULL,
	"location_name" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_logs_kiosk_external_event_unique" ON "attendance_logs" ("kiosk_id","external_event_id");--> statement-breakpoint
CREATE INDEX "attendance_logs_org_employee_occurred_idx" ON "attendance_logs" ("organization_id","user_organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "attendance_logs_org_occurred_idx" ON "attendance_logs" ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_devices_org_id_id_unique" ON "kiosk_devices" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_devices_org_identifier_unique" ON "kiosk_devices" ("organization_id","device_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "user_organizations_org_id_id_unique" ON "user_organizations" ("organization_id","id");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_kiosk_org_fk" FOREIGN KEY ("organization_id","kiosk_id") REFERENCES "kiosk_devices"("organization_id","id");--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");