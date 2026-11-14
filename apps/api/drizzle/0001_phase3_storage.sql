CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"event_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"incident_id" uuid,
	"trigger" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mspt_p95_at_trigger" double precision NOT NULL,
	"snapshot" jsonb NOT NULL,
	"baseline" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_state" (
	"name" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_rollups_1h" (
	"server_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"tps_1m_avg" double precision,
	"tps_1m_min" double precision,
	"tps_1m_max" double precision,
	"mspt_avg_avg" double precision,
	"mspt_avg_min" double precision,
	"mspt_avg_max" double precision,
	"mspt_p95_avg" double precision,
	"mspt_p95_min" double precision,
	"mspt_p95_max" double precision,
	"mspt_p99_avg" double precision,
	"mspt_p99_min" double precision,
	"mspt_p99_max" double precision,
	"mspt_max_avg" double precision,
	"mspt_max_min" double precision,
	"mspt_max_max" double precision,
	"slow_ticks_avg" double precision,
	"slow_ticks_min" double precision,
	"slow_ticks_max" double precision,
	"players_avg" double precision,
	"players_min" double precision,
	"players_max" double precision,
	"ping_avg_avg" double precision,
	"ping_avg_min" double precision,
	"ping_avg_max" double precision,
	"heap_used_bytes_avg" double precision,
	"heap_used_bytes_min" double precision,
	"heap_used_bytes_max" double precision,
	"heap_max_bytes_avg" double precision,
	"heap_max_bytes_min" double precision,
	"heap_max_bytes_max" double precision,
	"gc_pause_ms_avg" double precision,
	"gc_pause_ms_min" double precision,
	"gc_pause_ms_max" double precision,
	"process_cpu_avg" double precision,
	"process_cpu_min" double precision,
	"process_cpu_max" double precision,
	"loaded_chunks_avg" double precision,
	"loaded_chunks_min" double precision,
	"loaded_chunks_max" double precision,
	"entities_avg" double precision,
	"entities_min" double precision,
	"entities_max" double precision,
	"tile_entities_avg" double precision,
	"tile_entities_min" double precision,
	"tile_entities_max" double precision,
	"chunk_gen_per_min_avg" double precision,
	"chunk_gen_per_min_min" double precision,
	"chunk_gen_per_min_max" double precision,
	"host_cpu_avg" double precision,
	"host_cpu_min" double precision,
	"host_cpu_max" double precision,
	"cpu_temp_c_avg" double precision,
	"cpu_temp_c_min" double precision,
	"cpu_temp_c_max" double precision,
	"mem_available_bytes_avg" double precision,
	"mem_available_bytes_min" double precision,
	"mem_available_bytes_max" double precision,
	"swap_used_bytes_avg" double precision,
	"swap_used_bytes_min" double precision,
	"swap_used_bytes_max" double precision,
	"disk_used_bytes_avg" double precision,
	"disk_used_bytes_min" double precision,
	"disk_used_bytes_max" double precision,
	"agent_ms_per_tick_avg" double precision,
	"agent_ms_per_tick_min" double precision,
	"agent_ms_per_tick_max" double precision,
	CONSTRAINT "metric_rollups_1h_server_id_bucket_pk" PRIMARY KEY("server_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "metric_rollups_1m" (
	"server_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"tps_1m_avg" double precision,
	"tps_1m_min" double precision,
	"tps_1m_max" double precision,
	"mspt_avg_avg" double precision,
	"mspt_avg_min" double precision,
	"mspt_avg_max" double precision,
	"mspt_p95_avg" double precision,
	"mspt_p95_min" double precision,
	"mspt_p95_max" double precision,
	"mspt_p99_avg" double precision,
	"mspt_p99_min" double precision,
	"mspt_p99_max" double precision,
	"mspt_max_avg" double precision,
	"mspt_max_min" double precision,
	"mspt_max_max" double precision,
	"slow_ticks_avg" double precision,
	"slow_ticks_min" double precision,
	"slow_ticks_max" double precision,
	"players_avg" double precision,
	"players_min" double precision,
	"players_max" double precision,
	"ping_avg_avg" double precision,
	"ping_avg_min" double precision,
	"ping_avg_max" double precision,
	"heap_used_bytes_avg" double precision,
	"heap_used_bytes_min" double precision,
	"heap_used_bytes_max" double precision,
	"heap_max_bytes_avg" double precision,
	"heap_max_bytes_min" double precision,
	"heap_max_bytes_max" double precision,
	"gc_pause_ms_avg" double precision,
	"gc_pause_ms_min" double precision,
	"gc_pause_ms_max" double precision,
	"process_cpu_avg" double precision,
	"process_cpu_min" double precision,
	"process_cpu_max" double precision,
	"loaded_chunks_avg" double precision,
	"loaded_chunks_min" double precision,
	"loaded_chunks_max" double precision,
	"entities_avg" double precision,
	"entities_min" double precision,
	"entities_max" double precision,
	"tile_entities_avg" double precision,
	"tile_entities_min" double precision,
	"tile_entities_max" double precision,
	"chunk_gen_per_min_avg" double precision,
	"chunk_gen_per_min_min" double precision,
	"chunk_gen_per_min_max" double precision,
	"host_cpu_avg" double precision,
	"host_cpu_min" double precision,
	"host_cpu_max" double precision,
	"cpu_temp_c_avg" double precision,
	"cpu_temp_c_min" double precision,
	"cpu_temp_c_max" double precision,
	"mem_available_bytes_avg" double precision,
	"mem_available_bytes_min" double precision,
	"mem_available_bytes_max" double precision,
	"swap_used_bytes_avg" double precision,
	"swap_used_bytes_min" double precision,
	"swap_used_bytes_max" double precision,
	"disk_used_bytes_avg" double precision,
	"disk_used_bytes_min" double precision,
	"disk_used_bytes_max" double precision,
	"agent_ms_per_tick_avg" double precision,
	"agent_ms_per_tick_min" double precision,
	"agent_ms_per_tick_max" double precision,
	CONSTRAINT "metric_rollups_1m_server_id_bucket_pk" PRIMARY KEY("server_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tps_1m" double precision,
	"mspt_avg" double precision,
	"mspt_p95" double precision,
	"mspt_p99" double precision,
	"mspt_max" double precision,
	"slow_ticks" integer,
	"players" integer,
	"ping_avg" double precision,
	"heap_used_bytes" bigint,
	"heap_max_bytes" bigint,
	"gc_pause_ms" double precision,
	"process_cpu" double precision,
	"loaded_chunks" integer,
	"entities" integer,
	"tile_entities" integer,
	"chunk_gen_per_min" double precision,
	"host_cpu" double precision,
	"cpu_temp_c" double precision,
	"mem_available_bytes" bigint,
	"swap_used_bytes" bigint,
	"disk_used_bytes" bigint,
	"agent_ms_per_tick" double precision,
	"detail" jsonb NOT NULL,
	CONSTRAINT "metric_samples_server_id_ts_pk" PRIMARY KEY("server_id","ts")
);
--> statement-breakpoint
CREATE TABLE "plugin_inventory_history" (
	"server_id" uuid NOT NULL,
	"plugin" text NOT NULL,
	"version" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_inventory_history_server_id_plugin_version_pk" PRIMARY KEY("server_id","plugin","version")
);
--> statement-breakpoint
CREATE TABLE "server_info_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"info" jsonb NOT NULL,
	"info_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"boot_id" uuid,
	"snapshot_requested_at" timestamp with time zone,
	CONSTRAINT "servers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "servers_plan_check" CHECK ("servers"."plan" in ('free', 'pro', 'network'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_snapshots" ADD CONSTRAINT "incident_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups_1h" ADD CONSTRAINT "metric_rollups_1h_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups_1m" ADD CONSTRAINT "metric_rollups_1m_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_inventory_history" ADD CONSTRAINT "plugin_inventory_history_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_info_history" ADD CONSTRAINT "server_info_history_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_server_idx" ON "api_keys" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_server_hash_uq" ON "events" USING btree ("server_id","event_hash");--> statement-breakpoint
CREATE INDEX "events_server_ts_idx" ON "events" USING btree ("server_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_snapshots_server_captured_uq" ON "incident_snapshots" USING btree ("server_id","captured_at");--> statement-breakpoint
CREATE INDEX "incident_snapshots_incident_idx" ON "incident_snapshots" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "metric_samples_received_idx" ON "metric_samples" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "server_info_history_server_idx" ON "server_info_history" USING btree ("server_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "server_info_history_current_uq" ON "server_info_history" USING btree ("server_id") WHERE "server_info_history"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "servers_owner_idx" ON "servers" USING btree ("owner_id");