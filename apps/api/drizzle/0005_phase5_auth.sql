CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"next" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "email_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "email_tokens_kind_check" CHECK ("email_tokens"."kind" in ('verify', 'magic', 'reset'))
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_accounts_provider_check" CHECK ("oauth_accounts"."provider" in ('discord'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "first_hello_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "first_sample_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_sample_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_tokens_user_idx" ON "email_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "email_tokens_expires_idx" ON "email_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_provider_user_uq" ON "oauth_accounts" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_user_provider_uq" ON "oauth_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_check" CHECK ("users"."plan" in ('free', 'pro', 'network'));--> statement-breakpoint
-- Backfill (Phase 5): onboarding/health timestamps from existing data, and each existing user's plan from their servers.
UPDATE "servers" s SET "first_hello_at" = (SELECT min(h."valid_from") FROM "server_info_history" h WHERE h."server_id" = s."id");--> statement-breakpoint
UPDATE "servers" s SET
	"first_sample_at" = least(
		(SELECT min(m."ts") FROM "metric_samples" m WHERE m."server_id" = s."id"),
		(SELECT min(r."bucket") FROM "metric_rollups_1m" r WHERE r."server_id" = s."id"),
		(SELECT min(r."bucket") FROM "metric_rollups_1h" r WHERE r."server_id" = s."id")),
	"last_sample_at" = (SELECT max(m."received_at") FROM "metric_samples" m WHERE m."server_id" = s."id");--> statement-breakpoint
UPDATE "users" u SET "plan" = CASE
	WHEN EXISTS (SELECT 1 FROM "servers" s WHERE s."owner_id" = u."id" AND s."plan" = 'network') THEN 'network'
	WHEN EXISTS (SELECT 1 FROM "servers" s WHERE s."owner_id" = u."id" AND s."plan" = 'pro') THEN 'pro'
	ELSE 'free' END;
