/**
 * Demo data (contracts §5.5). Run with `pnpm seed` (scripts/seed.ts → here).
 *
 *   pnpm seed                 # (re)write demo data: user demo@tickdoctor.local, 2 servers, 30 days
 *   pnpm seed --reset         # delete the demo user (cascades to its servers + data), then seed
 *   pnpm seed --wipe          # delete demo data only, don't seed
 *   pnpm seed --days 7 --raw-hours 6
 *   NODE_ENV=production pnpm seed --force   # refused in production without --force
 *
 * Time layout: ANCHOR = now floored to 10 s. Raw 10 s samples for the last `rawHours` (default 24,
 * starting on an hour boundary); everything older (back to `days`, default 30) is written straight
 * into metric_rollups_1m (6 synthetic samples aggregated per minute), and 1h rollups are built
 * from those. The rollup job then turns the raw window into 1m/1h as it would for a real agent.
 *
 * Idempotent: each run deletes the demo servers' time series and rewrites them (ids are fixed);
 * nothing outside the demo user/servers is touched.
 *
 * Lag episodes (hours relative to ANCHOR; Phase 4's detector and rules should find these):
 *   smp-heap-pressure   Friends SMP  -480 h → -312 h  heap 85–97 % of max, gc_pause_ms 300–900 per
 *                                                     10 s, MSPT p95 spikes (VPS, -Xmx6G).
 *   pi-plugin-update    Pi Survival  -288 h → -216 h  plugins_changed FarmControl 2.3.1 → 2.4.0 at
 *                                                     -288 h; MSPT avg +9 ms / p95 +20 ms until the
 *                                                     rollback (plugins_changed 2.4.0 → 2.3.1) at -216 h.
 *   smp-entity-buildup  Friends SMP  -10 h → -6 h     item farm at world (-40, 112): entities climb
 *                                                     ~+4,500, MSPT p95 → ~70 ms, cant_keep_up events;
 *                                                     threshold snapshot at -6.5 h; cleared at -6 h.
 *   pi-hot-afternoon    Pi Survival  -5 h → -2 h      cpu_temp_c 80–85 °C, throttled.now = true,
 *                                                     MSPT avg +4..+30 ms (peak mid-episode); threshold
 *                                                     snapshot at -3 h.
 * Phase 4 tuning (so every episode is exactly one incident at any time of day and healthy time has none):
 * Friends SMP msptPerPlayer 1.1 → 0.7 (busy evenings stayed just over p95 50 ms), heap-pressure p95 +18 ms
 * (nights dipped under 40 ms and split the week into ~100 incidents), hot-afternoon amplitude 12 → 26 ms (at
 * night it never reached 50 ms). The seed then runs incidents:backfill + incident rules + a server-scope pass.
 * The script prints the absolute UTC times of each episode when it runs.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  events,
  incidentSnapshots,
  metricRollups1m,
  metricSamples,
  pluginInventoryHistory,
  serverInfoHistory,
  servers,
  users,
} from "./db/schema.js";
import { METRIC_NAMES, type MetricName } from "@tickdoctor/shared";
import { rebuildHoursFromMinutes, runRollup } from "./jobs/rollup.js";
import { backfillAndEvaluate, evaluateServer } from "./findings/engine.js";
import { canonicalJson } from "./ingest/storage.js";
import { createHash } from "node:crypto";
import type { RuleSample } from "./rules/types.js";

const H = 3_600_000;
const MIN = 60_000;

export const DEMO_EMAIL = "demo@tickdoctor.local";
export const DEMO_SERVERS = {
  pi: { id: "5eed0000-0000-4000-8000-000000000001", name: "Pi Survival", slug: "demo-pi-survival" },
  smp: { id: "5eed0000-0000-4000-8000-000000000002", name: "Friends SMP", slug: "demo-friends-smp" },
} as const;
type ServerKey = keyof typeof DEMO_SERVERS;

export interface Episode {
  id: string;
  server: ServerKey;
  /** Hours relative to the anchor (negative = in the past). */
  startH: number;
  endH: number;
}
export const EPISODES: Episode[] = [
  { id: "smp-heap-pressure", server: "smp", startH: -480, endH: -312 },
  { id: "pi-plugin-update", server: "pi", startH: -288, endH: -216 },
  { id: "smp-entity-buildup", server: "smp", startH: -10, endH: -6 },
  { id: "pi-hot-afternoon", server: "pi", startH: -5, endH: -2 },
];
const SNAPSHOT_AT: Record<string, number> = { "smp-entity-buildup": -6.5, "pi-hot-afternoon": -3 };

// ---------- deterministic noise ----------

function hash32(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h / 0x100000000; // 0..1
}
/** White noise in [-1, 1] for (stream, t). */
const white = (stream: number, t: number) => hash32(stream, Math.floor(t / 1000)) * 2 - 1;
/** Smooth noise in [-1, 1] with the given period. */
function smooth(stream: number, t: number, period: number): number {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash32(stream, i) * 2 - 1;
  const b = hash32(stream, i + 1) * 2 - 1;
  return a + (b - a) * u;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- server profiles ----------

interface Profile {
  key: ServerKey;
  stream: number;
  maxPlayers: number;
  heapMax: number;
  memTotal: number;
  baseMspt: number;
  msptPerPlayer: number;
  msptPerKEntities: number;
  baseEntities: number;
  entitiesPerPlayer: number;
  pingBase: number;
  hasTemp: boolean;
  diskBase: number;
  worlds: string[];
}

const GB = 1024 ** 3;
const PROFILES: Record<ServerKey, Profile> = {
  pi: {
    key: "pi", stream: 11, maxPlayers: 8, heapMax: 3 * GB, memTotal: 8 * GB, baseMspt: 6, msptPerPlayer: 2.2,
    msptPerKEntities: 3.5, baseEntities: 250, entitiesPerPlayer: 140, pingBase: 38, hasTemp: true,
    diskBase: 26 * GB, worlds: ["world", "world_nether", "world_the_end"],
  },
  smp: {
    key: "smp", stream: 23, maxPlayers: 20, heapMax: 6 * GB, memTotal: 8 * GB, baseMspt: 4, msptPerPlayer: 0.7,
    msptPerKEntities: 2.2, baseEntities: 900, entitiesPerPlayer: 160, pingBase: 64, hasTemp: false,
    diskBase: 41 * GB, worlds: ["world", "world_nether", "world_the_end"],
  },
};

type Values = Record<MetricName, number | null>;
interface Generated {
  v: Values;
  throttled: boolean;
  farmEntities: number;
  worldEntities: number[];
  worldChunks: number[];
}

function inEpisode(id: string, t: number, anchor: number): number | null {
  const e = EPISODES.find((x) => x.id === id)!;
  const s = anchor + e.startH * H;
  const end = anchor + e.endH * H;
  if (t < s || t >= end) return null;
  return (t - s) / (end - s); // progress 0..1
}

/** Players for (profile, t): evening peak (~20:00 UTC), quiet mornings, busier weekends. */
function playersAt(p: Profile, t: number): number {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const act = 0.5 - 0.5 * Math.cos((2 * Math.PI * (h - 8)) / 24);
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 1.25 : 1;
  const wobble = 1 + 0.25 * smooth(p.stream + 1, t, 40 * MIN);
  return Math.round(clamp(p.maxPlayers * act ** 1.6 * weekend * wobble * 0.85, 0, p.maxPlayers));
}

function generate(p: Profile, t: number, anchor: number): Generated {
  const s = p.stream;
  const players = playersAt(p, t);

  // Entities: baseline + players + episode build-up.
  let farm = 60 + 20 * smooth(s + 2, t, 2 * H);
  const build = p.key === "smp" ? inEpisode("smp-entity-buildup", t, anchor) : null;
  if (build !== null) farm += 4500 * build ** 1.3;
  const entities = Math.round(p.baseEntities + p.entitiesPerPlayer * players + farm + 40 * white(s + 3, t));
  const worldEntities = [Math.round(entities * 0.82), Math.round(entities * 0.15), entities - Math.round(entities * 0.82) - Math.round(entities * 0.15)];
  const chunksPerPlayer = p.key === "pi" ? 230 : 300;
  const loaded = Math.round((p.key === "pi" ? 0 : 400) + chunksPerPlayer * players * (1 + 0.1 * smooth(s + 4, t, 30 * MIN)));
  const worldChunks = [Math.round(loaded * 0.8), Math.round(loaded * 0.15), loaded - Math.round(loaded * 0.8) - Math.round(loaded * 0.15)];

  // MSPT correlated with players + entities.
  let mspt = p.baseMspt + p.msptPerPlayer * players + (p.msptPerKEntities * entities) / 1000 + 0.8 * white(s + 5, t);
  if (build !== null) mspt += (6 * (farm - 60)) / 1000; // dropped items are expensive to tick
  let p95Extra = 0;
  const plugin = p.key === "pi" ? inEpisode("pi-plugin-update", t, anchor) : null;
  if (plugin !== null) {
    mspt += 9;
    p95Extra += 20;
  }
  const hot = p.key === "pi" ? inEpisode("pi-hot-afternoon", t, anchor) : null;
  if (hot !== null) mspt += 26 * Math.sin(Math.PI * hot) + 4;

  // Heap: GC sawtooth; heap-pressure week pins it near max.
  const pressure = p.key === "smp" ? inEpisode("smp-heap-pressure", t, anchor) : null;
  const saw = ((t / 1000) % 150) / 150;
  let heapRatio = 0.35 + 0.35 * saw;
  let gc = 6 + 10 * hash32(s + 6, Math.floor(t / 10_000));
  if (pressure !== null) {
    heapRatio = 0.85 + 0.12 * hash32(s + 7, Math.floor(t / 10_000));
    gc = 300 + 600 * hash32(s + 8, Math.floor(t / 10_000));
    mspt += 6 + 25 * hash32(s + 9, Math.floor(t / 30_000)) ** 4;
    p95Extra += gc / 12 + 18;
  }
  mspt = Math.max(0.5, mspt);
  const p95 = mspt * 1.55 + p95Extra + Math.abs(2 * white(s + 10, t));
  const p99 = p95 * 1.25;
  const max = p99 * 1.3 + (build !== null ? 40 * build : 0);
  const tps = clamp(1000 / Math.max(50, mspt * 1.02), 0, 20) - Math.abs(0.02 * white(s + 11, t));
  const slow = p99 > 50 ? Math.round(clamp((p99 - 50) / 3, 1, 100)) : max > 50 ? 1 : 0;

  const processCpu = clamp(0.05 + (mspt / 50) * 0.55 + 0.03 * white(s + 12, t), 0, 1);
  const hostCpu = clamp((p.key === "pi" ? processCpu * 0.85 : processCpu * 0.5) + 0.04, 0, 1);
  let temp: number | null = null;
  let throttled = false;
  if (p.hasTemp) {
    temp = 44 + hostCpu * 22 + 1.5 * smooth(s + 13, t, 3 * H);
    if (hot !== null) {
      temp = 80 + 5 * Math.sin(Math.PI * hot) + 0.6 * white(s + 14, t);
      throttled = temp > 80;
    }
  }
  const daysFromStart = (t - (anchor - 30 * 24 * H)) / (24 * H);
  const v: Values = {
    tps_1m: Math.round(tps * 100) / 100,
    mspt_avg: mspt,
    mspt_p95: p95,
    mspt_p99: p99,
    mspt_max: max,
    slow_ticks: slow,
    players,
    ping_avg: players > 0 ? p.pingBase + 12 * smooth(s + 15, t, 20 * MIN) + 4 * white(s + 16, t) : null,
    heap_used_bytes: Math.round(p.heapMax * heapRatio),
    heap_max_bytes: p.heapMax,
    gc_pause_ms: gc,
    process_cpu: processCpu,
    loaded_chunks: loaded,
    entities,
    tile_entities: Math.round((p.key === "pi" ? 480 : 1900) + 30 * players),
    chunk_gen_per_min: players > 0 ? Math.max(0, players * 0.8 + 2 * white(s + 17, t)) : 0,
    host_cpu: hostCpu,
    cpu_temp_c: temp,
    mem_available_bytes: Math.round(p.memTotal * (0.42 - heapRatio * 0.12) + 50e6 * white(s + 18, t)),
    swap_used_bytes: pressure !== null ? Math.round(300e6 + 200e6 * hash32(s + 19, Math.floor(t / 60_000))) : 0,
    disk_used_bytes: Math.round(p.diskBase + daysFromStart * 0.15 * GB),
    agent_ms_per_tick: 0.025 + 0.01 * hash32(s + 20, Math.floor(t / 10_000)),
  };
  return { v, throttled, farmEntities: Math.round(farm), worldEntities, worldChunks };
}

function detailFor(p: Profile, g: Generated) {
  const topWorld = { name: "world", x: -40, z: 112 };
  return {
    windowSeconds: 10,
    tick: { tps5m: g.v.tps_1m, tps15m: g.v.tps_1m, tickCount: 200, slowTicks: [] },
    jvm: {
      heapCommittedBytes: Math.round(p.heapMax * 0.8),
      gcPauses: [{ collector: "G1 Young Generation", count: Math.max(1, Math.round((g.v.gc_pause_ms ?? 0) / 12)), totalMs: g.v.gc_pause_ms, maxMs: (g.v.gc_pause_ms ?? 0) / 2 }],
      threadCount: p.key === "pi" ? 34 : 58,
    },
    world: p.worlds.map((name, i) => ({
      name,
      loadedChunks: g.worldChunks[i],
      entities: g.worldEntities[i],
      entitiesByType: i === 0 ? { "minecraft:item": g.farmEntities, other: Math.max(0, (g.worldEntities[0] ?? 0) - g.farmEntities) } : {},
      tileEntitiesByType: {},
      countsAgeSeconds: 5,
    })),
    worstChunks:
      g.farmEntities > 200
        ? [{ world: topWorld.name, x: topWorld.x, z: topWorld.z, entities: g.farmEntities, tileEntities: 64, topEntityType: "minecraft:item" }]
        : [],
    host: {
      cpuLoad1m: (g.v.host_cpu ?? 0) * 4,
      memTotalBytes: p.memTotal,
      ...(p.hasTemp ? { throttled: { now: g.throttled, sinceBoot: g.throttled, raw: g.throttled ? "0x60006" : "0x0" } } : {}),
    },
    agentOverhead: { mainThreadMsMax: 0.4, asyncCpuMs: 11 },
  };
}

/**
 * Pure helper for rule tests (Phase 4): the same deterministic data the seed writes, as RuleSamples.
 * Raw-shaped (with detail) when stepMs ≤ 10 s, rollup-shaped (no detail) otherwise. No DB access.
 */
export function seedRuleSamples(server: ServerKey, fromMs: number, toMs: number, stepMs: number, anchorMs: number): RuleSample[] {
  const p = PROFILES[server];
  const out: RuleSample[] = [];
  for (let t = fromMs; t < toMs; t += stepMs) {
    const g = generate(p, t, anchorMs);
    const m: RuleSample["m"] = {};
    for (const k of METRIC_NAMES) if (g.v[k] !== null) m[k] = g.v[k] as number;
    const sample: RuleSample = { ts: new Date(t).toISOString(), seconds: Math.round(stepMs / 1000), m };
    if (stepMs <= 10_000) {
      const d = detailFor(p, g);
      sample.detail = {
        worlds: d.world.map((w) => ({
          ...w,
          loadedChunks: w.loadedChunks ?? 0,
          entities: w.entities ?? 0,
          entitiesByType: w.entitiesByType as Record<string, number>,
        })),
        worstChunks: d.worstChunks,
        gcPauses: d.jvm.gcPauses.map((x) => ({ ...x, totalMs: x.totalMs ?? 0 })),
        heapCommittedBytes: d.jvm.heapCommittedBytes,
        threadCount: d.jvm.threadCount,
        host: d.host,
      };
    }
    out.push(sample);
  }
  return out;
}

/** The hello the seed stores for a server (for rule tests). */
export function seedHello(server: ServerKey, farmControlVersion = "2.3.1") {
  return helloInfo(PROFILES[server], farmControlVersion);
}

// ---------- info / plugins ----------

function helloInfo(p: Profile, farmControl: string) {
  const pi = p.key === "pi";
  return {
    agentVersion: "0.1.1",
    server: { software: "Paper", softwareVersion: "26.2-83-main@f9fb80b", minecraftVersion: "26.2", onlineMode: true, maxPlayers: p.maxPlayers },
    jvm: {
      javaVersion: "25.0.1",
      vendor: "Eclipse Adoptium",
      flags: pi ? ["-Xms1G", "-Xmx3G"] : ["-Xms6G", "-Xmx6G", "-XX:+UseG1GC", "-XX:MaxGCPauseMillis=200", "-XX:+ParallelRefProcEnabled"],
      heapMaxBytes: p.heapMax,
      heapInitBytes: pi ? GB : p.heapMax,
      availableProcessors: 4,
    },
    host: pi
      ? { os: "Linux", arch: "aarch64", model: "Raspberry Pi 5 Model B Rev 1.0", totalMemoryBytes: p.memTotal }
      : { os: "Linux", arch: "amd64", totalMemoryBytes: p.memTotal },
    config: { viewDistance: pi ? 8 : 10, simulationDistance: pi ? 6 : 8 },
    worlds: [
      { name: "world", environment: "NORMAL" },
      { name: "world_nether", environment: "NETHER" },
      { name: "world_the_end", environment: "THE_END" },
    ],
    plugins: pluginsOf(p, farmControl).map((x) => ({ ...x, enabled: true })),
    privacyMode: "hashed",
  };
}

function pluginsOf(p: Profile, farmControl: string) {
  return p.key === "pi"
    ? [
        { name: "FarmControl", version: farmControl },
        { name: "LuckPerms", version: "5.5.17" },
        { name: "TickDoctorAgent", version: "0.1.1" },
      ]
    : [
        { name: "CoreProtect", version: "23.1" },
        { name: "EssentialsX", version: "2.21.2" },
        { name: "LuckPerms", version: "5.5.17" },
        { name: "TickDoctorAgent", version: "0.1.1" },
      ];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- main ----------

export interface SeedOptions {
  days?: number;
  rawHours?: number;
  /** Clock (ms). Tests pass a fixed value. */
  now?: number;
  log?: (l: string) => void;
}

export interface SeedResult {
  anchor: string;
  counts: Record<string, number>;
  episodes: { id: string; server: string; start: string; end: string }[];
}

const DEMO_IDS = [DEMO_SERVERS.pi.id, DEMO_SERVERS.smp.id];

export async function wipeDemo(db: Db) {
  await db.execute(sql`delete from servers where id in (${sql.join(DEMO_IDS.map((i) => sql`${i}`), sql`, `)})`);
  await db.execute(sql`delete from users where email = ${DEMO_EMAIL}`);
}

async function insertBatched<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export async function seed(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const days = opts.days ?? 30;
  const rawHours = Math.min(opts.rawHours ?? 24, days * 24);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const anchor = Math.floor(now / 10_000) * 10_000;
  const rawStart = Math.floor((anchor - rawHours * H) / H) * H;
  const start = Math.floor((anchor - days * 24 * H) / H) * H;

  // User + servers (fixed ids; plan network so 30 days survive retention).
  await db.insert(users).values({ email: DEMO_EMAIL, displayName: "Demo" }).onConflictDoNothing({ target: users.email });
  const [owner] = await db.select({ id: users.id }).from(users).where(sql`email = ${DEMO_EMAIL}`);
  for (const s of Object.values(DEMO_SERVERS)) {
    await db
      .insert(servers)
      .values({ id: s.id, ownerId: owner!.id, name: s.name, slug: s.slug, plan: "network", createdAt: new Date(start) })
      .onConflictDoUpdate({ target: servers.id, set: { ownerId: owner!.id, name: s.name, slug: s.slug, plan: "network" } });
  }
  // Rewrite the time series from scratch (idempotent). Findings/incidents first (snapshots point at incidents).
  for (const table of ["findings", "incidents", "server_analysis_state", "metric_samples", "metric_rollups_1m", "metric_rollups_1h", "events", "incident_snapshots", "server_info_history", "plugin_inventory_history"]) {
    await db.execute(sql`delete from ${sql.identifier(table)} where server_id in (${sql.join(DEMO_IDS.map((i) => sql`${i}`), sql`, `)})`);
  }

  for (const key of Object.keys(DEMO_SERVERS) as ServerKey[]) {
    const p = PROFILES[key];
    const serverId = DEMO_SERVERS[key].id;

    // 1m rollups for [start, rawStart): 6 synthetic samples per minute.
    const minuteRows: Record<string, unknown>[] = [];
    for (let m = start; m < rawStart; m += MIN) {
      const row: Record<string, unknown> = { serverId, bucket: new Date(m), sampleCount: 6 };
      const gens = [0, 1, 2, 3, 4, 5].map((i) => generate(p, m + i * 10_000, anchor).v);
      for (const name of METRIC_NAMES) {
        const vals = gens.map((g) => g[name]).filter((x): x is number => x !== null);
        row[`${name}_avg`] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        row[`${name}_min`] = vals.length ? Math.min(...vals) : null;
        row[`${name}_max`] = vals.length ? Math.max(...vals) : null;
      }
      minuteRows.push(row);
    }
    await insertBatched(minuteRows, 500, (c) => db.insert(metricRollups1m).values(c as never[]));
    if (minuteRows.length) await rebuildHoursFromMinutes(db, serverId, new Date(start), new Date(rawStart));

    // Raw 10 s samples for [rawStart, anchor].
    const rawRows: Record<string, unknown>[] = [];
    for (let t = rawStart + 10_000; t <= anchor; t += 10_000) {
      const g = generate(p, t, anchor);
      rawRows.push({ serverId, ts: new Date(t), ...g.v, detail: detailFor(p, g) });
    }
    await insertBatched(rawRows, 1000, (c) => db.insert(metricSamples).values(c as never[]));

    // Events: daily restart (Pi 04:00 UTC) / weekly (SMP), joins/leaves from the player curve,
    // cant_keep_up during the worst minutes, plugin changes.
    const evs: { ts: number; type: string; data: Record<string, unknown> }[] = [];
    let prevPlayers = playersAt(p, start);
    for (let m = start; m <= anchor; m += MIN) {
      const d = new Date(m);
      const restart = key === "pi" ? d.getUTCHours() === 4 && d.getUTCMinutes() === 0 : d.getUTCDay() === 1 && d.getUTCHours() === 5 && d.getUTCMinutes() === 0;
      if (restart) {
        evs.push({ ts: m - 5_000, type: "server_stop", data: { reason: "scheduled restart" } });
        evs.push({ ts: m + 25_000, type: "server_start", data: { uncleanPreviousShutdown: false } });
      }
      const pl = playersAt(p, m);
      for (let c = prevPlayers; c < pl; c++) evs.push({ ts: m + (c - prevPlayers) * 1000 + 500, type: "player_join", data: { playerCount: c + 1 } });
      for (let c = prevPlayers; c > pl; c--) evs.push({ ts: m + (prevPlayers - c) * 1000 + 700, type: "player_leave", data: { playerCount: c - 1 } });
      prevPlayers = pl;
      if (m % (5 * MIN) === 0) {
        const g = generate(p, m, anchor).v;
        if ((g.mspt_p95 ?? 0) > 60) {
          evs.push({ ts: m + 3_000, type: "cant_keep_up", data: { behindMs: Math.round((g.mspt_max ?? 0) * 30), ticksSkipped: Math.round((g.mspt_max ?? 0) / 2) } });
        }
      }
    }
    const pluginEp = EPISODES.find((e) => e.id === "pi-plugin-update")!;
    const updateAt = anchor + pluginEp.startH * H;
    const rollbackAt = anchor + pluginEp.endH * H;
    if (key === "pi") {
      if (updateAt >= start) evs.push({ ts: updateAt, type: "plugins_changed", data: { added: [], removed: [], updated: [{ name: "FarmControl", from: "2.3.1", to: "2.4.0" }] } });
      if (rollbackAt >= start) evs.push({ ts: rollbackAt, type: "plugins_changed", data: { added: [], removed: [], updated: [{ name: "FarmControl", from: "2.4.0", to: "2.3.1" }] } });
    }
    const eventRows = evs
      .filter((e) => e.ts >= start && e.ts <= anchor)
      .map((e) => {
        const ts = new Date(e.ts).toISOString();
        return { serverId, ts: new Date(e.ts), type: e.type, data: e.data, eventHash: sha(e.type + ts + canonicalJson(e.data)) };
      });
    await insertBatched(eventRows, 1000, (c) => db.insert(events).values(c).onConflictDoNothing());

    // Server info history + plugin inventory (Pi: FarmControl update and rollback).
    const periods: { from: number; to: number | null; farm: string }[] =
      key === "pi"
        ? [
            { from: start, to: updateAt, farm: "2.3.1" },
            { from: updateAt, to: rollbackAt, farm: "2.4.0" },
            { from: rollbackAt, to: null, farm: "2.3.1" },
          ].filter((x) => (x.to ?? anchor) > start).map((x) => ({ ...x, from: Math.max(x.from, start) }))
        : [{ from: start, to: null, farm: "" }];
    for (const per of periods) {
      const info = helloInfo(p, per.farm);
      await db.insert(serverInfoHistory).values({
        serverId,
        validFrom: new Date(per.from),
        validTo: per.to === null ? null : new Date(per.to),
        info,
        infoHash: sha(canonicalJson(info)),
      });
    }
    const inventory = new Map<string, { plugin: string; version: string; firstSeen: Date; lastSeen: Date }>();
    for (const per of periods) {
      for (const pl of pluginsOf(p, per.farm)) {
        const k = `${pl.name}@${pl.version}`;
        const cur = inventory.get(k);
        const last = new Date(per.to ?? anchor);
        if (cur) cur.lastSeen = last;
        else inventory.set(k, { plugin: pl.name, version: pl.version, firstSeen: new Date(per.from), lastSeen: last });
      }
    }
    await db.insert(pluginInventoryHistory).values([...inventory.values()].map((x) => ({ serverId, ...x })));

    // Threshold snapshots for episodes inside the raw window.
    for (const ep of EPISODES.filter((e) => e.server === key && SNAPSHOT_AT[e.id] !== undefined)) {
      const at = anchor + SNAPSHOT_AT[ep.id]! * H;
      if (at < rawStart) continue;
      const g = generate(p, Math.floor(at / 10_000) * 10_000, anchor);
      const detail = detailFor(p, g);
      await db.insert(incidentSnapshots).values({
        serverId,
        trigger: "threshold",
        capturedAt: new Date(at),
        msptP95AtTrigger: g.v.mspt_p95 ?? 0,
        snapshot: {
          trigger: "threshold",
          ts: new Date(at).toISOString(),
          msptP95AtTrigger: g.v.mspt_p95,
          // A stored (sanitised) SnapshotPayload.sample: a full MetricSample with players reduced to { count, pingAvg }.
          sample: {
            ts: new Date(at).toISOString(),
            windowSeconds: 10,
            tick: {
              tps1m: g.v.tps_1m, tps5m: g.v.tps_1m, tps15m: g.v.tps_1m, msptAvg: g.v.mspt_avg, msptP95: g.v.mspt_p95,
              msptP99: g.v.mspt_p99, msptMax: g.v.mspt_max, tickCount: 200, slowTicks: [],
            },
            jvm: {
              heapUsedBytes: g.v.heap_used_bytes, heapCommittedBytes: detail.jvm.heapCommittedBytes, heapMaxBytes: g.v.heap_max_bytes,
              gcPauses: detail.jvm.gcPauses, threadCount: detail.jvm.threadCount, processCpuLoad: g.v.process_cpu,
            },
            world: detail.world.map((w) => ({ ...w, countsAgeSeconds: 0 })),
            worstChunks: detail.worstChunks,
            players: { count: g.v.players, pingAvg: g.v.ping_avg },
            host: {
              ...detail.host,
              cpuUsage: g.v.host_cpu,
              ...(g.v.cpu_temp_c !== null ? { cpuTempC: g.v.cpu_temp_c } : {}),
              memAvailableBytes: g.v.mem_available_bytes,
              swapUsedBytes: g.v.swap_used_bytes,
              diskUsedBytes: g.v.disk_used_bytes,
            },
            agentOverhead: { mainThreadMsPerTick: g.v.agent_ms_per_tick, ...detail.agentOverhead },
          },
          worldsDetail: [
            {
              name: "world",
              entitiesByType: { "minecraft:item": g.farmEntities, "minecraft:cow": 120, other: Math.max(0, (g.worldEntities[0] ?? 0) - g.farmEntities - 120) },
              tileEntitiesByType: { "minecraft:hopper": 210, "minecraft:chest": 180 },
              topChunks: [{ x: -40, z: 112, entities: g.farmEntities, tileEntities: 64, byType: { "minecraft:item": g.farmEntities } }],
            },
          ],
          threads: [
            { name: "Server thread", state: "RUNNABLE", cpuMs: 9200 },
            { name: "Netty Epoll Server IO #1", state: "RUNNABLE", cpuMs: 610 },
          ],
          recentEvents: [],
        },
      });
    }
  }

  // Raw window → 1m/1h via the real rollup job.
  await runRollup(db);

  // Phase 4: incidents from the history (rollups before the raw window, raw after), incident rules for each, and
  // one server-scope pass "now", so the demo has incidents and findings.
  for (const key of Object.keys(DEMO_SERVERS) as ServerKey[]) {
    const serverId = DEMO_SERVERS[key].id;
    const r = await backfillAndEvaluate(db, serverId, { from: start, to: anchor, nowMs: anchor, log });
    await evaluateServer(db, serverId, { nowMs: anchor, log });
    log(`${DEMO_SERVERS[key].name}: ${r.created.length} incidents`);
  }

  const counts: Record<string, number> = {};
  for (const table of ["metric_samples", "metric_rollups_1m", "metric_rollups_1h", "events", "incident_snapshots", "server_info_history", "plugin_inventory_history", "incidents", "findings"]) {
    const [r] = (await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where server_id in (${sql.join(DEMO_IDS.map((i) => sql`${i}`), sql`, `)})`,
    )) as unknown as { n: number }[];
    counts[table] = r!.n;
  }
  const episodes = EPISODES.map((e) => ({
    id: e.id,
    server: DEMO_SERVERS[e.server].name,
    start: new Date(anchor + e.startH * H).toISOString(),
    end: new Date(anchor + e.endH * H).toISOString(),
  }));
  log(`anchor ${new Date(anchor).toISOString()} · raw from ${new Date(rawStart).toISOString()} · rollups from ${new Date(start).toISOString()}`);
  for (const e of episodes) log(`episode ${e.id.padEnd(20)} ${e.server.padEnd(12)} ${e.start} → ${e.end}`);
  log(`rows: ${JSON.stringify(counts)}`);
  return { anchor: new Date(anchor).toISOString(), counts, episodes };
}

/** The seed writes (and --reset/--wipe delete) data: refuse against production unless --force. */
export function assertSeedAllowed(nodeEnv: string | undefined, force: boolean): void {
  if (nodeEnv === "production" && !force) {
    throw new Error("refusing to seed with NODE_ENV=production (pass --force if you really mean it)");
  }
}

export function parseSeedArgs(argv: string[]) {
  const out: { reset: boolean; wipe: boolean; force: boolean; days?: number; rawHours?: number } = { reset: false, wipe: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") out.reset = true;
    else if (a === "--wipe") out.wipe = true;
    else if (a === "--force") out.force = true;
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--raw-hours") out.rawHours = Number(argv[++i]);
    else if (a === "--") continue;
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.days !== undefined && !(out.days >= 1 && out.days <= 400)) throw new Error("--days must be 1..400");
  if (out.rawHours !== undefined && !(out.rawHours >= 1 && out.rawHours <= 168)) throw new Error("--raw-hours must be 1..168");
  return out;
}
