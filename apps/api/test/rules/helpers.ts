// Builders for RuleContexts in rule tests: seed data (pure, via seedRuleSamples/seedHello), the real idle Pi,
// and hand-built edge cases. Mirrors what the engine does per contracts §6 (window, history, baseline).
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEMO_SERVERS, EPISODES, seedHello, seedRuleSamples } from "../../src/seed.js";
import { hotValues, sampleDetail } from "../../src/ingest/storage.js";
import type {
  Rule,
  RuleContext,
  RuleEvent,
  RuleFinding,
  RuleSample,
} from "../../src/rules/types.js";
import {
  DETECTOR,
  METRIC_NAMES,
  finding as findingSchema,
  type Baseline,
  type FindingScope,
  type HelloPayload,
  type Incident,
  type MetricName,
  type MetricSample,
  type SnapshotPayload,
} from "@tickdoctor/shared";
import { RULES } from "../../src/rules/index.js";

export const H = 3_600_000;
export const MIN = 60_000;
export type ServerKey = "pi" | "smp";

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = <T>(rel: string): T =>
  JSON.parse(readFileSync(join(here, "../fixtures/rules", rel), "utf8")) as T;

// ---------- seed ----------

/** Minute series for a server over 30 days + 7 days of lead-in, cached per anchor. */
const minuteCache = new Map<string, RuleSample[]>();
export function minutes(server: ServerKey, anchor: number): RuleSample[] {
  const k = `${server}:${anchor}`;
  let s = minuteCache.get(k);
  if (!s) {
    s = seedRuleSamples(server, anchor - 38 * 24 * H, anchor + MIN, MIN, anchor);
    minuteCache.set(k, s);
  }
  return s;
}
export function sliceMinutes(
  server: ServerKey,
  anchor: number,
  from: number,
  to: number,
): RuleSample[] {
  const all = minutes(server, anchor);
  const start = anchor - 38 * 24 * H;
  const i0 = Math.max(0, Math.ceil((from - start) / MIN));
  const i1 = Math.min(all.length, Math.floor((to - start) / MIN) + 1);
  return all.slice(i0, i1).filter((s) => Date.parse(s.ts) >= from && Date.parse(s.ts) <= to);
}

const ep = (id: string) => EPISODES.find((e) => e.id === id)!;
export const episodeRange = (id: string, anchor: number) => ({
  from: anchor + ep(id).startH * H,
  to: anchor + ep(id).endH * H,
});
const SNAPSHOT_AT: Record<string, number> = { "smp-entity-buildup": -6.5, "pi-hot-afternoon": -3 };

/** Is t inside (or within `marginH` of) any episode of that server? */
export function nearEpisode(server: ServerKey, t: number, anchor: number, marginH = 2) {
  return EPISODES.some(
    (e) =>
      e.server === server &&
      t >= anchor + (e.startH - marginH) * H &&
      t < anchor + (e.endH + marginH) * H,
  );
}

/** FarmControl version on the seed Pi at time t (update at -288 h, rollback at -216 h). */
function farmAt(t: number, anchor: number) {
  const r = episodeRange("pi-plugin-update", anchor);
  return t >= r.from && t < r.to ? "2.4.0" : "2.3.1";
}

export function hello(server: ServerKey, t: number, anchor: number): HelloPayload {
  return seedHello(server, farmAt(t, anchor)) as unknown as HelloPayload;
}

/** Events the seed writes (restarts, plugin changes, cant_keep_up), without join/leave. */
export function seedEvents(
  server: ServerKey,
  from: number,
  to: number,
  anchor: number,
): RuleEvent[] {
  const out: RuleEvent[] = [];
  const r = episodeRange("pi-plugin-update", anchor);
  for (let m = Math.ceil(from / MIN) * MIN; m <= to; m += MIN) {
    const d = new Date(m);
    const restart =
      server === "pi"
        ? d.getUTCHours() === 4 && d.getUTCMinutes() === 0
        : d.getUTCDay() === 1 && d.getUTCHours() === 5 && d.getUTCMinutes() === 0;
    if (restart) {
      out.push({
        type: "server_stop",
        ts: new Date(m - 5000).toISOString(),
        reason: "scheduled restart",
      });
      out.push({
        type: "server_start",
        ts: new Date(m + 25_000).toISOString(),
        uncleanPreviousShutdown: false,
      });
    }
    if (m % (5 * MIN) === 0) {
      const s = seedRuleSamples(server, m, m + 1, MIN, anchor)[0]!;
      if ((s.m.mspt_p95 ?? 0) > 60)
        out.push({
          type: "cant_keep_up",
          ts: new Date(m + 3000).toISOString(),
          behindMs: Math.round((s.m.mspt_max ?? 0) * 30),
          ticksSkipped: Math.round((s.m.mspt_max ?? 0) / 2),
        });
    }
  }
  if (server === "pi") {
    if (r.from >= from && r.from <= to)
      out.push({
        type: "plugins_changed",
        ts: new Date(r.from).toISOString(),
        added: [],
        removed: [],
        updated: [{ name: "FarmControl", from: "2.3.1", to: "2.4.0" }],
      });
    if (r.to >= from && r.to <= to)
      out.push({
        type: "plugins_changed",
        ts: new Date(r.to).toISOString(),
        added: [],
        removed: [],
        updated: [{ name: "FarmControl", from: "2.4.0", to: "2.3.1" }],
      });
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function infoHistory(server: ServerKey, anchor: number, to: number) {
  const start = anchor - 30 * 24 * H;
  const r = episodeRange("pi-plugin-update", anchor);
  const periods =
    server === "pi"
      ? [
          { from: start, to: r.from, farm: "2.3.1" },
          { from: r.from, to: r.to, farm: "2.4.0" },
          { from: r.to, to: null as number | null, farm: "2.3.1" },
        ]
      : [{ from: start, to: null as number | null, farm: "2.3.1" }];
  return periods
    .filter((p) => p.from <= to)
    .map((p) => ({
      validFrom: new Date(p.from).toISOString(),
      validTo: p.to === null || p.to > to ? null : new Date(p.to).toISOString(),
      info: seedHello(server, p.farm) as unknown as HelloPayload,
    }));
}

function pluginInventory(server: ServerKey, anchor: number, to: number) {
  const start = anchor - 30 * 24 * H;
  const r = episodeRange("pi-plugin-update", anchor);
  const iso = (t: number) => new Date(Math.min(t, to)).toISOString();
  const common =
    server === "pi"
      ? [
          { name: "LuckPerms", version: "5.5.17" },
          { name: "TickDoctorAgent", version: "0.1.1" },
        ]
      : [
          { name: "CoreProtect", version: "23.1" },
          { name: "EssentialsX", version: "2.21.2" },
          { name: "LuckPerms", version: "5.5.17" },
          { name: "TickDoctorAgent", version: "0.1.1" },
        ];
  const out = common.map((p) => ({ ...p, firstSeen: iso(start), lastSeen: iso(to) }));
  if (server === "pi") {
    out.push({ name: "FarmControl", version: "2.3.1", firstSeen: iso(start), lastSeen: iso(to) });
    if (r.from <= to)
      out.push({
        name: "FarmControl",
        version: "2.4.0",
        firstSeen: iso(r.from),
        lastSeen: iso(r.to),
      });
  }
  return out;
}

/** Baseline per contracts §6.2 from seed minutes (+ raw detail where the seed has raw data: the last 24 h). */
export function seedBaseline(
  server: ServerKey,
  startedAt: number,
  anchor: number,
): Baseline | null {
  const mins = sliceMinutes(server, anchor, startedAt - 7 * 24 * H, startedAt - 10 * MIN);
  const lagTimes = mins.filter((s) => (s.m.mspt_p95 ?? 0) >= 50).map((s) => Date.parse(s.ts));
  const nearLag = (t: number) => lagTimes.some((x) => Math.abs(x - t) <= 10 * MIN);
  const healthy = mins
    .filter((s) => (s.m.mspt_p95 ?? 99) < 30 && !nearLag(Date.parse(s.ts)))
    .slice(-1440);
  if (healthy.length < 30) return null;
  const metrics: Baseline["metrics"] = {};
  for (const k of METRIC_NAMES) {
    const v = healthy
      .map((s) => s.m[k as MetricName])
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    if (v.length)
      metrics[k as MetricName] = {
        median: v[Math.floor(v.length / 2)]!,
        p90: v[Math.floor(v.length * 0.9)]!,
      };
  }
  const b: Baseline = {
    from: healthy[0]!.ts,
    to: healthy[healthy.length - 1]!.ts,
    healthyMinutes: healthy.length,
    metrics,
    plugins: (hello(server, startedAt, anchor).plugins ?? []).map((p) => ({
      name: p.name,
      version: p.version,
    })),
    config: hello(server, startedAt, anchor).config as {
      viewDistance: number;
      simulationDistance: number;
    },
    jvm: {
      heapMaxBytes: hello(server, startedAt, anchor).jvm.heapMaxBytes,
      heapInitBytes: hello(server, startedAt, anchor).jvm.heapInitBytes,
    },
  };
  const rawStart = Math.floor((anchor - 24 * H) / H) * H;
  const rawHealthy = healthy
    .filter((s) => Date.parse(s.ts) >= rawStart)
    .filter((_, i) => i % 10 === 0);
  if (rawHealthy.length) {
    const ent: Record<string, number[]> = {};
    for (const s of rawHealthy) {
      const r = seedRuleSamples(server, Date.parse(s.ts), Date.parse(s.ts) + 1, 10_000, anchor)[0]!;
      const sum: Record<string, number> = {};
      for (const w of r.detail!.worlds)
        for (const [k, v] of Object.entries(w.entitiesByType)) sum[k] = (sum[k] ?? 0) + v;
      for (const [k, v] of Object.entries(sum)) (ent[k] ??= []).push(v);
    }
    b.entitiesByType = Object.fromEntries(
      Object.entries(ent).map(([k, v]) => [k, v.sort((a, c) => a - c)[Math.floor(v.length / 2)]!]),
    );
    b.tileEntitiesByType = {};
  }
  return b;
}

/** Seed snapshot in the shape the seed stores it (sample is not a strict MetricSample there). */
function seedSnapshot(
  server: ServerKey,
  epId: string,
  anchor: number,
): { at: number; snap: SnapshotPayload } | null {
  const h = SNAPSHOT_AT[epId];
  if (h === undefined) return null;
  const at = Math.floor((anchor + h * H) / 10_000) * 10_000;
  const r = seedRuleSamples(server, at, at + 1, 10_000, anchor)[0]!;
  const farm = r.detail!.worlds[0]!.entitiesByType["minecraft:item"] ?? 0;
  const world0 = r.detail!.worlds[0]!.entities;
  const snap = {
    trigger: "threshold",
    ts: new Date(at).toISOString(),
    msptP95AtTrigger: r.m.mspt_p95,
    seededEpisode: epId,
    sample: {
      ts: new Date(at).toISOString(),
      hot: r.m,
      world: r.detail!.worlds,
      worstChunks: r.detail!.worstChunks,
      players: { count: r.m.players },
    },
    worldsDetail: [
      {
        name: "world",
        entitiesByType: {
          "minecraft:item": farm,
          "minecraft:cow": 120,
          other: Math.max(0, world0 - farm - 120),
        },
        tileEntitiesByType: { "minecraft:hopper": 210, "minecraft:chest": 180 },
        topChunks: [
          { x: -40, z: 112, entities: farm, tileEntities: 64, byType: { "minecraft:item": farm } },
        ],
      },
    ],
    threads: [{ name: "Server thread", state: "RUNNABLE", cpuMs: 9200 }],
    recentEvents: [],
  } as unknown as SnapshotPayload;
  return { at, snap };
}

/** Samples for [from, to]: raw 10 s if `raw`, else 1-min rollups. */
export function seedSamples(
  server: ServerKey,
  from: number,
  to: number,
  anchor: number,
  raw: boolean,
): RuleSample[] {
  return raw
    ? seedRuleSamples(server, from, to + 1, 10_000, anchor)
    : sliceMinutes(server, anchor, from, to);
}

export interface SeedCtxOpts {
  server: ServerKey;
  anchor: number;
  /** Server scope: window = [to − 30 min, to]. */
  to: number;
  scope?: FindingScope;
  raw?: boolean;
  incident?: Incident;
  snapshot?: SnapshotPayload | null;
}

export function seedCtx(o: SeedCtxOpts): RuleContext {
  const scope = o.scope ?? "server";
  let from = o.to - 30 * MIN;
  let to = o.to;
  if (scope === "incident" && o.incident) {
    from = Date.parse(o.incident.startedAt) - 10 * MIN;
    to = o.incident.endedAt ? Date.parse(o.incident.endedAt) : o.to;
  }
  const raw = o.raw ?? to >= Math.floor((o.anchor - 24 * H) / H) * H;
  return {
    now: new Date(Math.max(to, o.to)).toISOString(),
    scope,
    server: { id: DEMO_SERVERS[o.server].id, plan: "network" },
    info: hello(o.server, to, o.anchor),
    infoHistory: infoHistory(o.server, o.anchor, to),
    plugins: pluginInventory(o.server, o.anchor, to),
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    samples: seedSamples(o.server, from, to, o.anchor, raw),
    // Engine: server scope gets 24 h of history, incident scope 7 days.
    history: sliceMinutes(o.server, o.anchor, to - (scope === "server" ? 24 : 7 * 24) * H, to),
    events: seedEvents(o.server, from - 7 * 24 * H, to, o.anchor),
    ...(scope === "incident"
      ? {
          incident: o.incident,
          snapshot: o.snapshot ?? null,
          baseline: o.incident?.baseline ?? null,
        }
      : {}),
  };
}

// ---------- incidents ----------

let nextId = 1;
export function makeIncident(
  serverId: string,
  startedAt: number,
  endedAt: number | null,
  peak: number,
  baseline: Baseline | null,
  source: "raw" | "rollup_1m" = "raw",
): Incident {
  const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  return {
    id,
    serverId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    endReason: endedAt === null ? null : "recovered",
    severity: peak >= 250 ? "critical" : peak >= 100 ? "high" : "medium",
    peakMsptP95: peak,
    minTps1m: null,
    trigger: "mspt",
    source,
    snapshotId: null,
    baseline,
    rulesEvaluatedAt: null,
    createdAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
  };
}

/** The detector (contracts §6.1), thresholds read from DETECTOR in the contract. */
export function detect(
  samples: RuleSample[],
): { start: number; end: number | null; peak: number }[] {
  const out: { start: number; end: number | null; peak: number }[] = [];
  let p95Since: number | null = null;
  let p95Secs = 0;
  let tpsSince: number | null = null;
  let tpsSecs = 0;
  let open: { start: number; end: number | null; peak: number } | null = null;
  let underSecs = 0;
  let lastUnder: number | null = null;
  for (const s of samples) {
    const t = Date.parse(s.ts);
    const p95 = s.m.mspt_p95 ?? 0;
    const tps = s.m.tps_1m ?? 20;
    const secs = s.seconds;
    if (!open) {
      if (p95 >= DETECTOR.openMsptP95) {
        if (p95Since === null) p95Since = t - secs * 1000;
        p95Secs += secs;
      } else {
        p95Since = null;
        p95Secs = 0;
      }
      if (tps < DETECTOR.openTps1m) {
        if (tpsSince === null) tpsSince = t - secs * 1000;
        tpsSecs += secs;
      } else {
        tpsSince = null;
        tpsSecs = 0;
      }
      const byP95 = p95Secs >= DETECTOR.openSeconds;
      const byTps = tpsSecs >= DETECTOR.openTpsSeconds;
      if (byP95 || byTps) {
        open = {
          start: Math.min(byP95 ? p95Since! : Infinity, byTps ? tpsSince! : Infinity),
          end: null,
          peak: p95,
        };
        underSecs = 0;
      }
    } else {
      open.peak = Math.max(open.peak, p95);
      if (p95 < DETECTOR.closeMsptP95 && tps >= DETECTOR.closeTps1m) {
        if (underSecs === 0) lastUnder = t - secs * 1000;
        underSecs += secs;
        if (underSecs >= DETECTOR.closeSeconds) {
          open.end = lastUnder;
          out.push(open);
          open = null;
          p95Since = tpsSince = null;
          p95Secs = tpsSecs = 0;
        }
      } else underSecs = 0;
    }
  }
  if (open) out.push(open);
  return out;
}

/** Incidents of a seed episode as incident-scope contexts (closing pass), with baseline and snapshot. */
export function episodeContexts(
  epId: string,
  anchor: number,
  opts: { max?: number } = {},
): RuleContext[] {
  const e = ep(epId);
  const server = e.server as ServerKey;
  const r = episodeRange(epId, anchor);
  const rawStart = Math.floor((anchor - 24 * H) / H) * H;
  const raw = r.from >= rawStart;
  const scan = raw
    ? seedRuleSamples(server, r.from, Math.min(anchor, r.to + H), 10_000, anchor)
    : sliceMinutes(server, anchor, r.from, r.to + H);
  const incs = detect(scan).filter((i) => i.start < r.to);
  const snap = seedSnapshot(server, epId, anchor);
  const chosen = opts.max ? pickSpread(incs, opts.max) : incs;
  return chosen.map((i) => {
    const end = i.end ?? Math.min(anchor, r.to + H);
    const baseline = seedBaseline(server, i.start, anchor);
    const inc = makeIncident(
      DEMO_SERVERS[server].id,
      i.start,
      i.end,
      i.peak,
      baseline,
      raw ? "raw" : "rollup_1m",
    );
    const linked = snap && snap.at >= i.start - 60_000 && snap.at <= end ? snap.snap : null;
    return seedCtx({
      server,
      anchor,
      to: end + MIN,
      scope: "incident",
      incident: inc,
      snapshot: linked,
      raw,
    });
  });
}

function pickSpread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / Math.max(1, n - 1))]!);
  return [...new Set(out)];
}

// ---------- real idle Pi ----------

export function toRuleSample(s: MetricSample): RuleSample {
  const hot = hotValues(s) as Record<string, number | null>;
  const m: RuleSample["m"] = {};
  for (const k of METRIC_NAMES) if (typeof hot[k] === "number") m[k] = hot[k] as number;
  const d = sampleDetail(s);
  return {
    ts: s.ts,
    seconds: s.windowSeconds,
    m,
    detail: {
      worlds: d.world,
      worstChunks: d.worstChunks,
      gcPauses: d.jvm.gcPauses,
      heapCommittedBytes: d.jvm.heapCommittedBytes,
      threadCount: d.jvm.threadCount,
      ...(d.host ? { host: d.host } : {}),
    },
  };
}

export function piIdle() {
  const info = fixture<HelloPayload>("pi-idle/hello.json");
  const samples = fixture<{ samples: MetricSample[] }>("pi-idle/metrics.json").samples.map(
    toRuleSample,
  );
  const events = fixture<{ events: RuleEvent[] }>("pi-idle/events.json").events;
  const snapshot = fixture<SnapshotPayload>("pi-idle/snapshot.json");
  return { info, samples, events, snapshot };
}

export function piIdleCtx(scope: FindingScope): RuleContext {
  const { info, samples, events, snapshot } = piIdle();
  const from = Date.parse(samples[0]!.ts);
  const to = Date.parse(samples[samples.length - 1]!.ts);
  const base: RuleContext = {
    now: new Date(to).toISOString(),
    scope,
    server: { id: "pi-real", plan: "pro" },
    info,
    infoHistory: [{ validFrom: "2026-11-09T12:04:58.567Z", validTo: null, info }],
    plugins: info.plugins.map((p) => ({
      name: p.name,
      version: p.version,
      firstSeen: "2026-11-09T12:04:58.567Z",
      lastSeen: new Date(to).toISOString(),
    })),
    window: {
      from: new Date(scope === "server" ? to - 30 * MIN : from - 10 * MIN).toISOString(),
      to: new Date(to).toISOString(),
    },
    samples,
    history: samples,
    events,
  };
  if (scope === "incident") {
    base.incident = makeIncident("pi-real", from, to, 4.554, null);
    base.snapshot = snapshot;
    base.baseline = null;
  }
  return base;
}

// ---------- running / checking ----------

export function runAll(ctx: RuleContext, rules: Rule[] = RULES): RuleFinding[] {
  return rules.flatMap((r) => r.evaluate(ctx));
}

/** Validates a rule finding against the stored Finding contract (engine fields filled with dummies). */
export function assertValid(f: RuleFinding) {
  const now = "2026-11-09T12:00:00.000Z";
  findingSchema.parse({
    ...f,
    id: "example",
    serverId: "s",
    scope: "server",
    status: "open",
    incidentIds: [],
    occurrenceCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    markedFixedAt: null,
    confirmedFixedAt: null,
    resolvedBy: null,
    createdAt: now,
    updatedAt: now,
  });
  // Writing rules: no player ids (64-hex) and steps are numbered.
  const text = `${f.title} ${f.explanation} ${f.suggestedFix} ${JSON.stringify(f.evidence)}`;
  if (/[0-9a-f]{64}/i.test(text))
    throw new Error(`finding contains something that looks like a player id: ${f.dedupKey}`);
  if (!/^1\. /.test(f.suggestedFix))
    throw new Error(`suggestedFix must be numbered steps: ${f.ruleId}`);
  if (/\d{3,}/.test(f.dedupKey.replace(/-?\d+:-?\d+$/, ""))) {
    // world:type keys only; numbers would drift
    if (!/^plugins:|^stack:/.test(f.dedupKey))
      throw new Error(`dedupKey looks like it contains a drifting number: ${f.dedupKey}`);
  }
}

export const summary = (fs: RuleFinding[]) =>
  fs.map((f) => `${f.ruleId}/${f.dedupKey}/${f.severity}`);

// ---------- hand-built contexts ----------

export const T0 = Date.parse("2026-11-09T12:00:00.000Z");
type Detail = NonNullable<RuleSample["detail"]>;

/** A raw 10 s sample at T0 + offset seconds. */
export function rawSample(
  offsetS: number,
  m: RuleSample["m"],
  detail: Partial<Detail> = {},
): RuleSample {
  return {
    ts: new Date(T0 + offsetS * 1000).toISOString(),
    seconds: 10,
    m,
    detail: {
      worlds: [],
      worstChunks: [],
      gcPauses: [],
      heapCommittedBytes: 0,
      threadCount: 30,
      ...detail,
    },
  };
}

/** `count` raw samples ending at T0 + endS, each built by fn(i). */
export function rawSeries(
  count: number,
  fn: (i: number) => { m: RuleSample["m"]; detail?: Partial<Detail> },
  endS = 0,
): RuleSample[] {
  return Array.from({ length: count }, (_, i) => {
    const x = fn(i);
    return rawSample(endS - (count - 1 - i) * 10, x.m, x.detail);
  });
}

export const healthyM = (extra: RuleSample["m"] = {}): RuleSample["m"] => ({
  tps_1m: 20,
  mspt_avg: 12,
  mspt_p95: 20,
  mspt_p99: 25,
  mspt_max: 30,
  players: 5,
  heap_used_bytes: 2 * 1024 ** 3,
  heap_max_bytes: 4 * 1024 ** 3,
  gc_pause_ms: 10,
  loaded_chunks: 900,
  entities: 800,
  tile_entities: 500,
  chunk_gen_per_min: 2,
  ...extra,
});

export function piHello(
  over: {
    flags?: string[];
    heapInit?: number;
    heapMax?: number;
    view?: number;
    sim?: number;
    ram?: number;
    model?: string;
    arch?: string;
    cores?: number;
  } = {},
): HelloPayload {
  const real = fixture<HelloPayload>("pi-idle/hello.json");
  return {
    ...real,
    jvm: {
      ...real.jvm,
      flags: over.flags ?? real.jvm.flags,
      heapInitBytes: over.heapInit ?? real.jvm.heapInitBytes,
      heapMaxBytes: over.heapMax ?? real.jvm.heapMaxBytes,
      availableProcessors: over.cores ?? real.jvm.availableProcessors,
    },
    host: {
      ...real.host,
      ...(over.ram !== undefined ? { totalMemoryBytes: over.ram } : {}),
      ...(over.model !== undefined ? { model: over.model } : {}),
      ...(over.arch !== undefined ? { arch: over.arch } : {}),
    },
    config: {
      ...real.config,
      viewDistance: over.view ?? real.config.viewDistance,
      simulationDistance: over.sim ?? real.config.simulationDistance,
    },
  };
}

/** A context around hand-built samples (window = their span, or 30 min for server scope). */
export function handCtx(o: {
  scope?: FindingScope;
  samples: RuleSample[];
  info?: HelloPayload | null;
  history?: RuleSample[];
  events?: RuleEvent[];
  baseline?: Baseline | null;
  snapshot?: SnapshotPayload | null;
  incident?: { start: number; end: number | null; peak?: number };
  plugins?: RuleContext["plugins"];
}): RuleContext {
  const scope = o.scope ?? "server";
  const last = o.samples.length ? Date.parse(o.samples[o.samples.length - 1]!.ts) : T0;
  const inc = o.incident
    ? makeIncident(
        "hand",
        o.incident.start,
        o.incident.end,
        o.incident.peak ?? 80,
        o.baseline ?? null,
      )
    : undefined;
  const from = inc ? o.incident!.start - 10 * MIN : last - 30 * MIN;
  const to = inc && o.incident!.end ? o.incident!.end : last;
  const info = o.info === undefined ? piHello() : o.info;
  return {
    now: new Date(to).toISOString(),
    scope,
    server: { id: "hand", plan: "pro" },
    info,
    infoHistory: info
      ? [{ validFrom: new Date(T0 - 30 * 24 * H).toISOString(), validTo: null, info }]
      : [],
    plugins: o.plugins ?? [],
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    samples: o.samples,
    history: o.history ?? [],
    events: o.events ?? [],
    ...(scope === "incident"
      ? { incident: inc, snapshot: o.snapshot ?? null, baseline: o.baseline ?? null }
      : {}),
  };
}

/** Minimal baseline with the given metric medians (p90 = median × 1.2). */
export function baselineOf(
  metrics: Partial<Record<MetricName, number>>,
  extra: Partial<Baseline> = {},
): Baseline {
  return {
    from: new Date(T0 - 2 * 24 * H).toISOString(),
    to: new Date(T0 - H).toISOString(),
    healthyMinutes: 1440,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([k, v]) => [k, { median: v!, p90: v! * 1.2 }]),
    ),
    plugins: [],
    ...extra,
  };
}

/** A 1-min rollup sample (no detail) at time t. */
export const minuteSample = (t: number, m: RuleSample["m"]): RuleSample => ({
  ts: new Date(t).toISOString(),
  seconds: 60,
  m,
});

// ---------- real Pi scenarios (engine RuleContext dumps, 2026-11-09, trimmed + gzipped) ----------

export function scenario(name: string): RuleContext {
  const buf = readFileSync(join(here, "../fixtures/rules/pi-scenarios", `${name}.json.gz`));
  const c = JSON.parse(gunzipSync(buf).toString("utf8")) as RuleContext & {
    _incidentBaselineIsCtxBaseline?: boolean;
  };
  if (c._incidentBaselineIsCtxBaseline && c.incident) c.incident.baseline = c.baseline ?? null;
  delete c._incidentBaselineIsCtxBaseline;
  return c;
}

/**
 * Incident-scope context from a server-scope dump (for the chunk-generation run, until backend-dev's TPS
 * backfill produces the real one): the incident the detector would open in the window, window = [start − 10 min,
 * end], baseline from the history minutes before it (healthy ones only, per §6.2).
 */
export function incidentFromServer(c: RuleContext, which: "first" | "last" = "last"): RuleContext {
  const all = detect(c.samples);
  const inc = which === "first" ? all[0] : all[all.length - 1];
  if (!inc) throw new Error("no incident in this window");
  const end = inc.end ?? Date.parse(c.window.to);
  const before = c.history.filter(
    (s) =>
      Date.parse(s.ts) < inc.start - 10 * MIN &&
      (s.m.mspt_p95 ?? 99) < 30 &&
      (s.m.tps_1m ?? 20) >= 19,
  );
  const metrics: Baseline["metrics"] = {};
  for (const k of METRIC_NAMES) {
    const v = before
      .map((s) => s.m[k as MetricName])
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    if (v.length)
      metrics[k as MetricName] = {
        median: v[Math.floor(v.length / 2)]!,
        p90: v[Math.floor(v.length * 0.9)]!,
      };
  }
  const baseline: Baseline | null =
    before.length >= 30
      ? {
          from: before[0]!.ts,
          to: before[before.length - 1]!.ts,
          healthyMinutes: before.length,
          metrics,
          plugins: [],
        }
      : null;
  const minTps = Math.min(
    ...c.samples
      .filter((s) => Date.parse(s.ts) >= inc.start && Date.parse(s.ts) <= end)
      .map((s) => s.m.tps_1m ?? 20),
  );
  const incident = {
    ...makeIncident(c.server.id, inc.start, inc.end, inc.peak, baseline),
    minTps1m: minTps,
    trigger: "tps" as const,
  };
  const from = inc.start - 10 * MIN;
  return {
    ...c,
    scope: "incident",
    now: new Date(end).toISOString(),
    window: { from: new Date(from).toISOString(), to: new Date(end).toISOString() },
    samples: c.samples.filter((s) => Date.parse(s.ts) >= from && Date.parse(s.ts) <= end),
    incident,
    snapshot: null,
    baseline,
  };
}
