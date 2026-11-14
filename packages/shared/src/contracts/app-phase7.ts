import { z } from "zod";

// =========================================================================================================
// Phase 7: public status pages, badge, demo dataset, docs. Written by the lead (2026-11-13).
// Owner routes: session + owner check (404 for others), CSRF on non-GET. Public routes: no auth, no cookies
// needed, never reveal anything about a server whose status page is off (404, same body as unknown slug).
// =========================================================================================================

// ---------------------------------------------------------------------------------------------------------
// Status page settings (owner)
// ---------------------------------------------------------------------------------------------------------

/** Slug: 3–40 chars, lowercase letters, digits, single hyphens, not starting/ending with "-". */
export const STATUS_SLUG_RE = /^(?!-)(?!.*--)[a-z0-9-]{3,40}(?<!-)$/;
/** Slugs nobody may take (routes, brand, abuse-prone). Compared after lowercasing. */
export const RESERVED_SLUGS = [
  "admin", "api", "app", "badge", "demo", "docs", "help", "login", "logout", "signup", "status", "support",
  "settings", "account", "pricing", "legal", "changelog", "www", "mail", "official", "staff", "mojang", "minecraft",
  "tickdoctor",
] as const;

export const STATUS_THEMES = ["auto", "dark", "light"] as const;

/**
 * Table status_pages (one row per server, created on first PUT): server_id PK/FK cascade, enabled (default false),
 * slug (unique, case-insensitive), title, show_players, show_uptime, show_incidents, theme, timestamps.
 *
 * GET /api/servers/:id/status-page → statusPageSettings (defaults when never saved: enabled false, slug = a free
 *   slug derived from the server name (suggestion only, not reserved until saved), title = server name,
 *   showPlayers true, showUptime true, showIncidents false, theme auto).
 * PUT /api/servers/:id/status-page { …statusPageSettings minus derived fields } → 200 statusPageSettings.
 *   Invalid slug / reserved → 400 fields.slug; taken by another server → 409 conflict (fields.slug).
 *   Changing the slug frees the old one immediately (old URL → 404).
 * Plans: plans[plan].statusPage "branded" → the public page and badge show "Monitored with <brand>" (always);
 *   "custom" → `hideBranding` may be true. Free can't set hideBranding (silently forced false; UI explains).
 */
export const statusPageSettings = z.object({
  enabled: z.boolean(),
  slug: z.string().regex(STATUS_SLUG_RE),
  title: z.string().trim().min(1).max(60),
  showPlayers: z.boolean(),
  showUptime: z.boolean(),
  showIncidents: z.boolean(),
  theme: z.enum(STATUS_THEMES),
  hideBranding: z.boolean(),
  /** Derived, read-only: absolute URLs built from WEB_PUBLIC_URL. */
  publicUrl: z.string(),
  badgeUrl: z.string(),
});
export type StatusPageSettings = z.infer<typeof statusPageSettings>;
export const putStatusPageRequest = statusPageSettings.omit({ publicUrl: true, badgeUrl: true });

// ---------------------------------------------------------------------------------------------------------
// Public status (no auth)
// ---------------------------------------------------------------------------------------------------------

/**
 * Public health is a simplified view of the owner's health state (no internal detail):
 *   healthy → "operational", degraded → "degraded", lagging → "lagging", offline → "offline", waiting → "offline".
 */
export const PUBLIC_STATES = ["operational", "degraded", "lagging", "offline"] as const;

/**
 * GET /api/public/status/:slug → publicStatus, or 404 not_found (unknown slug OR page disabled; identical body).
 *   Cache-Control: public, max-age=30. Rate limit 60/min per IP (429). No cookies read or set.
 * Uptime = share of minutes with at least one sample (from 1-min rollups) over the window, limited to the time since
 *   the server's first sample; null when the window has < 60 minutes of history. Retention may cap 30 d on Free
 *   (rollup1m 3 d → use 1-h rollups for longer windows: an hour counts as up for each of its minutes that had data,
 *   approximated by sample_count / expected samples; document the approximation in code).
 * NEVER included: player names or ids, IPs, plugin lists, findings, API keys, owner identity, exact host metrics.
 */
export const publicStatus = z.object({
  title: z.string(),
  state: z.enum(PUBLIC_STATES),
  lastSeenAt: z.string().nullable(),
  /** Present only when showPlayers. */
  players: z.object({ online: z.number().int(), max: z.number().int().nullable() }).nullable(),
  /** Present only when showUptime. Percent 0–100, one decimal. */
  uptime: z.object({ d1: z.number().nullable(), d7: z.number().nullable(), d30: z.number().nullable() }).nullable(),
  /** Present only when showIncidents: last 30 days, newest first, max 10. No findings, no text from the server. */
  incidents: z
    .array(
      z.object({
        startedAt: z.string(),
        endedAt: z.string().nullable(),
        severity: z.enum(["medium", "high", "critical"]),
        durationSeconds: z.number().int(),
      }),
    )
    .max(10)
    .nullable(),
  theme: z.enum(STATUS_THEMES),
  branding: z.boolean(), // true = show "Monitored with <brand>"
  generatedAt: z.string(),
});
export type PublicStatus = z.infer<typeof publicStatus>;

/**
 * GET /badge/:slug.svg → shields-style SVG (left "minecraft", right state word + players when showPlayers, e.g.
 *   "online · 12 players"; colours = health colours from brand.ts, colour-blind safe with the word always present).
 *   Disabled/unknown slug → 404 with a small grey "unknown" SVG (same for both). Cache-Control: public, max-age=60.
 *   Content-Type image/svg+xml; all text XML-escaped; no external references in the SVG.
 *   Embed snippets in the owner UI: Markdown `[![status](badgeUrl)](publicUrl)` and HTML <a><img></a>.
 * The public page /s/[slug] (web) renders publicStatus; its Open Graph image (/s/[slug]/opengraph-image, 1200×630)
 *   shows title, state (icon + word + colour), players and 7-day uptime. Pages send `noindex` until go-public.
 */

// ---------------------------------------------------------------------------------------------------------
// Demo dataset (Michel: must work with the Mac/Pi offline and once deployed)
// ---------------------------------------------------------------------------------------------------------

/**
 * A fixed, committed JSON file: apps/web/content/demo/dataset.json, produced by `pnpm --filter @tickdoctor/api
 * cli demo:export <serverId> --name "<made-up name>"` from the "Pi (test history)" server (fallback: the seed's
 * demo server). The web /demo pages render ONLY this file (no API calls, no DB), with the same components as
 * the app, read-only.
 * Times are stored RELATIVE: every timestamp is "offsetSeconds" before the export's anchor (the latest sample), and
 *   the web shifts them so the anchor = page render time ("2 hours ago" stays true forever).
 * Cleaning (the exporter enforces it, and a test checks the committed file):
 *   - server name/title replaced by the made-up name; ids replaced by stable fake UUIDs; no owner, no keys;
 *   - no player names, UUIDs, hashes or IPs anywhere (exception/event messages dropped or scrubbed);
 *   - plugin names kept only if public Paper plugins (keep: spark, TickDoctor; others renamed "Plugin A/B…");
 *   - world names kept only if world / world_nether / world_the_end.
 * Contents: server info (software, version, java, view/sim distance, heap, plugin count), 7 days of 1-min rollups
 *   (downsampled to 5-min for days 2–7) for the dashboard metrics, all incidents with their incidentDetail
 *   (computed with the real detail function, then cleaned), all findings (incl. tips), host metrics present.
 */
export const DEMO_DATASET_PATH = "apps/web/content/demo/dataset.json";
export const demoDatasetMeta = z.object({
  schemaVersion: z.literal(1),
  serverName: z.string(),
  exportedFrom: z.enum(["pi-test-history", "seed"]),
  anchorNote: z.string(), // "all times are seconds before the latest sample"
});

// ---------------------------------------------------------------------------------------------------------
// Docs content
// ---------------------------------------------------------------------------------------------------------

/**
 * Docs are Markdown files written by the copywriter in apps/web/content/docs/ and rendered by web-dev with the
 * safe Markdown renderer (no raw HTML):
 *   index.md, install.md, configuration.md, data-and-privacy.md, troubleshooting.md, faq.md,
 *   findings/index.md, findings/<ruleId>.md (one per RULE_IDS entry), plus apps/web/content/changelog.md.
 * Front matter: `title`, `description` (≤ 160 chars, used for <meta> and OG). Internal links are root-relative
 * (/docs/...). Code blocks use fences with a language. Images: none (no Minecraft/Mojang assets).
 */
export const DOCS_PAGES = ["index", "install", "configuration", "data-and-privacy", "troubleshooting", "faq"] as const;
