import { z } from "zod";
import { PLAN_IDS } from "./app";

// =========================================================================================================
// Phase 8: beta switch, effective plan, account export + deletion, SEO. Written by the lead (2026-11-13).
// =========================================================================================================

// ---------------------------------------------------------------------------------------------------------
// Beta switch (Michel, 2026-11-13: "make the code match the copy")
// ---------------------------------------------------------------------------------------------------------

/**
 * env BETA_ALL_PRO=true (default false; document in .env.example) gives EVERY account Pro limits without changing
 * any stored plan (users.plan / servers.plan stay as they are). The ONE function that applies it:
 *   effectivePlan(stored, betaAllPro) = betaAllPro && stored === "free" ? "pro" : stored   (network stays network)
 * Every limit goes through it (apps/api/src/limits.ts): server count, retention (raw / rollups / incidents / findings),
 * status page branding, Discord alerts, findings level, public uptime windows. Nothing else may read plans[] directly.
 * When the switch is turned off, accounts go back to their stored plan; the normal retention job then trims history
 * older than that plan's retention (no extra code; documented in docs/go-public.md as a decision with dates TODO).
 */
export function effectivePlan(stored: (typeof PLAN_IDS)[number], betaAllPro: boolean): (typeof PLAN_IDS)[number] {
  return betaAllPro && stored === "free" ? "pro" : stored;
}

/**
 * sessionUser (app.ts) gains, additively:
 *   effectivePlan: PlanId — what the limits actually use;
 *   planSource: "stored" | "beta" — "beta" when the switch upgraded this account.
 * `plan` keeps meaning the stored plan. The servers list `limits.plan` becomes the effective plan, plus
 * `limits.planSource`. The account page shows "Pro (beta)" when planSource = "beta", with the note (copy in
 * apps/web/content/phase8-copy.md): when the beta ends, accounts go back to Free unless upgraded (the founding
 * discount applies), we email a warning in advance, and history older than Free's retention is trimmed.
 */
export const sessionUserPhase8Fields = z.object({
  effectivePlan: z.enum(PLAN_IDS),
  planSource: z.enum(["stored", "beta"]),
});

// ---------------------------------------------------------------------------------------------------------
// Account export (GDPR access + portability)
// ---------------------------------------------------------------------------------------------------------

/**
 * GET /api/account/export (session) → 200 application/json, Content-Disposition attachment
 *   "tickdoctor-export-<yyyy-mm-dd>.json", streamed (never builds the whole file in memory). Rate limit 3/hour/user; at most 2 exports run at once (429 + Retry-After 30 above that, the hourly budget is not spent); aborted after 5 min or when the client disconnects.
 * Contents (everything we hold about the user and their servers, in their own words):
 *   exportedAt, schemaVersion 1,
 *   account: email, displayName, createdAt, emailVerifiedAt, consentAt, lastSignupAt, plan (stored), effectivePlan, hasPassword
 *     (never the hash), discord: { linked, discordUserId } , sessions: [{ createdAt, lastUsedAt, expiresAt }] (no ids),
 *   waitlist: [{ email, source, createdAt }] for the same email (if any),
 *   discordPendingSignups: [{ email, discordUserId, createdAt, expiresAt, usedAt }] for the same email (never the token hash),
 *   servers: [{ id, name, slug, plan, createdAt, apiKeys: [{ prefix, createdAt, revokedAt }] (never hashes),
 *     info history, plugin inventory history, status page settings, alert config (webhook MASKED only),
 *     alert deliveries, incidents (+ baseline), findings, events, snapshots, metric rollups (1 h and 1 min),
 *     raw metric samples within retention }].
 *   Never: password hash, session/token hashes, API key hashes, the decrypted webhook URL, other users' data.
 */

// ---------------------------------------------------------------------------------------------------------
// Account deletion (GDPR erasure)
// ---------------------------------------------------------------------------------------------------------

/**
 * DELETE /api/account { confirmEmail, password? } (session, CSRF). confirmEmail must equal the account email
 * (case-insensitive) → else 400 fields.confirmEmail. password required when hasPassword → wrong → 400
 * fields.password (rate-limited like login). Then, in ONE transaction:
 *   every server of the user and ALL their data (samples, rollups, events, snapshots, incidents, findings,
 *   finding links, info/plugin history, API keys, status pages, alert configs + deliveries, analysis state…),
 *   sessions, email tokens, oauth accounts (Discord links), pending Discord signups for that email,
 *   WAITLIST rows with the same email (lowercased), and the user row.
 * After commit: close the user's live streams, clear cookies, send a short "your account was deleted" email (no
 * links, no data), → 200 { ok: true }. A test asserts that after deletion no table contains the user id, any of
 * their server ids, or their email (scan every table with those columns — generated from the schema, so new tables
 * are covered automatically).
 * Deletion is immediate and final (no grace period) — the web UI says so and asks to type the email.
 * Status page slugs are freed. Discord webhook messages already posted stay in Discord (the UI says so).
 */
export const deleteAccountRequest = z.object({
  confirmEmail: z.string().trim().max(254),
  password: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------------------------------------
// SEO + Open Graph
// ---------------------------------------------------------------------------------------------------------

/**
 * Public pages (/, /pricing, /demo, /docs/**, /changelog, /legal/**): unique <title> + description, canonical URL
 * from WEB_PUBLIC_URL, Open Graph + Twitter card tags, an OG image per page type (landing, pricing, docs page with
 * its title, demo, changelog) rendered with the bundled font (no outside requests). robots.txt: allow public pages,
 * disallow /app, /api, /s (status pages stay noindex until go-public), sitemap.xml lists public pages only.
 * /app/** and auth pages: noindex.
 */
