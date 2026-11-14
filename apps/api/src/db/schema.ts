import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  type AnyPgColumn,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { METRIC_NAMES } from "@tickdoctor/shared";

const tsz = (name: string) => timestamp(name, { withTimezone: true });

/** Phase 1 waitlist. Stores only what the contract allows: email, source, created_at. No IP. */
export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    source: text("source").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [check("waitlist_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

/**
 * Account row. Deleting a user cascades through everything below (servers, sessions, tokens, oauth links).
 * Unconfirmed accounts (email_verified_at NULL: pending signups, CLI-created users) have no password and can never
 * log in; the password is chosen on the confirm-link page (contract app.ts "Account confirmation model").
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    /** scrypt$N$r$p$salt$hash (base64); NULL = no password (unconfirmed, or Discord-created). */
    passwordHash: text("password_hash"),
    emailVerifiedAt: tsz("email_verified_at"),
    /** The only consent record: set when the account is confirmed (password page or /signup/discord). NULL on pending rows. */
    consentAt: tsz("consent_at"),
    /** Last signup attempt (pending rows are purged 7 days after it). NULL = never signed up (CLI/Discord). */
    lastSignupAt: tsz("last_signup_at"),
    plan: text("plan").notNull().default("free"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("users_plan_check", sql`${t.plan} in ('free', 'pro', 'network')`),
  ],
);

/** Login sessions (contracts §3). The cookie holds 32 random bytes; only their sha256 (hex) is stored. */
export const sessions = pgTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at").notNull(),
    lastUsedAt: tsz("last_used_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** Single-use email tokens (verify / magic link / password reset), stored as sha256 hex. */
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Validated same-site path to continue to after the link (contract nextPath). */
    next: text("next"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at").notNull(),
    usedAt: tsz("used_at"),
  },
  (t) => [
    index("email_tokens_user_idx").on(t.userId, t.kind),
    index("email_tokens_expires_idx").on(t.expiresAt),
    check("email_tokens_kind_check", sql`${t.kind} in ('verify', 'magic', 'reset')`),
  ],
);

/** Linked identity providers. Only the provider's user id is stored (never tokens). */
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_accounts_provider_user_uq").on(t.provider, t.providerUserId),
    uniqueIndex("oauth_accounts_user_provider_uq").on(t.userId, t.provider),
    check("oauth_accounts_provider_check", sql`${t.provider} in ('discord')`),
  ],
);

/**
 * A new account via Discord waits here until the consent checkbox on /signup/discord (contract app.ts, Discord).
 * Only the Discord user id, the verified email and `next`; the cookie token is stored as sha256. 10 min, single use;
 * purged by the hourly auth job. No user row exists until /api/auth/discord/complete.
 */
export const discordPendingSignups = pgTable(
  "discord_pending_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    discordUserId: text("discord_user_id").notNull(),
    email: text("email").notNull(),
    next: text("next"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at").notNull(),
    usedAt: tsz("used_at"),
  },
  (t) => [
    index("discord_pending_signups_expires_idx").on(t.expiresAt),
    index("discord_pending_signups_discord_idx").on(t.discordUserId),
    check("discord_pending_signups_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const PLAN_IDS = ["free", "pro", "network"] as const;

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: text("plan").notNull().default("free"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    lastSeenAt: tsz("last_seen_at"),
    bootId: uuid("boot_id"),
    /** Set by `cli server:request-snapshot` (and Phase 4 incidents); the next metrics response carries requestSnapshot and clears it. */
    snapshotRequestedAt: tsz("snapshot_requested_at"),
    /** Phase 5 onboarding/health: first hello ever, first and latest accepted metrics call (receive time). */
    firstHelloAt: tsz("first_hello_at"),
    firstSampleAt: tsz("first_sample_at"),
    lastSampleAt: tsz("last_sample_at"),
  },
  (t) => [
    index("servers_owner_idx").on(t.ownerId),
    check("servers_plan_check", sql`${t.plan} in ('free', 'pro', 'network')`),
  ],
);

const serverRef = () =>
  uuid("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" });

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: serverRef(),
    /** hex sha256(key + API_KEY_PEPPER) */
    keyHash: text("key_hash").notNull().unique(),
    /** First 12 chars of the key, for display only. */
    prefix: text("prefix").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    revokedAt: tsz("revoked_at"),
  },
  (t) => [index("api_keys_server_idx").on(t.serverId)],
);

export const serverInfoHistory = pgTable(
  "server_info_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: serverRef(),
    validFrom: tsz("valid_from").notNull().defaultNow(),
    validTo: tsz("valid_to"),
    info: jsonb("info").notNull(),
    infoHash: text("info_hash").notNull(),
  },
  (t) => [
    index("server_info_history_server_idx").on(t.serverId, t.validFrom),
    uniqueIndex("server_info_history_current_uq").on(t.serverId).where(sql`${t.validTo} is null`),
  ],
);

export const pluginInventoryHistory = pgTable(
  "plugin_inventory_history",
  {
    serverId: serverRef(),
    plugin: text("plugin").notNull(),
    version: text("version").notNull(),
    firstSeen: tsz("first_seen").notNull().defaultNow(),
    lastSeen: tsz("last_seen").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.plugin, t.version] })],
);

const dbl = (n: string) => doublePrecision(n);
const bytes = (n: string) => bigint(n, { mode: "number" });

/** Hot columns, named exactly like METRIC_NAMES (contracts/metrics.ts). NULL = not available. */
export const hotColumns = {
  tps_1m: dbl("tps_1m"),
  mspt_avg: dbl("mspt_avg"),
  mspt_p95: dbl("mspt_p95"),
  mspt_p99: dbl("mspt_p99"),
  mspt_max: dbl("mspt_max"),
  slow_ticks: integer("slow_ticks"),
  players: integer("players"),
  ping_avg: dbl("ping_avg"),
  heap_used_bytes: bytes("heap_used_bytes"),
  heap_max_bytes: bytes("heap_max_bytes"),
  gc_pause_ms: dbl("gc_pause_ms"),
  process_cpu: dbl("process_cpu"),
  loaded_chunks: integer("loaded_chunks"),
  entities: integer("entities"),
  tile_entities: integer("tile_entities"),
  chunk_gen_per_min: dbl("chunk_gen_per_min"),
  host_cpu: dbl("host_cpu"),
  cpu_temp_c: dbl("cpu_temp_c"),
  mem_available_bytes: bytes("mem_available_bytes"),
  swap_used_bytes: bytes("swap_used_bytes"),
  disk_used_bytes: bytes("disk_used_bytes"),
  agent_ms_per_tick: dbl("agent_ms_per_tick"),
};
// Compile-time guard: the hot columns are exactly METRIC_NAMES.
type _HotKeys = keyof typeof hotColumns;
type _Metric = (typeof METRIC_NAMES)[number];
const _sameKeys: [_HotKeys] extends [_Metric] ? ([_Metric] extends [_HotKeys] ? true : never) : never = true;
void _sameKeys;

export const metricSamples = pgTable(
  "metric_samples",
  {
    serverId: serverRef(),
    ts: tsz("ts").notNull(),
    receivedAt: tsz("received_at").notNull().defaultNow(),
    ...hotColumns,
    /** Everything that isn't a hot column (per-world counts, worst chunks, GC per collector, other host fields, agent overhead detail). Never player ids. */
    detail: jsonb("detail").notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.ts] }), index("metric_samples_received_idx").on(t.receivedAt)],
);

function rollupColumns() {
  const cols: Record<string, ReturnType<typeof doublePrecision>> = {};
  for (const m of METRIC_NAMES) {
    cols[`${m}_avg`] = doublePrecision(`${m}_avg`);
    cols[`${m}_min`] = doublePrecision(`${m}_min`);
    cols[`${m}_max`] = doublePrecision(`${m}_max`);
  }
  return cols;
}

const rollupTable = (name: string) =>
  pgTable(
    name,
    {
      serverId: serverRef(),
      bucket: tsz("bucket").notNull(),
      sampleCount: integer("sample_count").notNull(),
      ...rollupColumns(),
    },
    (t) => [primaryKey({ columns: [t.serverId, t.bucket] })],
  );

export const metricRollups1m = rollupTable("metric_rollups_1m");
export const metricRollups1h = rollupTable("metric_rollups_1h");

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: serverRef(),
    ts: tsz("ts").notNull(),
    type: text("type").notNull(),
    /** Event fields minus type/ts. Never player ids. */
    data: jsonb("data").notNull(),
    /** hex sha256(type + ts + canonical data) */
    eventHash: text("event_hash").notNull(),
    receivedAt: tsz("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_server_hash_uq").on(t.serverId, t.eventHash),
    index("events_server_ts_idx").on(t.serverId, t.ts),
  ],
);

export const incidentSnapshots = pgTable(
  "incident_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: serverRef(),
    /**
     * Set when the snapshot falls in [startedAt - 60 s, endedAt] of an incident (contracts §6.1). ON DELETE SET NULL:
     * a snapshot is evidence with its own retention; deleting an incident must not silently destroy it.
     */
    incidentId: uuid("incident_id").references((): AnyPgColumn => incidents.id, { onDelete: "set null" }),
    trigger: text("trigger").notNull(),
    capturedAt: tsz("captured_at").notNull(),
    receivedAt: tsz("received_at").notNull().defaultNow(),
    msptP95AtTrigger: doublePrecision("mspt_p95_at_trigger").notNull(),
    /** Sanitised snapshot payload (player ids removed). */
    snapshot: jsonb("snapshot").notNull(),
    /** Phase 4: medians over the last healthy hours. */
    baseline: jsonb("baseline"),
  },
  (t) => [
    uniqueIndex("incident_snapshots_server_captured_uq").on(t.serverId, t.capturedAt),
    index("incident_snapshots_incident_idx").on(t.incidentId),
  ],
);

/** Small key/value table for background job watermarks. */
export const jobState = pgTable("job_state", {
  name: text("name").primaryKey(),
  watermark: tsz("watermark").notNull(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

// ---------- Phase 4: incidents, findings (contracts §6) ----------

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: serverRef(),
    startedAt: tsz("started_at").notNull(),
    endedAt: tsz("ended_at"),
    endReason: text("end_reason"),
    severity: text("severity").notNull(),
    peakMsptP95: doublePrecision("peak_mspt_p95").notNull(),
    /** Lowest tps_1m during the incident (NULL when the server sends no TPS). */
    minTps1m: doublePrecision("min_tps_1m"),
    /** What opened it: sustained high p95 ("mspt") or sustained low TPS ("tps"). */
    trigger: text("trigger").notNull().default("mspt"),
    /** Severity when it opened (Phase 6 alerts: "got worse" vs "is lagging"). NULL for incidents from before 0009. */
    initialSeverity: text("initial_severity"),
    source: text("source").notNull(),
    baseline: jsonb("baseline"),
    /** When incident rules last ran (the "opened" pass and the "closed" pass). */
    rulesEvaluatedAt: tsz("rules_evaluated_at"),
    // Internal bookkeeping (not part of the Incident contract):
    /** Wall clock when the detector opened it (timers: snapshot request after 30 s, rules after 90 s). */
    openedAt: tsz("opened_at").notNull().defaultNow(),
    /** Wall clock when it was closed (a rules pass older than this is the "opened" pass → "closed" pass pending). */
    closedAt: tsz("closed_at"),
    /** Set once when the detector asked the agent for a snapshot (servers.snapshot_requested_at). */
    snapshotRequestedAt: tsz("snapshot_requested_at"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("incidents_server_started_idx").on(t.serverId, t.startedAt),
    uniqueIndex("incidents_one_open_per_server_uq").on(t.serverId).where(sql`${t.endedAt} is null`),
    index("incidents_ended_idx").on(t.endedAt),
    index("incidents_rules_pending_idx")
      .on(t.closedAt)
      .where(sql`${t.rulesEvaluatedAt} is null or ${t.rulesEvaluatedAt} < ${t.closedAt}`),
    check("incidents_end_reason_check", sql`${t.endReason} in ('recovered', 'offline')`),
    check("incidents_severity_check", sql`${t.severity} in ('medium', 'high', 'critical')`),
    check("incidents_source_check", sql`${t.source} in ('raw', 'rollup_1m')`),
    check("incidents_trigger_check", sql`${t.trigger} in ('mspt', 'tps')`),
    check("incidents_end_consistent", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: serverRef(),
    ruleId: text("rule_id").notNull(),
    scope: text("scope").notNull(),
    dedupKey: text("dedup_key").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    evidence: jsonb("evidence").notNull(),
    suggestedFix: text("suggested_fix").notNull(),
    status: text("status").notNull().default("open"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: tsz("first_seen_at").notNull(),
    lastSeenAt: tsz("last_seen_at").notNull(),
    markedFixedAt: tsz("marked_fixed_at"),
    confirmedFixedAt: tsz("confirmed_fixed_at"),
    resolvedBy: text("resolved_by"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("findings_active_uq")
      .on(t.serverId, t.ruleId, t.dedupKey)
      .where(sql`${t.status} <> 'confirmed_fixed'`),
    index("findings_server_seen_idx").on(t.serverId, t.lastSeenAt),
    index("findings_active_status_idx").on(t.status, t.scope).where(sql`${t.status} <> 'confirmed_fixed'`),
    index("findings_confirmed_idx").on(t.confirmedFixedAt),
    check("findings_status_check", sql`${t.status} in ('open', 'marked_fixed', 'confirmed_fixed')`),
    check("findings_scope_check", sql`${t.scope} in ('incident', 'server')`),
    check("findings_severity_check", sql`${t.severity} in ('info', 'low', 'medium', 'high', 'critical')`),
    check("findings_resolved_by_check", sql`${t.resolvedBy} in ('owner', 'auto')`),
    check("findings_occurrence_check", sql`${t.occurrenceCount} >= 1`),
  ],
);

export const findingIncidents = pgTable(
  "finding_incidents",
  {
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.findingId, t.incidentId] }), index("finding_incidents_incident_idx").on(t.incidentId)],
);

/**
 * Per-server analysis state (internal). Detector: `detectorWatermark` = ts of the last sample processed (later
 * samples are processed, older ones are ignored live), `streakStart` = start of the current run of samples over
 * the open threshold (no incident open) or under the close threshold (incident open). Also when the last
 * server-scope rules pass ran and when the last hello arrived (recheck needs "a hello after marking").
 */
export const serverAnalysisState = pgTable("server_analysis_state", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  detectorWatermark: tsz("detector_watermark"),
  streakStart: tsz("streak_start"),
  streakPeak: doublePrecision("streak_peak"),
  tpsStreakStart: tsz("tps_streak_start"),
  tpsStreakMin: doublePrecision("tps_streak_min"),
  tpsStreakPeak: doublePrecision("tps_streak_peak"),
  serverRulesAt: tsz("server_rules_at"),
  lastHelloAt: tsz("last_hello_at"),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

// ---------- Phase 6: Discord alerts (contract app-phase6.ts) ----------

/** One per server. The webhook URL is stored only AES-256-GCM encrypted (SECRETS_KEY) plus a masked form for display. */
export const alertConfigs = pgTable(
  "alert_configs",
  {
    serverId: uuid("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** "v1:" + base64(iv | tag | ciphertext). Never logged or returned. */
    webhookEnc: text("webhook_enc"),
    webhookMasked: text("webhook_masked"),
    webhookStatus: text("webhook_status").notNull().default("none"),
    events: jsonb("events").notNull(),
    minSeverity: text("min_severity").notNull().default("medium"),
    offlineAfterMinutes: integer("offline_after_minutes").notNull().default(5),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
    quietHours: jsonb("quiet_hours").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("alert_configs_status_check", sql`${t.webhookStatus} in ('none', 'ok', 'invalid', 'untested')`),
    check("alert_configs_min_severity_check", sql`${t.minSeverity} in ('medium', 'high', 'critical')`),
  ],
);

/** Every alert attempt or suppression (kept 30 days by the retention job). `error` never contains the URL. */
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: serverRef(),
    event: text("event").notNull(),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    /** events.id that caused a crash alert (internal: each crash event alerts at most once). */
    sourceEventId: bigint("source_event_id", { mode: "number" }),
    /** server_offline / server_back: receive time of the last sample before the outage (identifies the outage). */
    refAt: tsz("ref_at"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("alert_deliveries_server_created_idx").on(t.serverId, t.createdAt),
    index("alert_deliveries_incident_idx").on(t.incidentId, t.event),
    index("alert_deliveries_created_idx").on(t.createdAt),
    check(
      "alert_deliveries_event_check",
      sql`${t.event} in ('incident_opened', 'incident_resolved', 'server_offline', 'server_back', 'crash', 'test')`,
    ),
    check(
      "alert_deliveries_status_check",
      sql`${t.status} in ('sent', 'failed', 'suppressed_cooldown', 'suppressed_quiet', 'suppressed_disabled')`,
    ),
  ],
);

/**
 * Phase 7 public status page settings (contract app-phase7.ts), one row per server, created on the first PUT.
 * The slug is stored lower-case and unique case-insensitively (index on lower(slug)).
 */
export const statusPages = pgTable(
  "status_pages",
  {
    serverId: uuid("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    showPlayers: boolean("show_players").notNull().default(true),
    showUptime: boolean("show_uptime").notNull().default(true),
    showIncidents: boolean("show_incidents").notNull().default(false),
    theme: text("theme").notNull().default("auto"),
    /** Stored as asked; only honoured while the server's plan has statusPage "custom". */
    hideBranding: boolean("hide_branding").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("status_pages_slug_lower_uq").on(sql`lower(${t.slug})`),
    check("status_pages_theme_check", sql`${t.theme} in ('auto', 'dark', 'light')`),
  ],
);
