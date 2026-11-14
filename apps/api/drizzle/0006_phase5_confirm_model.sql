ALTER TABLE "users" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
-- Confirmation model (contract app.ts, 2026-11-10): unconfirmed accounts have no password, no sessions and no
-- magic/reset links. CLI-created users stay unconfirmed; they are claimed through a confirm link.
UPDATE "users" SET "password_hash" = NULL WHERE "email_verified_at" IS NULL;--> statement-breakpoint
DELETE FROM "sessions" s USING "users" u WHERE u."id" = s."user_id" AND u."email_verified_at" IS NULL;--> statement-breakpoint
DELETE FROM "email_tokens" t USING "users" u WHERE u."id" = t."user_id" AND u."email_verified_at" IS NULL AND t."kind" IN ('magic', 'reset');
