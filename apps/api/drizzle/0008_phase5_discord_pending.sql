CREATE TABLE "discord_pending_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"email" text NOT NULL,
	"next" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "discord_pending_signups_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "discord_pending_signups_email_lowercase" CHECK ("discord_pending_signups"."email" = lower("discord_pending_signups"."email"))
);
--> statement-breakpoint
CREATE INDEX "discord_pending_signups_expires_idx" ON "discord_pending_signups" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "discord_pending_signups_discord_idx" ON "discord_pending_signups" USING btree ("discord_user_id");