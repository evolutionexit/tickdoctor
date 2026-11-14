import { sql } from "drizzle-orm";
import { RESERVED_SLUGS, STATUS_SLUG_RE, brand, type StatusPageSettings } from "@tickdoctor/shared";
import { rows, type Exec } from "../db/query.js";
import { planOf } from "../limits.js";
import { slugify } from "../servers.js";

// Phase 7 status page settings (contract app-phase7.ts). One row per server in status_pages, created on the first
// PUT; before that GET answers defaults with a suggested (not reserved) slug.

export type StoredSettings = Omit<StatusPageSettings, "publicUrl" | "badgeUrl">;

const RESERVED = new Set<string>(RESERVED_SLUGS);
/** Brand words nobody may use as the first or last hyphen-separated part of a slug (tickdoctor-status, mojang-official). */
export const BRAND_TOKENS = new Set(["tickdoctor", "mojang", "minecraft", brand.name.toLowerCase().replace(/[^a-z0-9]/g, "")]);

/** Control characters and bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069) are removed from titles. */
export function stripControls(s: string): string {
  return s.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "");
}

/** Slug rules (shape + reserved list), after lower-casing. Returns an error message or null. */
export function slugProblem(slug: string): string | null {
  if (!STATUS_SLUG_RE.test(slug)) {
    return "Use 3–40 lowercase letters, digits and single hyphens (not at the start or end)";
  }
  const lower = slug.toLowerCase();
  const parts = lower.split("-");
  if (RESERVED.has(lower) || BRAND_TOKENS.has(parts[0]!) || BRAND_TOKENS.has(parts[parts.length - 1]!)) {
    return "This address is reserved, please pick another one";
  }
  return null;
}

/** Whether the server's plan may hide "Monitored with <brand>". */
export const canHideBranding = (plan: string) => planOf(plan).statusPage === "custom";

/** Shapes a name into a slug candidate that passes STATUS_SLUG_RE and isn't reserved (uniqueness is separate). */
export function slugBase(name: string): string {
  let s = slugify(name).replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (s.length < 3) s = s ? `${s}-server` : "my-server";
  if (slugProblem(s)) s = `${s}-server`.slice(0, 40).replace(/-+$/, "");
  if (slugProblem(s)) s = `my-${s}`.slice(0, 40).replace(/-+$/, "");
  if (slugProblem(s)) s = "my-server";
  return s.slice(0, 40).replace(/-+$/, "");
}

const withSuffix = (base: string, n: number) => {
  const suffix = `-${n}`;
  return `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
};

/** A free slug derived from the server name (suggestion only: nothing is reserved until saved). */
export async function suggestSlug(db: Exec, name: string, serverId: string): Promise<string> {
  const base = slugBase(name);
  const taken = new Set(
    (
      await rows<{ slug: string }>(
        db,
        sql`select lower(slug) as slug from status_pages where server_id <> ${serverId} and lower(slug) like ${`${base.slice(0, 30)}%`}`,
      )
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const c = withSuffix(base, n);
    if (!taken.has(c)) return c;
  }
  return withSuffix(base, Date.now() % 1_000_000);
}

interface Row {
  enabled: boolean;
  slug: string;
  title: string;
  show_players: boolean;
  show_uptime: boolean;
  show_incidents: boolean;
  theme: StatusPageSettings["theme"];
  hide_branding: boolean;
}

/** Saved settings (hideBranding = effective value under the current plan), or defaults when never saved. */
export async function loadSettings(db: Exec, serverId: string): Promise<{ settings: StoredSettings; saved: boolean }> {
  const [s] = await rows<{ name: string; plan: string }>(db, sql`select name, plan from servers where id = ${serverId}`);
  if (!s) throw new Error("server not found");
  const [r] = await rows<Row>(
    db,
    sql`select enabled, slug, title, show_players, show_uptime, show_incidents, theme, hide_branding
          from status_pages where server_id = ${serverId}`,
  );
  if (r) {
    return {
      saved: true,
      settings: {
        enabled: r.enabled,
        slug: r.slug,
        title: r.title,
        showPlayers: r.show_players,
        showUptime: r.show_uptime,
        showIncidents: r.show_incidents,
        theme: r.theme,
        hideBranding: r.hide_branding && canHideBranding(s.plan),
      },
    };
  }
  return {
    saved: false,
    settings: {
      enabled: false,
      slug: await suggestSlug(db, s.name, serverId),
      title: s.name.trim().slice(0, 60) || "My server",
      showPlayers: true,
      showUptime: true,
      showIncidents: false,
      theme: "auto",
      hideBranding: false,
    },
  };
}

/** Adds the derived absolute URLs (webOrigin = the normalised WEB_PUBLIC_URL, no trailing slash). */
export function withUrls(s: StoredSettings, webOrigin: string): StatusPageSettings {
  return {
    ...s,
    publicUrl: `${webOrigin}/s/${s.slug}`,
    badgeUrl: `${webOrigin}/badge/${s.slug}.svg`,
  };
}

export type SaveResult = "ok" | "slug_taken";

/** Upserts the row. Slug uniqueness is enforced by the unique index on lower(slug) (race-safe). */
export async function saveSettings(db: Exec, serverId: string, s: StoredSettings, nowMs: number): Promise<SaveResult> {
  const [taken] = await rows(db, sql`select 1 from status_pages where lower(slug) = ${s.slug.toLowerCase()} and server_id <> ${serverId}`);
  if (taken) return "slug_taken";
  const now = new Date(nowMs).toISOString();
  try {
    await db.execute(sql`
      insert into status_pages (server_id, enabled, slug, title, show_players, show_uptime, show_incidents, theme, hide_branding, created_at, updated_at)
      values (${serverId}, ${s.enabled}, ${s.slug.toLowerCase()}, ${s.title}, ${s.showPlayers}, ${s.showUptime}, ${s.showIncidents},
              ${s.theme}, ${s.hideBranding}, ${now}::timestamptz, ${now}::timestamptz)
      on conflict (server_id) do update set enabled = excluded.enabled, slug = excluded.slug, title = excluded.title,
             show_players = excluded.show_players, show_uptime = excluded.show_uptime, show_incidents = excluded.show_incidents,
             theme = excluded.theme, hide_branding = excluded.hide_branding, updated_at = excluded.updated_at`);
  } catch (err) {
    if (isUniqueViolation(err)) return "slug_taken";
    throw err;
  }
  return "ok";
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
