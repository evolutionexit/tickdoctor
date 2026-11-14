CREATE TABLE "alert_configs" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"webhook_enc" text,
	"webhook_masked" text,
	"webhook_status" text DEFAULT 'none' NOT NULL,
	"events" jsonb NOT NULL,
	"min_severity" text DEFAULT 'medium' NOT NULL,
	"offline_after_minutes" integer DEFAULT 5 NOT NULL,
	"cooldown_minutes" integer DEFAULT 30 NOT NULL,
	"quiet_hours" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_configs_status_check" CHECK ("alert_configs"."webhook_status" in ('none', 'ok', 'invalid', 'untested')),
	CONSTRAINT "alert_configs_min_severity_check" CHECK ("alert_configs"."min_severity" in ('medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"incident_id" uuid,
	"source_event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_event_check" CHECK ("alert_deliveries"."event" in ('incident_opened', 'incident_resolved', 'server_offline', 'server_back', 'crash', 'test')),
	CONSTRAINT "alert_deliveries_status_check" CHECK ("alert_deliveries"."status" in ('sent', 'failed', 'suppressed_cooldown', 'suppressed_quiet', 'suppressed_disabled'))
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "initial_severity" text;--> statement-breakpoint
ALTER TABLE "alert_configs" ADD CONSTRAINT "alert_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_server_created_idx" ON "alert_deliveries" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_deliveries_incident_idx" ON "alert_deliveries" USING btree ("incident_id","event");--> statement-breakpoint
CREATE INDEX "alert_deliveries_created_idx" ON "alert_deliveries" USING btree ("created_at");