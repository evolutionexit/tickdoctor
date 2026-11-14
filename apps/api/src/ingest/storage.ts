import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  AgentEvent,
  EventsPayload,
  HelloPayload,
  IngestEnvelope,
  MetricSample,
  MetricsPayload,
  SnapshotPayload,
} from "@tickdoctor/shared";
import { INT4_MAX } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import {
  events,
  incidentSnapshots,
  metricSamples,
  pluginInventoryHistory,
  serverInfoHistory,
  servers,
} from "../db/schema.js";
import { retentionFor } from "../limits.js";
import { linkSnapshotToIncident } from "../incidents/store.js";
import { lockServerState, type StateRow } from "../incidents/lock.js";
import type { IngestPrincipal } from "./auth.js";

// What each ingest call stores (contracts §5.2). Player ids are never stored: from pings only the
// count and ping_avg survive; join/leave events keep only playerCount.

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Items stamped further ahead than this are dropped: a bad agent clock (contracts §5.2). */
export const MAX_FUTURE_MS = 10 * 60_000;
/**
 * Upper bound for an ingest transaction. The rollup job ignores transactions older than
 * STALE_XACT_SECONDS (rollup.ts), so this must stay well below that.
 */
export const INGEST_TX_TIMEOUT_MS = 30_000;

const isFuture = (ts: string, nowMs: number) => Date.parse(ts) > nowMs + MAX_FUTURE_MS;

/** Every ingest write runs here: statement + whole-transaction timeouts (PG17 transaction_timeout). */
export function ingestTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(INGEST_TX_TIMEOUT_MS)}, true), set_config('transaction_timeout', ${String(INGEST_TX_TIMEOUT_MS)}, true)`,
    );
    return fn(tx);
  });
}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------- GDPR scrubbing of free text (contracts §5.2) ----------

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Candidate IPv6 (hex groups with ≥ 2 colons, optional embedded IPv4 tail); validated in scrubText.
const RE_IPV6 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4})?(?![\w:])/gi;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const RE_IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?![\\w]|\\.\\d)`, "g");
const RE_HEX = /\b(?:[0-9a-f]{64}|[0-9a-f]{32})\b/gi;
const UNDASHED_UUID = /^[0-9a-f]{12}[1-8][0-9a-f]{3}[89ab][0-9a-f]{15}$/i;

function isIpv6(m: string): boolean {
  if (!/[0-9a-f]/i.test(m)) return false;
  const groups = m.split(":");
  const hasV4 = m.includes(".");
  if (m.includes("::")) return m.indexOf("::") === m.lastIndexOf("::") && groups.length <= (hasV4 ? 8 : 9);
  return groups.length === (hasV4 ? 7 : 8) && groups.every((g) => g.length > 0);
}

// `scheme://user:pass@` / `scheme://user@` → `scheme://***@` (credentials in JDBC/HTTP/proxy URLs).
const RE_URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
// Home folders carry the OS account name: keep the structure, replace the name with `~`.
const RE_HOME_UNIX = /(\/(?:home|Users)\/)[^/\s:;'"]+/g;
// Windows account names may contain spaces: up to the next separator when there is one, else up to whitespace.
const RE_HOME_WIN = /\b([a-z]:(?:\\+|\/)Users(?:\\+|\/))(?:[^\\/:;'"\r\n]+?(?=[\\/])|[^\\/\s:;'"]+)/gi;
// `password=…`, `token: …`, `api_key=…`, `"password": "…"`, camelCase `apiKey: …` / `dbPassword=…`. The keyword
// must not follow a letter (so `bypass:`, `monkey=` stay), except a lower→Upper camelCase boundary.
// Case-sensitive on purpose (that is how the boundary is seen): each keyword as lower, Capitalised and UPPER.
const SECRET_WORDS = ["password", "passwd", "pwd", "pass", "token", "secret", "key"];
const forms = (w: string) => [w, w[0]!.toUpperCase() + w.slice(1), w.toUpperCase()];
const RE_SECRET_KV = new RegExp(
  `(?:(?<![A-Za-z])(${SECRET_WORDS.flatMap(forms).join("|")})|(?<=[a-z])(${SECRET_WORDS.map((w) => forms(w)[1]).join("|")}))` +
    `(["']?)\\s*[:=]\\s*(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"',;}]+)`,
  "g",
);
// `Authorization: Bearer xyz` / `"authorization": "Basic …"` → `Authorization: ***`; a bare `Bearer <token>` → `Bearer ***`.
const RE_AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|digest|token)\s+)?[^\s"',;}]+/gi;
const RE_BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
// Our own agent keys, wherever they appear.
const RE_TD_KEY = /\btd_(live|test)_\w+/g;

function scrubSecretKv(m: string, word: string | undefined, camel: string | undefined, q: string): string {
  const kw = word ?? camel ?? "";
  const quotedValue = /[:=]\s*["']/.test(m);
  return q || quotedValue ? `${kw}${q}: "***"` : `${kw}=***`;
}

/**
 * Replaces URL userinfo → `***@`, home-folder names → `~`, `secret-ish=value` → `name=***`, UUIDs → <uuid>,
 * IPv4/IPv6 → <ip>, standalone 32/64-hex → <hex>. Names can't be detected here.
 */
export function scrubText(s: string): string {
  try {
    return scrubTextUnsafe(typeof s === "string" ? s : String(s));
  } catch {
    // Never let odd input fail an ingest, and never store text that could not be scrubbed.
    return "[unscrubbable text]";
  }
}

function scrubTextUnsafe(s: string): string {
  return s
    .replace(RE_URL_USERINFO, "$1***@")
    .replace(RE_HOME_UNIX, "$1~")
    .replace(RE_HOME_WIN, "$1~")
    .replace(RE_TD_KEY, "td_$1_***")
    .replace(RE_AUTH_HEADER, "$1***")
    .replace(RE_BEARER, "$1 ***")
    .replace(RE_SECRET_KV, scrubSecretKv)
    .replace(RE_UUID, "<uuid>")
    .replace(RE_IPV6, (m) => (isIpv6(m) ? "<ip>" : m))
    .replace(RE_IPV4, "<ip>")
    .replace(RE_HEX, (m) => (m.length === 32 && UNDASHED_UUID.test(m) ? "<uuid>" : "<hex>"));
}

/** JSON with object keys sorted recursively, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Sum for an int4 column: clamped, so many large (but individually valid) values can't overflow Postgres. */
const sumInt4 = (xs: number[]) => Math.min(sum(xs), INT4_MAX);

export function pingAvg(sample: MetricSample): number | null {
  const pings = sample.players.pings;
  if (!pings || pings.length === 0) return null;
  return sum(pings.map((p) => p.pingMs)) / pings.length;
}

/** Hot columns per METRIC_NAMES. Missing host values → NULL (never 0). */
export function hotValues(s: MetricSample) {
  const h = s.host ?? {};
  const chunkGen = s.world.map((w) => w.chunkGenPerMinute).filter((v): v is number => v !== undefined);
  return {
    tps_1m: s.tick.tps1m,
    mspt_avg: s.tick.msptAvg,
    mspt_p95: s.tick.msptP95,
    mspt_p99: s.tick.msptP99,
    mspt_max: s.tick.msptMax,
    slow_ticks: s.tick.slowTicks.length,
    players: s.players.count,
    ping_avg: pingAvg(s),
    heap_used_bytes: s.jvm.heapUsedBytes,
    heap_max_bytes: s.jvm.heapMaxBytes,
    gc_pause_ms: sum(s.jvm.gcPauses.map((g) => g.totalMs)),
    process_cpu: s.jvm.processCpuLoad,
    loaded_chunks: sumInt4(s.world.map((w) => w.loadedChunks)),
    entities: sumInt4(s.world.map((w) => w.entities)),
    tile_entities: sumInt4(s.world.map((w) => sumInt4(Object.values(w.tileEntitiesByType)))),
    chunk_gen_per_min: chunkGen.length ? sum(chunkGen) : null,
    host_cpu: h.cpuUsage ?? null,
    cpu_temp_c: h.cpuTempC ?? null,
    mem_available_bytes: h.memAvailableBytes ?? null,
    swap_used_bytes: h.swapUsedBytes ?? null,
    disk_used_bytes: h.diskUsedBytes ?? null,
    agent_ms_per_tick: s.agentOverhead.mainThreadMsPerTick,
  };
}

/** Everything that isn't a hot column (and never `players`). */
export function sampleDetail(s: MetricSample) {
  const { cpuUsage: _a, cpuTempC: _b, memAvailableBytes: _c, swapUsedBytes: _d, diskUsedBytes: _e, ...hostRest } =
    s.host ?? {};
  return {
    windowSeconds: s.windowSeconds,
    tick: { tps5m: s.tick.tps5m, tps15m: s.tick.tps15m, tickCount: s.tick.tickCount, slowTicks: s.tick.slowTicks },
    jvm: { heapCommittedBytes: s.jvm.heapCommittedBytes, gcPauses: s.jvm.gcPauses, threadCount: s.jvm.threadCount },
    world: s.world,
    worstChunks: s.worstChunks,
    ...(s.host ? { host: hostRest } : {}),
    agentOverhead: { mainThreadMsMax: s.agentOverhead.mainThreadMsMax, asyncCpuMs: s.agentOverhead.asyncCpuMs },
  };
}

/** Event without player ids, free text scrubbed (scrubText). */
export function sanitizeEvent(e: AgentEvent): AgentEvent {
  switch (e.type) {
    case "player_join":
    case "player_leave": {
      const { playerId: _drop, ...rest } = e;
      return rest;
    }
    case "exception":
      return {
        ...e,
        ...(e.message !== undefined ? { message: scrubText(e.message) } : {}),
        ...(e.topFrames !== undefined ? { topFrames: e.topFrames.map(scrubText) } : {}),
      };
    case "crash":
      return e.detail !== undefined ? { ...e, detail: scrubText(e.detail) } : e;
    case "server_stop":
      return e.reason !== undefined ? { ...e, reason: scrubText(e.reason) } : e;
    default:
      return e;
  }
}

/** Sample with pings replaced by { count, pingAvg }. */
export function sanitizeSample(s: MetricSample) {
  const { players, ...rest } = s;
  return { ...rest, players: { count: players.count, pingAvg: pingAvg(s) } };
}

async function touchServer(tx: Pick<Db, "update">, serverId: string, bootId: string) {
  await tx
    .update(servers)
    .set({ lastSeenAt: sql`now()`, bootId })
    .where(eq(servers.id, serverId));
}

// ---------- hello ----------

/**
 * System properties whose VALUE is kept: harmless, and read by rules (`using.aikars.flags` → jvm-flags rule
 * "aikar-flags-missing") or useful when reading a start line. Every other `-Dname=value` becomes `-Dname=***`:
 * owners put database passwords, webhook URLs and tokens in -D properties, and the agent's name-based
 * redaction can't catch all of them.
 */
const JVM_PROPERTY_ALLOW = new Set([
  "using.aikars.flags",
  "aikars.new.flags",
  "file.encoding",
  "com.mojang.eula.agree",
  "terminal.jline",
  "terminal.ansi",
  "java.awt.headless",
  "log4j2.formatMsgNoLookups",
  "paper.playerconnection.keepalive",
  "disable.watchdog",
]);

/**
 * Server-side scrub of one JVM input argument (defence in depth on top of the agent's redaction).
 * -Xms/-Xmx/-Xss/-XX:* and -Xlog* keep their values (the jvm-flags and gc rules read them); -D values are kept only for
 * JVM_PROPERTY_ALLOW. Everything then goes through scrubText (IPs, home-folder names, URL userinfo,
 * secret=value pairs), so `-XX:HeapDumpPath=/home/bob/x` or `-javaagent:/Users/bob/a.jar` lose the name.
 */
export function scrubJvmFlag(flag: string): string {
  const m = /^-D([^=]+)=([\s\S]*)$/.exec(flag);
  if (m && !JVM_PROPERTY_ALLOW.has(m[1]!)) return `-D${scrubText(m[1]!)}=***`;
  return scrubText(flag);
}

/** Normalised info: plugins and worlds sorted so order changes don't count as a change; JVM flags scrubbed. */
export function normalizeHello(env: IngestEnvelope<HelloPayload>) {
  const p = env.payload;
  const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    agentVersion: env.agentVersion,
    ...p,
    jvm: { ...p.jvm, flags: p.jvm.flags.map(scrubJvmFlag) },
    plugins: byName(p.plugins),
    worlds: byName(p.worlds),
  };
}

export async function storeHello(db: Db, principal: IngestPrincipal, env: IngestEnvelope<HelloPayload>) {
  const info = normalizeHello(env);
  const infoHash = sha256Hex(canonicalJson(info));
  let changed = false;
  await ingestTx(db, async (tx) => {
    // Serialise hellos per server so two concurrent ones can't both open a "current" row.
    await tx.execute(sql`select 1 from ${servers} where ${servers.id} = ${principal.serverId} for update`);
    const current = await tx
      .select({ id: serverInfoHistory.id, infoHash: serverInfoHistory.infoHash })
      .from(serverInfoHistory)
      .where(and(eq(serverInfoHistory.serverId, principal.serverId), isNull(serverInfoHistory.validTo)))
      .limit(1);
    if (current[0]?.infoHash !== infoHash) {
      changed = true;
      if (current[0]) {
        await tx.update(serverInfoHistory).set({ validTo: sql`now()` }).where(eq(serverInfoHistory.id, current[0].id));
      }
      await tx.insert(serverInfoHistory).values({ serverId: principal.serverId, info, infoHash });
    }

    const unique = new Map<string, { plugin: string; version: string }>();
    for (const pl of env.payload.plugins) unique.set(`${pl.name}\u0000${pl.version}`, { plugin: pl.name, version: pl.version });
    if (unique.size > 0) {
      await tx
        .insert(pluginInventoryHistory)
        .values([...unique.values()].map((v) => ({ serverId: principal.serverId, ...v })))
        .onConflictDoUpdate({
          target: [pluginInventoryHistory.serverId, pluginInventoryHistory.plugin, pluginInventoryHistory.version],
          set: { lastSeen: sql`now()` },
        });
    }
    await touchServer(tx, principal.serverId, env.bootId);
    await tx.execute(sql`update servers set first_hello_at = coalesce(first_hello_at, now()) where id = ${principal.serverId}`);
  });
  return { changed };
}

// ---------- metrics ----------

/** Incident detection hook, run inside the metrics transaction while holding the per-server lock. */
export type DetectHook = (tx: Tx, serverId: string, nowMs: number, state: StateRow) => Promise<{ opened: string[]; closed: string[] }>;

export interface StoreMetricsResult {
  inserted: number;
  skippedTooOld: number;
  skippedFuture: number;
  requestSnapshot: boolean;
  /** Samples newly stored by this call (ts ascending): published to the live bus. */
  insertedSamples: MetricSample[];
  detected?: { opened: string[]; closed: string[] };
  detectError?: string;
}

/**
 * Stores samples and (Phase 4) runs incident detection in the same transaction. The per-server lock is taken
 * BEFORE the insert, so two overlapping requests for one server are fully serialised: detection always sees every
 * committed sample and never moves the watermark past someone else's uncommitted ones. Detection runs in a
 * savepoint: if it fails, its writes are rolled back, the error is reported, and the samples are still stored.
 */
export async function storeMetrics(
  db: Db,
  principal: IngestPrincipal,
  env: IngestEnvelope<MetricsPayload>,
  nowMs: number,
  detect?: DetectHook,
): Promise<StoreMetricsResult> {
  // Samples older than the plan's raw retention would be deleted within the hour and could
  // overwrite a complete 1m rollup with a partial one; drop them. The cutoff is rounded UP to the
  // next full hour, so whatever minute a late sample lands in still has all its raw rows.
  const oldest = Math.ceil((nowMs - retentionFor(principal.plan).raw * 86_400_000) / 3_600_000) * 3_600_000;
  const samples = env.payload.samples;
  const notFuture = samples.filter((s) => !isFuture(s.ts, nowMs));
  const keep = notFuture.filter((s) => Date.parse(s.ts) >= oldest);
  const rows = keep.map((s) => ({
    serverId: principal.serverId,
    ts: new Date(s.ts),
    ...hotValues(s),
    detail: sampleDetail(s),
  }));

  return ingestTx(db, async (tx) => {
    const state = detect ? await lockServerState(tx, principal.serverId) : null;
    let inserted = 0;
    let insertedSamples: MetricSample[] = [];
    if (rows.length > 0) {
      // One multi-row insert per request; retries/flushes are idempotent via the (server_id, ts) PK.
      const res = await tx
        .insert(metricSamples)
        .values(rows)
        .onConflictDoNothing()
        .returning({ ts: metricSamples.ts });
      inserted = res.length;
      const got = new Set(res.map((r) => new Date(r.ts).getTime()));
      insertedSamples = keep.filter((s) => got.has(Date.parse(s.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    }
    let detected: StoreMetricsResult["detected"];
    let detectError: string | undefined;
    if (detect && state && inserted > 0) {
      try {
        detected = await tx.transaction((sp) => detect(sp, principal.serverId, nowMs, state));
      } catch (err) {
        detectError = err instanceof Error ? err.message : String(err);
      }
    }
    // Touch the server and consume a pending snapshot request (possibly just set by detection) in one statement.
    // first/last_sample_at (receive time, injected clock) drive the health state: any accepted sample counts.
    const sampleAt = keep.length > 0 ? new Date(nowMs).toISOString() : null;
    const flag = await tx.execute<{ requested: string | null }>(sql`
      with prev as (
        select snapshot_requested_at as requested from servers where id = ${principal.serverId} for update
      )
      update servers s
         set last_seen_at = now(), boot_id = ${env.bootId}, snapshot_requested_at = null,
             last_sample_at = coalesce(${sampleAt}::timestamptz, s.last_sample_at),
             first_sample_at = coalesce(s.first_sample_at, ${sampleAt}::timestamptz)
        from prev
       where s.id = ${principal.serverId}
      returning prev.requested`);
    return {
      inserted,
      skippedTooOld: notFuture.length - keep.length,
      skippedFuture: samples.length - notFuture.length,
      requestSnapshot: flag[0]?.requested != null,
      insertedSamples,
      ...(detected ? { detected } : {}),
      ...(detectError ? { detectError } : {}),
    };
  });
}

/** Queue config.requestSnapshot for a server; delivered (and cleared) with its next metrics response. */
export async function requestSnapshot(db: Pick<Db, "update">, serverId: string): Promise<boolean> {
  const res = await db
    .update(servers)
    .set({ snapshotRequestedAt: sql`now()` })
    .where(eq(servers.id, serverId))
    .returning({ id: servers.id });
  return res.length > 0;
}

// ---------- events ----------

export function eventRow(serverId: string, e: AgentEvent) {
  // Scrubbed before hashing, so the hash never encodes the raw text either.
  const { type, ts, ...data } = sanitizeEvent(e);
  const canonical = canonicalJson(data);
  const tsIso = new Date(ts).toISOString(); // "…Z" and "…+00:00" spellings hash the same
  return {
    serverId,
    ts: new Date(ts),
    type,
    data: data as Record<string, unknown>,
    eventHash: sha256Hex(type + tsIso + canonical),
  };
}

export async function storeEvents(db: Db, principal: IngestPrincipal, env: IngestEnvelope<EventsPayload>, nowMs: number) {
  const valid = env.payload.events.filter((e) => !isFuture(e.ts, nowMs));
  const rows = valid.map((e) => eventRow(principal.serverId, e));
  return ingestTx(db, async (tx) => {
    const res = rows.length > 0 ? await tx.insert(events).values(rows).onConflictDoNothing().returning({ id: events.id }) : [];
    await touchServer(tx, principal.serverId, env.bootId);
    return { inserted: res.length, skippedFuture: env.payload.events.length - valid.length };
  });
}

// ---------- snapshot ----------

export function sanitizeSnapshot(p: SnapshotPayload) {
  return {
    ...p,
    sample: sanitizeSample(p.sample),
    ...(p.threads ? { threads: p.threads.map((t) => ({ ...t, name: scrubText(t.name) })) } : {}),
    recentEvents: p.recentEvents.map(sanitizeEvent),
  };
}

export async function storeSnapshot(db: Db, principal: IngestPrincipal, env: IngestEnvelope<SnapshotPayload>, nowMs: number) {
  const p = env.payload;
  const future = isFuture(p.ts, nowMs);
  return ingestTx(db, async (tx) => {
    const res = future
      ? []
      : await tx
          .insert(incidentSnapshots)
          .values({
            serverId: principal.serverId,
            trigger: p.trigger,
            capturedAt: new Date(p.ts),
            msptP95AtTrigger: p.msptP95AtTrigger,
            snapshot: sanitizeSnapshot(p),
          })
          .onConflictDoNothing()
          .returning({ id: incidentSnapshots.id });
    // Phase 4: link to the incident whose window [startedAt - 60 s, endedAt] contains it (indexed lookup).
    const incidentId = res.length > 0 ? await linkSnapshotToIncident(tx, principal.serverId, Date.parse(p.ts)) : null;
    await touchServer(tx, principal.serverId, env.bootId);
    return { inserted: res.length, skippedFuture: future ? 1 : 0, incidentId };
  });
}
