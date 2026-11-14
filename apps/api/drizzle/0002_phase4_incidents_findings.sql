CREATE TABLE "finding_incidents" (
	"finding_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	CONSTRAINT "finding_incidents_finding_id_incident_id_pk" PRIMARY KEY("finding_id","incident_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"scope" text NOT NULL,
	"dedup_key" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggested_fix" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"marked_fixed_at" timestamp with time zone,
	"confirmed_fixed_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_status_check" CHECK ("findings"."status" in ('open', 'marked_fixed', 'confirmed_fixed')),
	CONSTRAINT "findings_scope_check" CHECK ("findings"."scope" in ('incident', 'server')),
	CONSTRAINT "findings_severity_check" CHECK ("findings"."severity" in ('info', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "findings_resolved_by_check" CHECK ("findings"."resolved_by" in ('owner', 'auto')),
	CONSTRAINT "findings_occurrence_check" CHECK ("findings"."occurrence_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"severity" text NOT NULL,
	"peak_mspt_p95" double precision NOT NULL,
	"source" text NOT NULL,
	"baseline" jsonb,
	"rules_evaluated_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"snapshot_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_end_reason_check" CHECK ("incidents"."end_reason" in ('recovered', 'offline')),
	CONSTRAINT "incidents_severity_check" CHECK ("incidents"."severity" in ('medium', 'high', 'critical')),
	CONSTRAINT "incidents_source_check" CHECK ("incidents"."source" in ('raw', 'rollup_1m')),
	CONSTRAINT "incidents_end_consistent" CHECK (("incidents"."ended_at" is null) = ("incidents"."end_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "server_analysis_state" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"detector_watermark" timestamp with time zone,
	"streak_start" timestamp with time zone,
	"streak_peak" double precision,
	"server_rules_at" timestamp with time zone,
	"last_hello_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_incidents" ADD CONSTRAINT "finding_incidents_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_incidents" ADD CONSTRAINT "finding_incidents_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_analysis_state" ADD CONSTRAINT "server_analysis_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_incidents_incident_idx" ON "finding_incidents" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_active_uq" ON "findings" USING btree ("server_id","rule_id","dedup_key") WHERE "findings"."status" <> 'confirmed_fixed';--> statement-breakpoint
CREATE INDEX "findings_server_seen_idx" ON "findings" USING btree ("server_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "findings_active_status_idx" ON "findings" USING btree ("status","scope") WHERE "findings"."status" <> 'confirmed_fixed';--> statement-breakpoint
CREATE INDEX "findings_confirmed_idx" ON "findings" USING btree ("confirmed_fixed_at");--> statement-breakpoint
CREATE INDEX "incidents_server_started_idx" ON "incidents" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_server_uq" ON "incidents" USING btree ("server_id") WHERE "incidents"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "incidents_ended_idx" ON "incidents" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "incidents_rules_pending_idx" ON "incidents" USING btree ("closed_at") WHERE "incidents"."rules_evaluated_at" is null or "incidents"."rules_evaluated_at" < "incidents"."closed_at";--> statement-breakpoint
ALTER TABLE "incident_snapshots" ADD CONSTRAINT "incident_snapshots_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;