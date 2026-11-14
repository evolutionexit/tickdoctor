import { sql } from "drizzle-orm";
import { METRIC_NAMES, type HelloPayload, type HostSample, type Incident, type MetricName, type SnapshotPayload } from "@tickdoctor/shared";
import { iso, ms, rows, type Exec } from "../db/query.js";
import { getIncident } from "../incidents/store.js";
import { effectivePlanId } from "../limits.js";
import type { RuleContext, RuleEvent, RuleSample } from "../rules/types.js";

// Builds the RuleContext exactly as apps/api/src/rules/types.ts documents it.
//
// Cost notes: `samples` = raw samples (with detail) for the window, falling back to 1-min rollups for the part
// older than the first raw sample, and for anything older than MAX_RAW_WINDOW_MS before window.to (a week-long
// incident would otherwise pull 60k jsonb rows). `history` = 1-min rollups, 7 days for incident scope and 24 h for
// server scope (which runs every 5 min); only the _avg
// columns plus the _max of HISTORY_MAX_METRICS.

const MIN = 60_000;
const DAY = 86_400_000;
export const SERVER_WINDOW_MS = 30 * MIN;
export const INCIDENT_LEAD_MS = 10 * MIN;
export const MAX_RAW_WINDOW_MS = 12 * 3_600_000;
export const HISTORY_MS = 7 * DAY;
export const EVENTS_LOOKBACK_MS = 7 * DAY;
/** Exceptions, joins/leaves and can't-keep-up events: window + this much before it. */
export const BUSY_EVENTS_LOOKBACK_MS = DAY;
/** Max rows per event class (newest kept). */
export const EVENTS_LIMIT = 5000;
/** Server-scope history (incident scope: HISTORY_MS). */
export const SERVER_HISTORY_MS = DAY;
export const INFO_HISTORY_MS = 30 * DAY;
export const HISTORY_MAX_METRICS: MetricName[] = ["mspt_avg", "mspt_p95", "mspt_p99", "mspt_max", "players", "entities", "gc_pause_ms", "heap_used_bytes", "cpu_temp_c", "swap_used_bytes", "chunk_gen_per_min"];

const id = (s: string) => sql`${sql.identifier(s)}`;
const hotCols = sql.join(METRIC_NAMES.map((m) => sql`m.${id(m)}`), sql`, `);
const avgCols = (names: readonly string[]) => sql.join(names.map((m) => id(`${m}_avg`)), sql`, `);
const maxCols = (names: readonly string[]) => sql.join(names.map((m) => id(`${m}_max`)), sql`, `);

type Row = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Stored detail jsonb (ingest/storage.ts sampleDetail) + hot host columns → RuleSample.detail. */
export function toRuleDetail(detail: Row, hot: Partial<Record<MetricName, number>>): RuleSample["detail"] {
  const world = Array.isArray(detail.world) ? (detail.world as Row[]) : [];
  const jvm = (detail.jvm ?? {}) as Row;
  const out: NonNullable<RuleSample["detail"]> = {
    worlds: world.map((w) => ({
      name: String(w.name ?? ""),
      loadedChunks: num(w.loadedChunks) ?? 0,
      entities: num(w.entities) ?? 0,
      entitiesByType: (w.entitiesByType as Record<string, number>) ?? {},
      tileEntitiesByType: (w.tileEntitiesByType as Record<string, number>) ?? {},
      ...(num(w.chunkGenPerMinute) !== undefined ? { chunkGenPerMinute: num(w.chunkGenPerMinute)! } : {}),
      countsAgeSeconds: num(w.countsAgeSeconds) ?? 0,
    })),
    worstChunks: Array.isArray(detail.worstChunks) ? (detail.worstChunks as NonNullable<RuleSample["detail"]>["worstChunks"]) : [],
    gcPauses: Array.isArray(jvm.gcPauses)
      ? (jvm.gcPauses as Row[]).map((g) => ({
          collector: String(g.collector ?? ""),
          count: num(g.count) ?? 0,
          totalMs: num(g.totalMs) ?? 0,
          maxMs: num(g.maxMs) ?? 0,
        }))
      : [],
    heapCommittedBytes: num(jvm.heapCommittedBytes) ?? 0,
    threadCount: num(jvm.threadCount) ?? 0,
  };
  if (detail.host && typeof detail.host === "object") {
    // The five host values stored as hot columns go back in, so `host` is the full HostSample again.
    const host: HostSample = { ...(detail.host as HostSample) };
    if (hot.host_cpu !== undefined) host.cpuUsage = hot.host_cpu;
    if (hot.cpu_temp_c !== undefined) host.cpuTempC = hot.cpu_temp_c;
    if (hot.mem_available_bytes !== undefined) host.memAvailableBytes = hot.mem_available_bytes;
    if (hot.swap_used_bytes !== undefined) host.swapUsedBytes = hot.swap_used_bytes;
    if (hot.disk_used_bytes !== undefined) host.diskUsedBytes = hot.disk_used_bytes;
    out.host = host;
  }
  return out;
}

function hotOf(r: Row, suffix = ""): Partial<Record<MetricName, number>> {
  const m: Partial<Record<MetricName, number>> = {};
  for (const name of METRIC_NAMES) {
    const v = num(r[`${name}${suffix}`]);
    if (v !== undefined) m[name] = v;
  }
  return m;
}

async function rollupSamples(db: Exec, serverId: string, from: number, to: number, maxNames: readonly MetricName[]): Promise<RuleSample[]> {
  if (!(from < to)) return [];
  const rs = await rows(
    db,
    sql`select bucket, ${avgCols(METRIC_NAMES)}, ${maxCols(maxNames)} from metric_rollups_1m
         where server_id = ${serverId} and bucket >= ${new Date(from).toISOString()}::timestamptz
           and bucket < ${new Date(to).toISOString()}::timestamptz
         order by bucket`,
  );
  return rs.map((r) => {
    const s: RuleSample = { ts: iso(r.bucket), seconds: 60, m: hotOf(r, "_avg") };
    const max: Partial<Record<MetricName, number>> = {};
    for (const n of maxNames) {
      const v = num(r[`${n}_max`]);
      if (v !== undefined) max[n] = v;
    }
    s.max = max;
    return s;
  });
}

/** Window samples: raw with detail when available, else 1-min rollups (see header). */
export async function loadSamples(db: Exec, serverId: string, from: number, to: number): Promise<RuleSample[]> {
  const rawFrom = Math.max(from, to - MAX_RAW_WINDOW_MS);
  const raw = await rows(
    db,
    sql`select m.ts, ${hotCols}, m.detail from metric_samples m
         where m.server_id = ${serverId} and m.ts >= ${new Date(rawFrom).toISOString()}::timestamptz
           and m.ts <= ${new Date(to).toISOString()}::timestamptz
         order by m.ts`,
  );
  const rawSamples: RuleSample[] = raw.map((r) => {
    const m = hotOf(r);
    const detail = (r.detail ?? {}) as Row;
    return { ts: iso(r.ts), seconds: num(detail.windowSeconds) ?? 10, m, detail: toRuleDetail(detail, m) };
  });
  // Rollups cover whole minutes before the first raw sample (or the whole window when no raw data is left).
  const rollupTo = rawSamples.length > 0 ? Math.floor(ms(rawSamples[0]!.ts) / MIN) * MIN : to;
  const older = await rollupSamples(db, serverId, Math.floor(from / MIN) * MIN, rollupTo, METRIC_NAMES);
  return [...older, ...rawSamples];
}

function toEvent(r: Row): RuleEvent {
  return { ...(r.data as object), type: r.type, ts: iso(r.ts) } as RuleEvent;
}

export interface ContextArgs {
  serverId: string;
  scope: "server" | "incident";
  /** Wall clock (ms). Incident scope uses endedAt ?? now as ctx.now. */
  nowMs: number;
  incidentId?: string;
}

export async function buildContext(db: Exec, a: ContextArgs): Promise<RuleContext> {
  const [server] = await rows<{ id: string; plan: string }>(db, sql`select id, plan from servers where id = ${a.serverId}`);
  if (!server) throw new Error("server not found");

  let incident: Incident | undefined;
  let snapshot: SnapshotPayload | null | undefined;
  let nowMs = a.nowMs;
  let from: number;
  let to: number;
  if (a.scope === "incident") {
    if (!a.incidentId) throw new Error("incident scope needs an incident id");
    const inc = await getIncident(db, a.incidentId);
    if (!inc || inc.serverId !== a.serverId) throw new Error("incident not found");
    incident = inc;
    if (inc.endedAt) nowMs = Math.min(nowMs, Date.parse(inc.endedAt));
    from = Date.parse(inc.startedAt) - INCIDENT_LEAD_MS;
    to = inc.endedAt ? Date.parse(inc.endedAt) : nowMs;
    snapshot = null;
    if (inc.snapshotId) {
      const [s] = await rows<{ snapshot: SnapshotPayload }>(db, sql`select snapshot from incident_snapshots where id = ${inc.snapshotId}`);
      snapshot = s?.snapshot ?? null;
    }
  } else {
    to = nowMs;
    from = nowMs - SERVER_WINDOW_MS;
  }
  const nowIso = new Date(nowMs).toISOString();

  const infoRows = await rows<{ valid_from: Date; valid_to: Date | null; info: HelloPayload }>(
    db,
    sql`select valid_from, valid_to, info from server_info_history
         where server_id = ${a.serverId} and valid_from <= ${nowIso}::timestamptz
           and (valid_to is null or valid_to >= ${new Date(nowMs - INFO_HISTORY_MS).toISOString()}::timestamptz)
         order by valid_from`,
  );
  const infoHistory = infoRows.map((r) => ({
    validFrom: iso(r.valid_from),
    // A row closed after "now" (backfill evaluating the past) was still current at "now".
    validTo: r.valid_to && ms(r.valid_to) <= nowMs ? iso(r.valid_to) : null,
    info: r.info,
  }));
  const current = [...infoHistory].reverse().find((r) => r.validTo === null) ?? null;

  const pluginRows = await rows<{ plugin: string; version: string; first_seen: Date; last_seen: Date }>(
    db,
    sql`select plugin, version, first_seen, last_seen from plugin_inventory_history
         where server_id = ${a.serverId} and first_seen <= ${nowIso}::timestamptz
           and last_seen >= ${new Date(nowMs - INFO_HISTORY_MS).toISOString()}::timestamptz
         order by first_seen, plugin`,
  );

  const samples = await loadSamples(db, a.serverId, from, to);
  // Server scope runs every 5 min per server: 24 h of history is enough there (rules fall back gracefully);
  // incident scope gets the full 7 days.
  const historyMs = a.scope === "server" ? SERVER_HISTORY_MS : HISTORY_MS;
  const history = await rollupSamples(db, a.serverId, to - historyMs, to + 1, HISTORY_MAX_METRICS);
  // Events, bounded: lifecycle events (plugin changes, start/stop/crash) for 7 days before the window; the
  // high-volume kinds (exceptions, joins/leaves, can't-keep-up) only for the window + 24 h, newest EVENTS_LIMIT.
  const toIso = new Date(to).toISOString();
  const lifecycle = await rows(
    db,
    sql`select id, ts, type, data from events
         where server_id = ${a.serverId} and type in ('plugins_changed', 'server_start', 'server_stop', 'crash')
           and ts >= ${new Date(from - EVENTS_LOOKBACK_MS).toISOString()}::timestamptz and ts <= ${toIso}::timestamptz
         order by ts desc, id desc limit ${EVENTS_LIMIT}`,
  );
  const busy = await rows(
    db,
    sql`select id, ts, type, data from events
         where server_id = ${a.serverId} and type not in ('plugins_changed', 'server_start', 'server_stop', 'crash')
           and ts >= ${new Date(from - BUSY_EVENTS_LOOKBACK_MS).toISOString()}::timestamptz and ts <= ${toIso}::timestamptz
         order by ts desc, id desc limit ${EVENTS_LIMIT}`,
  );
  const eventRows = [...lifecycle, ...busy].sort((x, y) => ms(x.ts) - ms(y.ts) || Number(x.id) - Number(y.id));

  const ctx: RuleContext = {
    now: nowIso,
    scope: a.scope,
    server: { id: server.id, plan: effectivePlanId(server.plan) },
    info: current?.info ?? null,
    infoHistory,
    plugins: pluginRows.map((p) => ({ name: p.plugin, version: p.version, firstSeen: iso(p.first_seen), lastSeen: iso(p.last_seen) })),
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    samples,
    history,
    events: eventRows.map(toEvent),
  };
  if (incident) {
    ctx.incident = incident;
    ctx.snapshot = snapshot ?? null;
    ctx.baseline = incident.baseline;
  }
  return ctx;
}
