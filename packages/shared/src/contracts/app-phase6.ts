import { z } from "zod";
import { finding, type Finding } from "./findings";
import { incidentListItem } from "./app";

// =========================================================================================================
// Phase 6 app API: incidents UI, findings, mark fixed, Discord alerts. Written by the lead (2026-11-10).
// Same rules as app.ts: same-origin /api, session + owner check (404 for other users' objects, never 403),
// CSRF on every non-GET, errors { error: { code, message, fields? } }.
// =========================================================================================================

// ---------------------------------------------------------------------------------------------------------
// Tuning tips (Michel, 2026-11-10)
// ---------------------------------------------------------------------------------------------------------

/**
 * A finding with severity "info" is a TUNING TIP (today: jvm-flags xms-ne-xmx and aikar-flags-missing). Tips are true
 * but don't cause lag, so:
 *   - they are listed only in a separate "Tuning tips" section (findings page, dashboard), never among incident causes;
 *   - the incident endpoint never returns them in `findings` (a jvm-flags finding at severity ≥ low, e.g. heap too
 *     small during GC pressure, is a cause, not a tip, and does appear);
 *   - they never trigger or appear in alerts;
 *   - they are excluded from the server card's top finding (already true since Phase 5).
 * This predicate is the ONLY definition; API and web both import it.
 */
export function isTuningTip(f: Pick<Finding, "severity">): boolean {
  return f.severity === "info";
}

/** Impact order for lists: severity desc, then still-open before marked_fixed, then lastSeenAt desc. */
export const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;

// ---------------------------------------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------------------------------------

/**
 * GET /api/servers/:id/incidents (Phase 5) stays as is; it also accepts `status=open|closed` and returns each item
 * with `findingCount` (non-tip findings linked to it) and `topFindingTitle` (highest impact non-tip, or null).
 */
export const incidentListItemV6 = incidentListItem.extend({
  findingCount: z.number().int(),
  topFindingTitle: z.string().nullable(),
});

/**
 * PLAN GATING (Michel, 2026-11-14, F-04 "teaser"): plans.findings "basic" (Free) shows that something is wrong and how
 * severe; "all" (Pro / Network, and everyone while BETA_ALL_PRO is on) shows why. For a locked finding the API OMITS
 * `explanation`, `evidence`, `suggestedFix` and `dedupKey` (they are not sent at all) and sets `locked: true`,
 * `lockedReason: "plan"`. Title, severity, status, ruleId, times and counts stay. Tuning tips (isTuningTip) are never
 * locked. Old clients keep parsing: the new fields are optional.
 */
export const findingView = finding
  .omit({ explanation: true, evidence: true, suggestedFix: true, dedupKey: true })
  .extend({
    dedupKey: finding.shape.dedupKey.optional(),
    explanation: finding.shape.explanation.optional(),
    evidence: finding.shape.evidence.optional(),
    suggestedFix: finding.shape.suggestedFix.optional(),
    locked: z.boolean().optional(),
    lockedReason: z.literal("plan").optional(),
  });
export type FindingView = z.infer<typeof findingView>;

/**
 * "What changed?" — computed by the API (pure function, apps/api/src/incidents/what-changed.ts, unit-tested) from the
 * incident's baseline vs. what the server looked like DURING the incident (snapshot if linked, else the incident's
 * raw samples / 1-min rollups). Items:
 *   - metric: MSPT p95/avg, TPS, players, loaded chunks, entities, tile entities, heap used, GC time, CPU, temp,
 *     swap — during = median over the incident window (TPS: min), usual = baseline median.
 *   - entityType / tileEntityType: per type, during (snapshot) vs usual (baseline medians); only types with
 *     during ≥ 50 or usual ≥ 50.
 *   - world: per world loaded chunks / entities.
 *   - plugin: added / removed / updated (version) between the baseline window end and the incident start.
 *   - config: view/simulation distance changes. jvm: heap max/init changes.
 * `notable` = |during/usual| ≥ 1.5× (or ≤ 0.67× for TPS-like), or any plugin/config/jvm change. Sorted: notable
 * first, then by ratio distance from 1. Max 40 items. baseline null → baselineAvailable false and only absolute
 * items (during values, usual null) + plugin changes from plugin history.
 */
export const whatChangedItem = z.object({
  kind: z.enum(["metric", "entityType", "tileEntityType", "world", "plugin", "config", "jvm"]),
  key: z.string().max(200), // e.g. "mspt_p95", "minecraft:villager", "world", "Essentials"
  label: z.string().max(200), // human label, e.g. "Villagers", "Tick time (slowest 5 %)"
  during: z.union([z.number(), z.string().max(100)]).nullable(),
  usual: z.union([z.number(), z.string().max(100)]).nullable(),
  unit: z.string().max(20).optional(),
  change: z.enum(["up", "down", "same", "added", "removed", "updated", "changed"]),
  /** during / usual when both are numbers and usual > 0. */
  ratio: z.number().nullable(),
  notable: z.boolean(),
});
export const whatChanged = z.object({
  baselineAvailable: z.boolean(),
  healthyMinutes: z.number().int(),
  baselineFrom: z.string().nullable(),
  baselineTo: z.string().nullable(),
  items: z.array(whatChangedItem).max(40),
});

/** Worst chunks across worlds from the linked snapshot, ranked by entities + tile entities (max 10). */
export const incidentChunk = z.object({
  world: z.string(),
  x: z.number().int(),
  z: z.number().int(),
  entities: z.number().int(),
  tileEntities: z.number().int(),
  /** Top 5 types in that chunk, count desc. */
  topTypes: z.array(z.object({ type: z.string(), count: z.number().int() })).max(5),
});

/** Timeline entries in [startedAt − 30 min, endedAt (or now)], oldest first, max 100. */
export const incidentTimelineEntry = z.object({
  ts: z.string(),
  kind: z.enum([
    "incident_opened",
    "incident_closed",
    "snapshot",
    "severity_raised", // reserved: not emitted (only initial + current severity are stored)
    "plugin_added",
    "plugin_removed",
    "plugin_updated",
    "server_start",
    "crash",
    "config_changed",
  ]),
  label: z.string().max(300), // plain words, e.g. "Plugin Essentials updated 2.20 → 2.21"
});

/**
 * GET /api/incidents/:id → 200 incidentDetail (404 when not the owner's).
 * findings = non-tip findings linked to this incident, impact order. Player names never appear (none are stored).
 */
export const incidentDetail = z.object({
  incident: incidentListItemV6.extend({
    serverId: z.string().uuid(),
    endReason: z.enum(["recovered", "offline"]).nullable(),
    source: z.enum(["raw", "rollup_1m"]),
    durationSeconds: z.number().int(), // to endedAt or now
  }),
  snapshot: z
    .object({
      capturedAt: z.string(),
      trigger: z.enum(["threshold", "manual", "requested"]),
      msptP95AtTrigger: z.number(),
      players: z.number().int().nullable(),
      worlds: z.array(
        z.object({
          name: z.string(),
          loadedChunks: z.number().int().nullable(),
          entities: z.number().int(),
          tileEntities: z.number().int(),
        }),
      ),
      /** Omitted when the plan locks it (see findingView). */
      worstChunks: z.array(incidentChunk).max(10).optional(),
    })
    .nullable(),
  /** Omitted when locked. Locked also drops the timeline's plugin_* / config_changed entries (they are "what changed"). */
  whatChanged: whatChanged.optional(),
  findings: z.array(findingView),
  locked: z.boolean().optional(),
  lockedReason: z.literal("plan").optional(),
  timeline: z.array(incidentTimelineEntry).max(100),
});
export type IncidentDetail = z.infer<typeof incidentDetail>;

// ---------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------

/**
 * GET /api/servers/:id/findings?status=active|open|marked_fixed|confirmed_fixed|all (default active = open +
 * marked_fixed) &severity=<min severity>&ruleId=<id> → { findings, tuningTips }
 *   findings   = non-tip findings matching the filters, impact order (SEVERITY_RANK), max 200;
 *   tuningTips = tips (isTuningTip) matching `status` only (other filters ignored), max 20.
 */
export const findingsListResponse = z.object({ findings: z.array(findingView), tuningTips: z.array(findingView) });

/** GET /api/findings/:id → { finding, incidents: IncidentListItem[] (the linked ones, newest first, max 50) }. */
export const findingDetailResponse = z.object({ finding: findingView, incidents: z.array(incidentListItem) });

/**
 * PATCH /api/findings/:id { status } → 200 { finding }.
 *   "marked_fixed": allowed from "open" (sets markedFixedAt = now; the Phase 4 recheck job decides confirmed_fixed
 *     or reopens it). Tips can be marked fixed too.
 *   "open": undo, allowed only from "marked_fixed" (clears markedFixedAt).
 *   Anything else, or confirmed_fixed rows → 409 conflict.
 * Allowed on Free too (it only changes status, locked fields stay omitted in the response `finding`).
 * The response finding carries `recheckAfter` semantics via RECHECK_DEFAULTS (web explains: "We'll keep watching for
 * 15 minutes / 72 hours; if it doesn't come back, it's confirmed fixed").
 */
export const patchFindingResponse = z.object({ finding: findingView });
export const patchFindingRequest = z.object({ status: z.enum(["marked_fixed", "open"]) });

// ---------------------------------------------------------------------------------------------------------
// Alerts (Discord webhooks)
// ---------------------------------------------------------------------------------------------------------

/** Only real Discord webhook URLs (SSRF guard). Checked on PUT; the API never fetches any other host. */
export const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,120}$/;

export const ALERT_EVENTS = ["incident_opened", "incident_resolved", "server_offline", "server_back", "crash"] as const;
export const ALERT_DEFAULTS = {
  minSeverity: "medium",
  offlineAfterMinutes: 5,
  cooldownMinutes: 30,
} as const;

/**
 * Table alert_configs (one per server): webhook URL stored ENCRYPTED (AES-256-GCM, key from env SECRETS_KEY, 32
 * bytes base64; required when alerts are used). The full URL is never returned, logged or put in errors.
 * Table alert_deliveries: every attempt or suppression (id, server_id, event, status, http_status, error (no URL),
 * incident_id, created_at). Kept 30 days.
 *
 * Events:
 *   incident_opened  — when an incident opens with severity ≥ minSeverity, or later rises to ≥ minSeverity (once per incident).
 *   incident_resolved — when an incident whose opened-alert was SENT closes (never suppressed by cooldown).
 *   server_offline   — no sample for offlineAfterMinutes after the server had sent data (once per outage).
 *   server_back      — first sample after a sent server_offline (never suppressed by cooldown).
 *   crash            — agent event "crash", or server_start with uncleanPreviousShutdown = true.
 * Cooldown: per (server, event) for incident_opened, server_offline, crash: a repeat within cooldownMinutes →
 *   logged "suppressed_cooldown". Quiet hours (local time in timeZone, may span midnight): everything except
 *   critical incident_opened → "suppressed_quiet" (logged, not sent later).
 * Content: plain embed — server name, event, severity, peak MSPT / lowest TPS, duration, up to 2 non-tip finding
 *   titles for the incident, link to WEB_PUBLIC_URL/app/servers/:id/incidents/:incidentId (or the dashboard).
 *   allowed_mentions: { parse: [] } (server names can't ping @everyone). No player names, no IPs.
 * Delivery: in-process queue, 5 s timeout, at most 2 retries on 5xx/429 (honour retry_after, cap 30 s).
 *   Discord 401/404 → status "failed", config.webhookStatus = "invalid" (UI asks for a new URL; events are then
 *   logged "failed" without calling Discord until the URL is replaced). Never blocks ingest.
 * Plans: plans[plan].discordAlerts must be true (all plans today), else 402 plan_limit on PUT/test.
 */
export const quietHours = z.object({
  enabled: z.boolean(),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), // "22:00"
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), // "08:00"
  timeZone: z.string().min(1).max(64), // IANA, validated with Intl
});
export const alertEventToggles = z.object({
  incidentOpened: z.boolean(),
  incidentResolved: z.boolean(),
  serverOffline: z.boolean(), // also controls server_back
  crash: z.boolean(),
});

/** GET /api/servers/:id/alerts → alertConfig (defaults when never saved: enabled false, webhook null, all events on). */
export const alertConfig = z.object({
  enabled: z.boolean(),
  /** e.g. "https://discord.com/api/webhooks/1234…/••••" (id prefix + masked token) or null. */
  webhookUrlMasked: z.string().nullable(),
  webhookStatus: z.enum(["none", "ok", "invalid", "untested"]),
  events: alertEventToggles,
  minSeverity: z.enum(["medium", "high", "critical"]),
  offlineAfterMinutes: z.number().int().min(2).max(60),
  cooldownMinutes: z.number().int().min(5).max(1440),
  quietHours,
});
export type AlertConfig = z.infer<typeof alertConfig>;

/**
 * PUT /api/servers/:id/alerts → 200 alertConfig. `webhookUrl`: string = replace (must match DISCORD_WEBHOOK_RE →
 * else 400 fields.webhookUrl; status becomes "untested"), null = remove, omitted = keep. enabled true without a
 * webhook → 400 fields.webhookUrl.
 */
export const putAlertConfigRequest = alertConfig
  .omit({ webhookUrlMasked: true, webhookStatus: true })
  .extend({ webhookUrl: z.string().max(300).nullable().optional() });

/**
 * POST /api/servers/:id/alerts/test → sends a test message now (ignores enabled, cooldown and quiet hours; needs a
 * saved webhook, else 400 fields.webhookUrl) → 200 { ok: true, httpStatus } or 502 { error: { code: "webhook_failed",
 * message } } (message in plain words, e.g. "Discord says this webhook doesn't exist any more"). Logged as event "test".
 * Rate limit: 5 per server per 10 min → 429.
 */
export const alertTestResponse = z.object({ ok: z.literal(true), httpStatus: z.number().int() });

/** GET /api/servers/:id/alerts/deliveries?limit (≤ 100, default 50) → { deliveries } newest first. */
export const alertDelivery = z.object({
  id: z.string().uuid(),
  event: z.enum([...ALERT_EVENTS, "test"]),
  status: z.enum(["sent", "failed", "suppressed_cooldown", "suppressed_quiet", "suppressed_disabled"]),
  httpStatus: z.number().int().nullable(),
  error: z.string().max(300).nullable(),
  incidentId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export const alertDeliveriesResponse = z.object({ deliveries: z.array(alertDelivery) });
