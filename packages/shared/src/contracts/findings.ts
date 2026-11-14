import { z } from "zod";

// Phase 4 contract (frozen): findings as produced by apps/api/src/rules/* and stored in `findings`.
// The web app (Phase 6) reads them through the app API with this shape.

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severity>;

export const FINDING_STATUSES = ["open", "marked_fixed", "confirmed_fixed"] as const;
export const findingStatus = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof findingStatus>;

export const RULE_IDS = [
  "entity-explosion", // 1
  "tile-entity-hotspot", // 2
  "plugin-change-before-lag", // 3
  "player-count-threshold", // 4
  "gc-pressure", // 5
  "thermal-throttling", // 6
  "swap-in-use", // 7
  "view-distance-too-high", // 8
  "live-chunk-generation", // 9
  "plugin-exceptions", // 10
  "jvm-flags", // 11
] as const;
export const ruleId = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof ruleId>;

/**
 * Where a rule runs:
 * - "incident": evaluated when an incident opens (once its snapshot arrived or after a timeout) and again when it closes.
 * - "server": evaluated on every hello (config changed) and every 5 minutes over the last 30 minutes, independent of incidents.
 */
export const findingScope = z.enum(["incident", "server"]);
export type FindingScope = z.infer<typeof findingScope>;

export const findingEvidence = z.object({
  numbers: z
    .array(
      z.object({
        label: z.string().max(200),
        value: z.union([z.number(), z.string().max(100)]),
        unit: z.string().max(20).optional(),
        baseline: z.union([z.number(), z.string().max(100)]).optional(),
      }),
    )
    .max(12),
  /** Which graph the UI shows next to the finding (a MetricName from contracts/metrics.ts). */
  chart: z
    .object({
      metric: z.string().max(50),
      from: z.string(),
      to: z.string(),
      highlight: z.object({ from: z.string(), to: z.string() }).optional(),
    })
    .optional(),
  /** → copy-/tp buttons. y is optional (we only know chunk coordinates); the UI picks a safe y. */
  chunks: z.array(z.object({ world: z.string().max(200), x: z.number().int(), z: z.number().int() })).max(10).optional(),
});
export type FindingEvidence = z.infer<typeof findingEvidence>;

export const finding = z.object({
  id: z.string().uuid().or(z.literal("example")),
  serverId: z.string(),
  ruleId,
  scope: findingScope,
  /**
   * Identifies "the same problem" within a server + rule, e.g. "world:item" for entity-explosion or
   * "xms-ne-xmx" for jvm-flags. At most one finding per (serverId, ruleId, dedupKey) is not confirmed_fixed.
   */
  dedupKey: z.string().max(200),
  severity,
  title: z.string().max(200), // "Too many item entities in one chunk"
  explanation: z.string().max(2000), // plain language, 1–3 sentences
  evidence: findingEvidence,
  suggestedFix: z.string().max(4000), // concrete steps, Markdown
  status: findingStatus,
  /** Incidents in which this finding was seen, oldest first (empty for server-scope findings). */
  incidentIds: z.array(z.string()).max(1000),
  occurrenceCount: z.number().int().min(1),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  markedFixedAt: z.string().nullable(),
  confirmedFixedAt: z.string().nullable(),
  /** "owner" = marked fixed then recheck passed; "auto" = server-scope condition stayed absent for the recheck window. */
  resolvedBy: z.enum(["owner", "auto"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof finding>;

/**
 * Lifecycle (apps/api/src/findings/):
 * - A rule fires → upsert on (serverId, ruleId, dedupKey) among non-confirmed rows: update evidence/severity/
 *   lastSeenAt, occurrenceCount+1, add the incident id. If the row was marked_fixed → back to "open" (the problem returned).
 * - Owner marks fixed (CLI now, UI in Phase 6) → "marked_fixed", markedFixedAt = now.
 * - Recheck job (every 5 min): a marked_fixed finding whose rule has NOT fired for RECHECK window since markedFixedAt,
 *   and for which enough fresh data exists (server sent metrics during the window; for config rules: a hello after
 *   markedFixedAt) → "confirmed_fixed", resolvedBy "owner".
 * - Server-scope findings still "open" whose condition stays absent for the same window (with fresh data) →
 *   "confirmed_fixed", resolvedBy "auto". Incident-scope findings never auto-resolve (they need the owner).
 * - After confirmed_fixed, the same problem firing again creates a new finding.
 * - Config rules (CONFIG_RULE_IDS) depend only on the hello: the recheck needs a hello received after the finding's
 *   lastSeenAt (not after markedFixedAt, because the plugin only sends a hello at startup, and an owner may mark
 *   fixed after restarting). A pass whose hello is older than markedFixedAt never reopens a config finding.
 * - One finding per (serverId, ruleId, dedupKey) across scopes: a rule that runs in both scopes and is seen by a
 *   server pass gets scope "server" (its condition is visible continuously, so it may auto-resolve).
 */
export const CONFIG_RULE_IDS: readonly RuleId[] = ["jvm-flags", "view-distance-too-high"];
export const RECHECK_DEFAULTS = {
  /** Server-scope rules (config/host state): short, the condition is visible in every sample/hello. */
  serverScopeMinutes: 15,
  /** Incident-scope rules: the problem must not come back in an incident for this long. Env FINDING_RECHECK_INCIDENT_HOURS overrides (tests). */
  incidentScopeHours: 72,
} as const;

export const markFindingRequest = z.object({ status: z.literal("marked_fixed") });
