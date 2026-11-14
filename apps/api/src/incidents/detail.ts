import { sql } from "drizzle-orm";
import {
  METRIC_NAMES,
  isTuningTip,
  type Baseline,
  type Finding,
  type HelloPayload,
  type IncidentDetail,
  type MetricName,
  type incidentListItemV6,
  type incidentTimelineEntry,
} from "@tickdoctor/shared";
import type { z } from "zod";
import { iso, isoOrNull, ms, rows, type Exec } from "../db/query.js";
import { fmtDuration } from "../findings/format.js";
import { serverFindingsLocked, viewFinding } from "../findings/gate.js";
import { listFindingsForIncident } from "../findings/lifecycle.js";
import { byImpact, impactOrderSql, nonTipSql } from "../findings/tips.js";
import { dict, ownNum } from "../rules/util.js";
import { infoAt } from "./baseline.js";
import { computeWhatChanged, median, type PluginRef } from "./what-changed.js";

// GET /api/incidents/:id (contract app-phase6.ts incidentDetail): loads everything the page needs. The decisions
// for "what changed?" live in the pure what-changed.ts; this file only collects inputs.

export type IncidentListItemV6 = z.infer<typeof incidentListItemV6>;
type TimelineEntry = z.infer<typeof incidentTimelineEntry>;
type Row = Record<string, unknown>;

const MIN = 60_000;
/** Raw samples for windows up to this long; longer incidents read 1-min rollups (raw retention is short anyway). */
export const MAX_RAW_MS = 12 * 3_600_000;
const TIMELINE_LEAD_MS = 30 * MIN;
const TIMELINE_MAX = 100;
const PLUGIN_HISTORY_MS = 24 * 3_600_000;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Columns for incidentListItemV6 (alias i): non-tip finding count + top non-tip title. */
export const incidentV6Cols = sql`i.id, i.started_at, i.ended_at, i.severity, i.peak_mspt_p95, i.min_tps_1m, i.trigger,
  (select count(*) from finding_incidents fi join findings f on f.id = fi.finding_id
    where fi.incident_id = i.id and ${nonTipSql(sql`f.severity`)})::int as finding_count,
  (select f.title from finding_incidents fi join findings f on f.id = fi.finding_id
    where fi.incident_id = i.id and ${nonTipSql(sql`f.severity`)} order by ${impactOrderSql("f")} limit 1) as top_finding_title`;

export function toIncidentListItemV6(r: Row): IncidentListItemV6 {
  return {
    id: String(r.id),
    startedAt: iso(r.started_at),
    endedAt: isoOrNull(r.ended_at),
    severity: r.severity as IncidentListItemV6["severity"],
    peakMsptP95: Number(r.peak_mspt_p95),
    minTps1m: num(r.min_tps_1m),
    trigger: r.trigger === "tps" ? "tps" : "mspt",
    findingCount: Number(r.finding_count ?? 0),
    topFindingTitle: (r.top_finding_title as string | null) ?? null,
  };
}

// ---------- snapshot ----------

interface StoredSnapshot {
  sample?: { players?: { count?: number }; world?: { name?: string; loadedChunks?: number; entities?: number; entitiesByType?: Record<string, number>; tileEntitiesByType?: Record<string, number> }[] };
  worldsDetail?: {
    name?: string;
    entitiesByType?: Record<string, number>;
    tileEntitiesByType?: Record<string, number>;
    topChunks?: { x: number; z: number; entities: number; tileEntities: number; byType?: Record<string, number> }[];
  }[];
}

const sumValues = (m: Record<string, number> | undefined) => Object.values(m ?? {}).reduce((a, b) => a + Number(b), 0);

function addCounts(acc: Record<string, number>, m: Record<string, number> | undefined) {
  for (const [k, v] of Object.entries(m ?? {})) acc[k] = ownNum(acc, k) + Number(v);
}

export function snapshotView(r: Row): NonNullable<IncidentDetail["snapshot"]> & { _entities: Record<string, number>; _tiles: Record<string, number> } {
  const s = (r.snapshot ?? {}) as StoredSnapshot;
  const sampleWorlds = Array.isArray(s.sample?.world) ? s.sample!.world! : [];
  const detail = Array.isArray(s.worldsDetail) ? s.worldsDetail : [];
  const names = [...new Set([...sampleWorlds.map((w) => w.name ?? ""), ...detail.map((w) => w.name ?? "")])].filter(Boolean);
  const worlds = names.map((name) => {
    const w = sampleWorlds.find((x) => x.name === name);
    const d = detail.find((x) => x.name === name);
    return {
      name,
      loadedChunks: w?.loadedChunks !== undefined ? Math.trunc(w.loadedChunks) : null,
      entities: Math.trunc(w?.entities ?? sumValues(d?.entitiesByType)),
      tileEntities: Math.trunc(sumValues(d?.tileEntitiesByType ?? w?.tileEntitiesByType)),
    };
  });
  const chunks = detail.flatMap((w) =>
    (Array.isArray(w.topChunks) ? w.topChunks : []).map((c) => ({
      world: w.name ?? "",
      x: Math.trunc(c.x),
      z: Math.trunc(c.z),
      entities: Math.trunc(c.entities),
      tileEntities: Math.trunc(c.tileEntities),
      topTypes: Object.entries(c.byType ?? {})
        .map(([type, count]) => ({ type, count: Math.trunc(Number(count)) }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
        .slice(0, 5),
    })),
  );
  chunks.sort((a, b) => b.entities + b.tileEntities - (a.entities + a.tileEntities));
  const entities: Record<string, number> = {};
  const tiles: Record<string, number> = {};
  if (detail.length > 0) {
    for (const d of detail) {
      addCounts(entities, d.entitiesByType);
      addCounts(tiles, d.tileEntitiesByType);
    }
  } else {
    for (const w of sampleWorlds) {
      addCounts(entities, w.entitiesByType);
      addCounts(tiles, w.tileEntitiesByType);
    }
  }
  const trig = String(r.trigger);
  return {
    capturedAt: iso(r.captured_at),
    trigger: trig === "manual" || trig === "requested" ? trig : "threshold",
    msptP95AtTrigger: Number(r.mspt_p95_at_trigger),
    players: typeof s.sample?.players?.count === "number" ? Math.trunc(s.sample.players.count) : null,
    worlds,
    worstChunks: chunks.slice(0, 10),
    _entities: entities,
    _tiles: tiles,
  };
}

// ---------- samples ----------

const id = (s: string) => sql`${sql.identifier(s)}`;
const hotCols = sql.join(METRIC_NAMES.map((m) => id(m)), sql`, `);
const rollupCols = sql.join(
  METRIC_NAMES.map((m) => (m === "tps_1m" ? sql`tps_1m_min as tps_1m` : sql`${id(`${m}_avg`)} as ${id(m)}`)),
  sql`, `,
);

function toMetrics(r: Row): Partial<Record<MetricName, number>> {
  const m: Partial<Record<MetricName, number>> = {};
  for (const n of METRIC_NAMES) {
    const v = num(r[n]);
    if (v !== null && Number.isFinite(v)) m[n] = v;
  }
  return m;
}

interface WorldDetail {
  name?: string;
  loadedChunks?: number;
  entities?: number;
  entitiesByType?: Record<string, number>;
  tileEntitiesByType?: Record<string, number>;
}

/** Incident window samples: raw (≤ 12 h and still stored) else 1-min rollups (TPS = the bucket minimum). */
export async function windowSamples(db: Exec, serverId: string, from: number, to: number) {
  const f = new Date(from).toISOString();
  const t = new Date(to).toISOString();
  if (to - from <= MAX_RAW_MS) {
    const raw = await rows(
      db,
      sql`select ${hotCols} from metric_samples
           where server_id = ${serverId} and ts >= ${f}::timestamptz and ts <= ${t}::timestamptz order by ts`,
    );
    if (raw.length > 0) return { source: "raw" as const, samples: raw.map(toMetrics) };
  }
  const roll = await rows(
    db,
    sql`select ${rollupCols} from metric_rollups_1m
         where server_id = ${serverId} and bucket >= ${new Date(Math.floor(from / MIN) * MIN).toISOString()}::timestamptz
           and bucket < ${t}::timestamptz order by bucket`,
  );
  return { source: "rollup" as const, samples: roll.map(toMetrics) };
}

/** Max raw detail rows read for per-type medians (one per minute: 12 h). */
export const MAX_DETAIL_ROWS = 720;

/**
 * Per-world detail of raw samples in the window, at most one sample per minute and MAX_DETAIL_ROWS rows (only read
 * when the incident has no snapshot).
 */
export async function rawWorldDetail(db: Exec, serverId: string, from: number, to: number): Promise<WorldDetail[][]> {
  if (to - from > MAX_RAW_MS) return [];
  const r = await rows<{ world: unknown }>(
    db,
    sql`select world from (
          select distinct on (date_trunc('minute', ts)) ts, detail->'world' as world from metric_samples
           where server_id = ${serverId} and ts >= ${new Date(from).toISOString()}::timestamptz and ts <= ${new Date(to).toISOString()}::timestamptz
           order by date_trunc('minute', ts), ts
        ) m order by ts limit ${MAX_DETAIL_ROWS}`,
  );
  return r.map((x) => (Array.isArray(x.world) ? (x.world as WorldDetail[]) : []));
}

/** Per-type and per-world medians over raw samples' detail (used when there is no snapshot). */
export function rawDetailMedians(samples: WorldDetail[][]) {
  const withData = samples.filter((w) => w.length > 0);
  if (withData.length === 0) return null;
  const perType = (key: "entitiesByType" | "tileEntitiesByType") => {
    const sums = withData.map((ws) => {
      const acc = dict<number>();
      for (const w of ws) addCounts(acc, w[key]);
      return acc;
    });
    const types = new Set(sums.flatMap((s) => Object.keys(s)));
    const out = dict<number>();
    for (const t of types) out[t] = median(sums.map((s) => ownNum(s, t))) ?? 0;
    return out;
  };
  const names = [...new Set(withData.flatMap((ws) => ws.map((w) => w.name).filter((n): n is string => !!n)))].sort();
  const worlds = names.map((name) => {
    const ws = withData.map((s) => s.find((w) => w.name === name));
    return {
      name,
      loadedChunks: median(ws.map((w) => w?.loadedChunks ?? 0)),
      entities: median(ws.map((w) => w?.entities ?? 0)) ?? 0,
    };
  });
  return { entitiesByType: perType("entitiesByType"), tileEntitiesByType: perType("tileEntitiesByType"), worlds };
}

/**
 * Plugin changes in (atMs − 24 h, atMs] from plugin_inventory_history: a version first seen then is new, or an update
 * of the plugin's previous version (one indexed lookup per changed row, in SQL).
 */
export async function pluginHistoryChanges(db: Exec, serverId: string, atMs: number) {
  const r = await rows<{ plugin: string; version: string; prev: string | null }>(
    db,
    sql`select p.plugin, p.version,
               (select o.version from plugin_inventory_history o
                 where o.server_id = p.server_id and o.plugin = p.plugin and o.first_seen < p.first_seen
                 order by o.first_seen desc limit 1) as prev
          from plugin_inventory_history p
         where p.server_id = ${serverId}
           and p.first_seen > ${new Date(atMs - PLUGIN_HISTORY_MS).toISOString()}::timestamptz
           and p.first_seen <= ${new Date(atMs).toISOString()}::timestamptz
         order by p.first_seen limit 200`,
  );
  return r.map((x) => ({ name: x.plugin, from: x.prev, to: x.version }));
}

// ---------- timeline ----------

const pluginDiff = (before: PluginRef[], after: PluginRef[]) => {
  const b = new Map(before.map((p) => [p.name, p.version]));
  const a = new Map(after.map((p) => [p.name, p.version]));
  const out: { kind: TimelineEntry["kind"]; label: string }[] = [];
  for (const [n, v] of a) {
    if (!b.has(n)) out.push({ kind: "plugin_added", label: `Plugin ${n} ${v} installed.` });
    else if (b.get(n) !== v) out.push({ kind: "plugin_updated", label: `Plugin ${n} updated ${b.get(n)} → ${v}.` });
  }
  for (const [n] of b) if (!a.has(n)) out.push({ kind: "plugin_removed", label: `Plugin ${n} removed.` });
  return out;
};

async function buildTimeline(
  db: Exec,
  inc: { id: string; serverId: string; startedAt: number; endedAt: number | null; endReason: string | null; trigger: string },
  nowMs: number,
): Promise<TimelineEntry[]> {
  const from = inc.startedAt - TIMELINE_LEAD_MS;
  const to = inc.endedAt ?? nowMs;
  const f = new Date(from).toISOString();
  const t = new Date(to).toISOString();
  const out: (TimelineEntry & { at: number; pin?: boolean })[] = [];
  const push = (at: number, kind: TimelineEntry["kind"], label: string, pin = false) =>
    out.push({ at, ts: new Date(at).toISOString(), kind, label: label.slice(0, 300), pin });

  push(inc.startedAt, "incident_opened", inc.trigger === "tps" ? "Lag started. TPS dropped below 18." : "Lag started. Slowest ticks passed 50 ms.", true);
  if (inc.endedAt !== null) {
    const d = fmtDuration(inc.endedAt - inc.startedAt);
    push(inc.endedAt, "incident_closed", inc.endReason === "offline" ? `Ended after ${d}: the server stopped sending data.` : `Back to normal after ${d}.`, true);
  }

  const snaps = await rows<{ captured_at: Date; players: number | null }>(
    db,
    sql`select captured_at, (snapshot->'sample'->'players'->>'count')::int as players from incident_snapshots
         where server_id = ${inc.serverId} and captured_at >= ${f}::timestamptz and captured_at <= ${t}::timestamptz order by captured_at limit 20`,
  );
  for (const s of snaps) push(ms(s.captured_at), "snapshot", s.players === null ? "Snapshot saved." : `Snapshot saved (${s.players} players online).`);

  const evs = await rows<{ ts: Date; type: string; unclean: boolean | null }>(
    db,
    sql`select ts, type, (data->>'uncleanPreviousShutdown')::boolean as unclean from events
         where server_id = ${inc.serverId} and type in ('server_start', 'crash')
           and ts >= ${f}::timestamptz and ts <= ${t}::timestamptz order by ts limit 50`,
  );
  for (const e of evs) {
    if (e.type === "crash") push(ms(e.ts), "crash", "Server crashed or stopped without saving.");
    else push(ms(e.ts), "server_start", e.unclean ? "Server started (it wasn't shut down cleanly before)." : "Server started.");
  }

  // Plugin and config changes: each server_info_history row starting in the window vs the row before it.
  const infos = await rows<{ valid_from: Date; info: HelloPayload; prev: HelloPayload | null }>(
    db,
    sql`select h.valid_from, h.info,
               (select p.info from server_info_history p where p.server_id = h.server_id and p.valid_from < h.valid_from
                 order by p.valid_from desc limit 1) as prev
          from server_info_history h
         where h.server_id = ${inc.serverId} and h.valid_from >= ${f}::timestamptz and h.valid_from <= ${t}::timestamptz
         order by h.valid_from limit 20`,
  );
  for (const h of infos) {
    if (!h.prev) continue;
    const at = ms(h.valid_from);
    for (const d of pluginDiff(h.prev.plugins ?? [], h.info.plugins ?? [])) push(at, d.kind, d.label);
    const pc = h.prev.config;
    const nc = h.info.config;
    if (pc && nc) {
      if (pc.viewDistance !== nc.viewDistance) push(at, "config_changed", `View distance changed from ${pc.viewDistance} to ${nc.viewDistance}.`);
      if (pc.simulationDistance !== nc.simulationDistance) push(at, "config_changed", `Simulation distance changed from ${pc.simulationDistance} to ${nc.simulationDistance}.`);
    }
    const pj = h.prev.jvm;
    const nj = h.info.jvm;
    if (pj && nj && pj.heapMaxBytes !== nj.heapMaxBytes) {
      push(at, "config_changed", `Max Java memory changed from ${Math.round(pj.heapMaxBytes / 1_048_576)} MB to ${Math.round(nj.heapMaxBytes / 1_048_576)} MB.`);
    }
  }

  out.sort((a, b) => a.at - b.at || Number(b.pin) - Number(a.pin));
  let kept = out;
  if (kept.length > TIMELINE_MAX) {
    // Keep the incident's own entries; drop the oldest of the rest.
    const pinned = kept.filter((e) => e.pin);
    const rest = kept.filter((e) => !e.pin).slice(-(TIMELINE_MAX - pinned.length));
    kept = [...pinned, ...rest].sort((a, b) => a.at - b.at || Number(b.pin) - Number(a.pin));
  }
  return kept.map(({ ts, kind, label }) => ({ ts, kind, label }));
}

// ---------- the detail ----------

/** null when the incident doesn't exist or isn't the user's (the route answers 404 either way). */
/** The detail without plan gating (CLI / demo export): the optional gated fields are always present. */
export type FullIncidentDetail = Omit<IncidentDetail, "snapshot" | "whatChanged" | "findings"> & {
  snapshot: (NonNullable<IncidentDetail["snapshot"]> & { worstChunks: NonNullable<NonNullable<IncidentDetail["snapshot"]>["worstChunks"]> }) | null;
  whatChanged: NonNullable<IncidentDetail["whatChanged"]>;
  findings: Finding[];
};

/**
 * `gate` = apply the server plan's findings gating (the app route does); without it the full detail comes back.
 */
export async function loadIncidentDetail(db: Exec, incidentId: string, userId: string, nowMs: number, gate: true): Promise<IncidentDetail | null>;
export async function loadIncidentDetail(db: Exec, incidentId: string, userId: string, nowMs: number, gate?: false): Promise<FullIncidentDetail | null>;
export async function loadIncidentDetail(db: Exec, incidentId: string, userId: string, nowMs: number, gate = false): Promise<IncidentDetail | null> {
  const [r] = await rows(
    db,
    sql`select ${incidentV6Cols}, i.server_id, i.end_reason, i.source, i.baseline
          from incidents i join servers s on s.id = i.server_id
         where i.id = ${incidentId} and s.owner_id = ${userId}`,
  );
  if (!r) return null;
  const serverId = String(r.server_id);
  const locked = gate && (await serverFindingsLocked(db, serverId));
  const startedAt = ms(r.started_at);
  const endedAt = r.ended_at ? ms(r.ended_at) : null;
  const end = endedAt ?? nowMs;
  const baseline = (r.baseline as Baseline | null) ?? null;

  const [snapRow] = await rows(
    db,
    sql`select captured_at, trigger, mspt_p95_at_trigger, snapshot from incident_snapshots
         where incident_id = ${incidentId} order by (captured_at >= ${new Date(startedAt).toISOString()}::timestamptz) desc, captured_at limit 1`,
  );
  const snap = snapRow ? snapshotView(snapRow) : null;

  const win = await windowSamples(db, serverId, startedAt, end);
  const info = await infoAt(db, serverId, startedAt);
  const rawDetail = snap ? null : rawDetailMedians(await rawWorldDetail(db, serverId, startedAt, end));

  const whatChanged = locked ? undefined : computeWhatChanged({
    baseline,
    samples: win.samples,
    ...(snap
      ? { entitiesByType: snap._entities, tileEntitiesByType: snap._tiles, worlds: snap.worlds.map((w) => ({ name: w.name, loadedChunks: w.loadedChunks, entities: w.entities })) }
      : rawDetail
        ? { entitiesByType: rawDetail.entitiesByType, tileEntitiesByType: rawDetail.tileEntitiesByType, worlds: rawDetail.worlds }
        : {}),
    ...(info
      ? {
          plugins: (info.plugins ?? []).map((p) => ({ name: p.name, version: p.version })),
          ...(info.config ? { config: { viewDistance: info.config.viewDistance, simulationDistance: info.config.simulationDistance } } : {}),
          ...(info.jvm ? { jvm: { heapMaxBytes: info.jvm.heapMaxBytes, heapInitBytes: info.jvm.heapInitBytes } } : {}),
        }
      : {}),
    ...(baseline ? {} : { pluginHistory: await pluginHistoryChanges(db, serverId, startedAt) }),
  });

  const findings = (await listFindingsForIncident(db, incidentId)).filter((f) => !isTuningTip(f)).sort(byImpact);
  const fullTimeline = await buildTimeline(
    db,
    { id: incidentId, serverId, startedAt, endedAt, endReason: (r.end_reason as string | null) ?? null, trigger: String(r.trigger) },
    nowMs,
  );

  // Locked: the timeline keeps open/close/snapshot/start/crash but drops plugin and config changes (what changed).
  const timeline = locked ? fullTimeline.filter((e) => !e.kind.startsWith("plugin_") && e.kind !== "config_changed") : fullTimeline;

  let snapshot: IncidentDetail["snapshot"] = null;
  if (snap) {
    const { _entities: _e, _tiles: _t, worstChunks, ...rest } = snap;
    snapshot = locked ? rest : { ...rest, worstChunks };
  }
  return {
    incident: {
      ...toIncidentListItemV6(r),
      serverId,
      endReason: r.end_reason === "recovered" || r.end_reason === "offline" ? r.end_reason : null,
      source: r.source === "rollup_1m" ? "rollup_1m" : "raw",
      durationSeconds: Math.max(0, Math.round((end - startedAt) / 1000)),
    },
    snapshot,
    ...(whatChanged ? { whatChanged } : {}),
    findings: findings.map((f) => viewFinding(f, locked)),
    ...(locked ? { locked: true, lockedReason: "plan" as const } : {}),
    timeline,
  };
}

