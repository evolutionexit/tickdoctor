CREATE TABLE "status_pages" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"show_players" boolean DEFAULT true NOT NULL,
	"show_uptime" boolean DEFAULT true NOT NULL,
	"show_incidents" boolean DEFAULT false NOT NULL,
	"theme" text DEFAULT 'auto' NOT NULL,
	"hide_branding" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_theme_check" CHECK ("status_pages"."theme" in ('auto', 'dark', 'light'))
);
--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_lower_uq" ON "status_pages" USING btree (lower("slug"));