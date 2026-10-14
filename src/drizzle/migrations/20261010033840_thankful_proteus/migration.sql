CREATE TABLE "employee_face_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_organization_id" uuid NOT NULL,
	"embedding" jsonb NOT NULL,
	"embedding_dimension" integer NOT NULL,
	"model_name" varchar(64) NOT NULL,
	"model_version" varchar(32) NOT NULL,
	"quality_score" numeric(5,4),
	"enrolled_by_kiosk_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "face_match_score" numeric(5,4);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "liveness_passed" boolean;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "face_template_id" uuid;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "app_version" varchar(32);--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "face_model_name" varchar(64);--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "face_model_version" varchar(32);--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "face_match_threshold" numeric(5,4);--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "require_liveness" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "last_template_sync_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "face_templates_org_active_updated_idx" ON "employee_face_templates" ("organization_id","is_active","updated_at");--> statement-breakpoint
CREATE INDEX "face_templates_employee_idx" ON "employee_face_templates" ("user_organization_id");--> statement-breakpoint
ALTER TABLE "employee_face_templates" ADD CONSTRAINT "employee_face_templates_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "employee_face_templates" ADD CONSTRAINT "face_templates_employee_org_fk" FOREIGN KEY ("organization_id","user_organization_id") REFERENCES "user_organizations"("organization_id","id");--> statement-breakpoint
ALTER TABLE "employee_face_templates" ADD CONSTRAINT "face_templates_kiosk_org_fk" FOREIGN KEY ("organization_id","enrolled_by_kiosk_id") REFERENCES "kiosk_devices"("organization_id","id");