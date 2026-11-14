ALTER TABLE "incidents" ADD COLUMN "min_tps_1m" double precision;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "trigger" text DEFAULT 'mspt' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_analysis_state" ADD COLUMN "tps_streak_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_analysis_state" ADD COLUMN "tps_streak_min" double precision;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_trigger_check" CHECK ("incidents"."trigger" in ('mspt', 'tps'));