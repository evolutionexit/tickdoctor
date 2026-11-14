ALTER TABLE "users" ADD COLUMN "last_signup_at" timestamp with time zone;--> statement-breakpoint
-- Re-review (contract b0964f3): pending (unconfirmed) users hold nothing session-like: no oauth links, sessions,
-- passwords or magic/reset tokens. last_signup_at backfilled from the provisional consent time.
UPDATE "users" SET "last_signup_at" = "consent_at" WHERE "email_verified_at" IS NULL AND "consent_at" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "password_hash" = NULL WHERE "email_verified_at" IS NULL;--> statement-breakpoint
DELETE FROM "oauth_accounts" o USING "users" u WHERE u."id" = o."user_id" AND u."email_verified_at" IS NULL;--> statement-breakpoint
DELETE FROM "sessions" s USING "users" u WHERE u."id" = s."user_id" AND u."email_verified_at" IS NULL;--> statement-breakpoint
DELETE FROM "email_tokens" t USING "users" u WHERE u."id" = t."user_id" AND u."email_verified_at" IS NULL AND t."kind" IN ('magic', 'reset');
