-- HazriPro -> Vetanly rebrand: rename the stored provider identifier and its rate column.
ALTER TABLE "platform_messaging_settings" RENAME COLUMN "whatsapp_hazripro_rate" TO "whatsapp_vetanly_rate";--> statement-breakpoint
UPDATE "messaging_providers" SET "kind" = 'vetanly' WHERE "kind" = 'hazripro';--> statement-breakpoint
UPDATE "messaging_providers" SET "name" = 'Vetanly WhatsApp' WHERE "name" = 'HazriPro WhatsApp';--> statement-breakpoint
UPDATE "message_logs" SET "provider_kind" = 'vetanly' WHERE "provider_kind" = 'hazripro';--> statement-breakpoint
UPDATE "messaging_settings"
SET "rate_overrides" = ("rate_overrides" - 'whatsappHazripro') || jsonb_build_object('whatsappVetanly', "rate_overrides" -> 'whatsappHazripro')
WHERE "rate_overrides" ? 'whatsappHazripro';
