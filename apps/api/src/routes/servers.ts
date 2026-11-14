import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createServerRequest,
  deleteServerRequest,
  metricsBatchQuery,
  metricsQuery,
  updateServerRequest,
  type MetricName,
  type MetricsResponse,
  type ServerDetail,
  type ServerSummary,
} from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { iso, isoOrNull, rows } from "../db/query.js";
import { HttpError } from "../errors.js";
import { computeHealth } from "../health.js";
import { effectivePlanId, planOf, planSource, storedPlanId } from "../limits.js";
import { LIVE_CHECK_INTERVAL_MS, toLiveStatus, type LiveHub, type LiveMessage, type LiveSubscriber } from "../live/hub.js";
import { bodyLimit } from "../middleware/body-limit.js";
import type { SessionEnv } from "../middleware/session.js";
import { rateLimited } from "../middleware/rate-limit.js";
import { createServerForUser, rotateKey } from "../servers.js";
import { MAX_POINTS, pickResolution, queryPoints } from "./metrics.js";
import { MAX_JSON_BYTES, invalidRequest, parseQuery, readJson } from "./json.js";
import { findLatestAgentJar } from "./downloads.js";
import { nonTipSql } from "../findings/tips.js";
import { incidentV6Cols, toIncidentListItemV6 } from "../incidents/detail.js";

// /api/servers (contract app.ts "Servers" + "Live"). Every :id route goes through authorizeServer first.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEGRADED_WINDOW_S = 300;
export const DOWNLOAD_PATH = "/downloads/agent/latest.jar";
const MAX_RANGE_MS = 400 * 86_400_000;

export interface ServerRouteDeps {
  db: Db;
  now: () => number;
  pepper: string;
  /** api-url in the config snippet (env AGENT_API_URL, default WEB_PUBLIC_URL). */
  agentApiUrl: string;
  agentJarDir: string | undefined;
  /** Dev-only bearer for GET routes (env refuses it in production). */
  adminToken: string | undefined;
  hub: LiveHub;
  /** SSE keepalive (`: ping`) interval; tests shorten it. */
  pingIntervalMs?: number;
}

/** Who may read a server: the owner (session) or, for GET only, the dev admin bearer. */
interface Access {
  serverId: string;
  /** Key for the per-user stream limit. */
  principal: string;
  /** null for the dev admin bearer. */
  userId: string | null;
  sessionIdHash: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * THE ownership check (IDOR guard): every /api/servers/:id route calls it before touching data. Someone else's
 * server, an unknown id and a malformed id all give the same 404 (never 403), so ids can't be probed.
 */
export function serverAccess(db: Db, adminToken: string | undefined) {
  const expected = adminToken ? sha256(adminToken) : undefined;
  return async function authorizeServer(c: Context<SessionEnv>, serverId: string): Promise<Access> {
    const session = c.get("session");
    if (session) {
      if (!UUID.test(serverId)) throw new HttpError(404, "not_found", "Server not found");
      const r = await rows(db, sql`select 1 from servers where id = ${serverId} and owner_id = ${session.user.id}`);
      if (r.length === 0) throw new HttpError(404, "not_found", "Server not found");
      return { serverId, principal: session.user.id, userId: session.user.id, sessionIdHash: session.idHash };
    }
    const auth = c.req.header("authorization");
    if (auth === undefined) throw new HttpError(401, "unauthorized", "Please sign in");
    // Dev-only admin bearer: GET routes only.
    const m = /^Bearer\s+(\S{1,512})$/i.exec(auth.trim());
    const ok = c.req.method === "GET" && expected !== undefined && m !== null && timingSafeEqual(sha256(m[1]!), expected);
    if (!ok) throw new HttpError(401, "unauthorized", "Missing or invalid admin token");
    if (!UUID.test(serverId)) throw new HttpError(404, "not_found", "Server not found");
    const r = await rows(db, sql`select 1 from servers where id = ${serverId}`);
    if (r.length === 0) throw new HttpError(404, "not_found", "Server not found");
    return { serverId, principal: "dev-admin", userId: null, sessionIdHash: null };
  };
}

// ---------- summaries ----------

interface SummaryRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: Date;
  first_sample_at: Date | null;
  last_sample_at: Date | null;
  last_seen_at: Date | null;
  open_incidents: number;
  med_p95: number | null;
  med_tps: number | null;
  l_ts: Date | null;
  l_tps: number | null;
  l_avg: number | null;
  l_p95: number | null;
  l_players: number | null;
  f_id: string | null;
  f_rule: string | null;
  f_sev: string | null;
  f_title: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** One query for any set of servers: health inputs, latest sample, open incidents, top non-info finding. */
async function loadSummaries(db: Db, where: ReturnType<typeof sql>, nowMs: number): Promise<ServerSummary[]> {
  const since = new Date(nowMs - DEGRADED_WINDOW_S * 1000).toISOString();
  const r = await rows<SummaryRow>(
    db,
    sql`select s.id, s.name, s.slug, s.plan, s.created_at, s.first_sample_at, s.last_sample_at, s.last_seen_at,
               (select count(*) from incidents i where i.server_id = s.id and i.ended_at is null)::int as open_incidents,
               m.med_p95, m.med_tps,
               l.ts as l_ts, l.tps_1m as l_tps, l.mspt_avg as l_avg, l.mspt_p95 as l_p95, l.players as l_players,
               f.id as f_id, f.rule_id as f_rule, f.severity as f_sev, f.title as f_title
          from servers s
          left join lateral (
            select percentile_cont(0.5) within group (order by mspt_p95) as med_p95,
                   percentile_cont(0.5) within group (order by tps_1m) as med_tps
              from metric_samples where server_id = s.id and ts >= ${since}::timestamptz
          ) m on true
          left join lateral (
            select ts, tps_1m, mspt_avg, mspt_p95, players from metric_samples
             where server_id = s.id order by ts desc limit 1
          ) l on true
          left join lateral (
            select id, rule_id, severity, title from findings
             where server_id = s.id and status = 'open' and ${nonTipSql(sql`severity`)}
             order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
                      last_seen_at desc
             limit 1
          ) f on true
         where ${where}
         order by s.created_at desc, s.id`,
  );
  const ms = (v: Date | null) => (v ? new Date(v).getTime() : null);
  return r.map((x) => ({
    id: x.id,
    name: x.name,
    slug: x.slug,
    plan: storedPlanId(x.plan),
    createdAt: iso(x.created_at),
    firstSeenAt: isoOrNull(x.first_sample_at),
    lastSeenAt: isoOrNull(x.last_seen_at),
    health: computeHealth({
      firstSampleAt: ms(x.first_sample_at),
      lastSampleAt: ms(x.last_sample_at),
      incidentOpen: x.open_incidents > 0,
      medianMsptP95: num(x.med_p95),
      medianTps1m: num(x.med_tps),
      nowMs,
    }),
    latest: x.l_ts
      ? { ts: iso(x.l_ts), tps1m: num(x.l_tps), msptAvg: num(x.l_avg), msptP95: num(x.l_p95), players: num(x.l_players) }
      : null,
    openIncidents: x.open_incidents,
    topFinding:
      x.f_id && x.f_rule && x.f_sev && x.f_title
        ? ({ id: x.f_id, ruleId: x.f_rule, severity: x.f_sev, title: x.f_title } as ServerSummary["topFinding"])
        : null,
  }));
}

async function loadSummary(db: Db, serverId: string, nowMs: number): Promise<ServerSummary> {
  const [s] = await loadSummaries(db, sql`s.id = ${serverId}`, nowMs);
  if (!s) throw new HttpError(404, "not_found", "Server not found");
  return s;
}

/** "26.2-83-main@f9fb80b" → "Paper 26.2 (build 83)"; anything else → "<software> <version>". */
export function softwareLabel(software: string, version: string): string {
  const m = /^([0-9][\w.]*)-(\d+)(?:-|$)/.exec(version);
  return m ? `${software} ${m[1]} (build ${m[2]})` : `${software} ${version}`.trim();
}

type StoredInfo = {
  agentVersion?: string;
  server?: { software?: string; softwareVersion?: string; minecraftVersion?: string };
  jvm?: { javaVersion?: string; heapMaxBytes?: number; availableProcessors?: number };
  host?: { os?: string; arch?: string; model?: string; totalMemoryBytes?: number };
  config?: { viewDistance?: number; simulationDistance?: number };
  plugins?: unknown[];
};

function toDetailHost(i: StoredInfo): NonNullable<ServerDetail["info"]>["host"] {
  return {
    os: i.host?.os ?? "",
    arch: i.host?.arch ?? "",
    ...(i.host?.model ? { cpuModel: i.host.model } : {}),
    cores: Math.trunc(i.jvm?.availableProcessors ?? 0),
    memTotalBytes: i.host?.totalMemoryBytes ?? 0,
  };
}

function toDetailInfo(i: StoredInfo, validFrom: Date): NonNullable<ServerDetail["info"]> {
  return {
    software: softwareLabel(i.server?.software ?? "", i.server?.softwareVersion ?? ""),
    minecraftVersion: i.server?.minecraftVersion ?? "",
    javaVersion: i.jvm?.javaVersion ?? "",
    agentVersion: i.agentVersion ?? "",
    host: toDetailHost(i),
    viewDistance: Math.trunc(i.config?.viewDistance ?? 0),
    simulationDistance: Math.trunc(i.config?.simulationDistance ?? 0),
    heapMaxBytes: i.jvm?.heapMaxBytes ?? 0,
    plugins: Array.isArray(i.plugins) ? i.plugins.length : 0,
    since: iso(validFrom),
  };
}

export async function loadDetail(db: Db, serverId: string, nowMs: number): Promise<ServerDetail> {
  const summary = await loadSummary(db, serverId, nowMs);
  const [k] = await rows<{ prefix: string; created_at: Date }>(
    db,
    sql`select prefix, created_at from api_keys where server_id = ${serverId} and revoked_at is null order by created_at desc limit 1`,
  );
  const [h] = await rows<{ info: StoredInfo; valid_from: Date }>(
    db,
    sql`select info, valid_from from server_info_history where server_id = ${serverId} and valid_to is null order by valid_from desc limit 1`,
  );
  const info: ServerDetail["info"] = h ? toDetailInfo(h.info, h.valid_from) : null;
  return { ...summary, keyPrefix: k?.prefix ?? null, keyCreatedAt: isoOrNull(k?.created_at), info };
}

const incidentsQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  status: z.enum(["open", "closed"]).optional(),
});

const toMetricsResponse = async (db: Db, id: string, metric: MetricName, from: Date, to: Date): Promise<MetricsResponse> => {
  const { resolution, bucketSeconds } = pickResolution(from.getTime(), to.getTime());
  const points = await queryPoints(db, id, metric, resolution, bucketSeconds, from, to);
  return { metric, resolution, bucketSeconds, from: from.toISOString(), to: to.toISOString(), points: points.slice(0, MAX_POINTS) };
};

type Ctx = Context<SessionEnv>;
type Authorize = ReturnType<typeof serverAccess>;

// Every :id route is mounted with that param, so it is always present.
const serverIdParam = (c: Ctx) => c.req.param("id") as string;

const requireSessionUser = (c: Ctx) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Please sign in");
  return s.user;
};

const setupPayload = async (deps: ServerRouteDeps, key: string, keyPrefix: string) => {
  const jar = await findLatestAgentJar(deps.agentJarDir);
  return {
    apiKey: key,
    keyPrefix,
    configSnippet: `api-url: "${deps.agentApiUrl}"\napi-key: "${key}"\n`,
    downloadUrl: DOWNLOAD_PATH,
    agentVersion: jar?.version ?? "",
  };
};

const listServersHandler = (deps: ServerRouteDeps) => async (c: Ctx) => {
  const user = requireSessionUser(c);
  const servers = await loadSummaries(deps.db, sql`s.owner_id = ${user.id}`, deps.now());
  return c.json({ servers, limits: { plan: effectivePlanId(user.plan), planSource: planSource(user.plan), maxServers: planOf(user.plan).servers, used: servers.length } }, 200);
};

const createServerHandler = (deps: ServerRouteDeps) => async (c: Ctx) => {
  const user = requireSessionUser(c);
  const body = await readJson(c, createServerRequest);
  const r = await createServerForUser(deps.db, deps.pepper, user.id, body.name);
  if (r === "no_user") throw new HttpError(401, "unauthorized", "Please sign in");
  if (r === "email_not_verified") throw new HttpError(403, "email_not_verified", "Confirm your email address before adding a server");
  if (r === "plan_limit") throw new HttpError(402, "plan_limit", "Your plan has no free server slot left");
  const server = await loadSummary(deps.db, r.serverId, deps.now());
  return c.json({ server, setup: await setupPayload(deps, r.key, r.keyPrefix) }, 201);
};

const getServerHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  return c.json(await loadDetail(deps.db, serverId, deps.now()), 200);
};

const patchServerHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const body = await readJson(c, updateServerRequest);
  await deps.db.execute(sql`update servers set name = ${body.name} where id = ${serverId}`);
  return c.json(await loadDetail(deps.db, serverId, deps.now()), 200);
};

const deleteServerHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const body = await readJson(c, deleteServerRequest);
  const [s] = await rows<{ name: string }>(deps.db, sql`select name from servers where id = ${serverId}`);
  if (!s || body.confirmName.trim() !== s.name) {
    throw new HttpError(400, "invalid_request", "Type the server's name to confirm", {}, { confirmName: "Doesn't match the server's name" });
  }
  await deps.db.execute(sql`delete from servers where id = ${serverId}`);
  deps.hub.closeServer(serverId);
  return c.json({ ok: true as const }, 200);
};

const rotateKeyHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const r = await rotateKey(deps.db, deps.pepper, serverId);
  if (!r) throw new HttpError(404, "not_found", "Server not found");
  return c.json(await setupPayload(deps, r.key, r.keyPrefix), 200);
};

const firstDataHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const [s] = await rows<{ first_hello_at: Date | null; first_sample_at: Date | null }>(
    deps.db,
    sql`select first_hello_at, first_sample_at from servers where id = ${serverId}`,
  );
  const [h] = await rows<{ info: StoredInfo }>(
    deps.db,
    sql`select info from server_info_history where server_id = ${serverId} and valid_to is null order by valid_from desc limit 1`,
  );
  const summary = await loadSummary(deps.db, serverId, deps.now());
  return c.json(
    {
      received: Boolean(s?.first_hello_at || s?.first_sample_at),
      helloAt: isoOrNull(s?.first_hello_at),
      firstSampleAt: isoOrNull(s?.first_sample_at),
      software: h ? softwareLabel(h.info.server?.software ?? "", h.info.server?.softwareVersion ?? "") : null,
      agentVersion: h?.info.agentVersion ?? null,
      health: summary.health,
    },
    200,
  );
};

const incidentsHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const q = parseQuery(c, incidentsQuery);
  const to = q.to ? new Date(q.to) : new Date(deps.now());
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from.getTime() >= to.getTime()) throw new HttpError(400, "invalid_request", "from must be before to", {}, { from: "from must be before to" });
  const r = await rows(
    deps.db,
    sql`select ${incidentV6Cols} from incidents i
         where i.server_id = ${serverId} and i.started_at <= ${to.toISOString()}::timestamptz
           and (i.ended_at is null or i.ended_at >= ${from.toISOString()}::timestamptz)
           ${q.status === "open" ? sql`and i.ended_at is null` : q.status === "closed" ? sql`and i.ended_at is not null` : sql``}
         order by i.started_at desc limit ${q.limit}`,
  );
  const incidents = r.map(toIncidentListItemV6);
  return c.json({ incidents }, 200);
};

const metricsHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const parsed = metricsQuery.safeParse(c.req.query());
  if (!parsed.success) throw invalidRequest(parsed.error);
  const q = parsed.data;
  return c.json(await toMetricsResponse(deps.db, serverId, q.metric, new Date(q.from), new Date(q.to)), 200);
};

const metricsBatchHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const { serverId } = await authorize(c, serverIdParam(c));
  const q = parseQuery(c, metricsBatchQuery);
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (from.getTime() >= to.getTime()) throw new HttpError(400, "invalid_request", "from must be before to", {}, { from: "from must be before to" });
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new HttpError(400, "invalid_request", "range too large (max 400 days)", {}, { to: "range too large (max 400 days)" });
  const metrics = [...new Set(q.metrics)];
  const series = await Promise.all(metrics.map((m) => toMetricsResponse(deps.db, serverId, m, from, to)));
  return c.json({ series }, 200);
};

/** The newest stored sample as the SSE "sample" payload (null when the server has none). */
async function latestSamplePayload(db: Db, serverId: string) {
  const [l] = await rows<{
    ts: Date; tps_1m: number | null; mspt_avg: number | null; mspt_p95: number | null; players: number | null;
    host_cpu: number | null; cpu_temp_c: number | null; heap_used_bytes: number | null; heap_max_bytes: number | null;
    mem_available_bytes: number | null; swap_used_bytes: number | null;
  }>(
    db,
    sql`select ts, tps_1m, mspt_avg, mspt_p95, players, host_cpu, cpu_temp_c, heap_used_bytes, heap_max_bytes,
               mem_available_bytes, swap_used_bytes
          from metric_samples where server_id = ${serverId} order by ts desc limit 1`,
  );
  if (!l) return null;
  return {
    ts: iso(l.ts), tps1m: num(l.tps_1m), msptAvg: num(l.mspt_avg), msptP95: num(l.mspt_p95), players: num(l.players),
    hostCpu: num(l.host_cpu), cpuTempC: num(l.cpu_temp_c), heapUsedBytes: num(l.heap_used_bytes),
    heapMaxBytes: num(l.heap_max_bytes), memAvailableBytes: num(l.mem_available_bytes), swapUsedBytes: num(l.swap_used_bytes),
  };
}

const liveHandler = (deps: ServerRouteDeps, authorize: Authorize) => async (c: Ctx) => {
  const access = await authorize(c, serverIdParam(c));
  const { serverId, principal } = access;
  if (!deps.hub.acquireStream(principal)) throw rateLimited(Math.ceil(LIVE_CHECK_INTERVAL_MS / 1000));
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let unsubscribe: (() => void) | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    // One exit path for client disconnect, hub close (session/ownership gone) and errors.
    const finish = () => {
      if (!finished) {
        finished = true;
        unsubscribe?.();
        if (ping) clearInterval(ping);
        deps.hub.releaseStream(principal);
      }
      resolveClosed();
    };
    stream.onAbort(finish);
    c.req.raw.signal?.addEventListener("abort", finish, { once: true });
    if (c.req.raw.signal?.aborted) finish();
    try {
      const send = (msg: LiveMessage) => {
        void stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) });
      };
      // Subscribe before loading the initial state so samples published in between are kept (buffered).
      const buffered: LiveMessage[] = [];
      let ready = false;
      const sub: LiveSubscriber = {
        serverId,
        userId: access.userId,
        sessionIdHash: access.sessionIdHash,
        send: (msg) => (ready ? send(msg) : buffered.push(msg)),
        close: finish,
      };
      if (!finished) unsubscribe = deps.hub.subscribe(sub);
      await stream.write("retry: 5000\n\n");
      const state = await deps.hub.initSubscriber(sub);
      await stream.writeSSE({ event: "status", data: JSON.stringify(toLiveStatus(state)) });
      if (state.latest) {
        const sample = await latestSamplePayload(deps.db, serverId);
        if (sample) await stream.writeSSE({ event: "sample", data: JSON.stringify(sample) });
      }
      ready = true;
      // Only samples are worth replaying: statuses before initSubscriber are older than the initial one.
      for (const m of buffered.splice(0)) if (m.event === "sample") send(m);
      if (!finished) ping = setInterval(() => void stream.write(": ping\n\n"), deps.pingIntervalMs ?? LIVE_CHECK_INTERVAL_MS);
      await closed;
    } finally {
      finish();
    }
  });
};

export function serverRoutes(deps: ServerRouteDeps) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));
  const authorize = serverAccess(deps.db, deps.adminToken);

  app.get("/", listServersHandler(deps));
  app.post("/", createServerHandler(deps));
  app.get("/:id", getServerHandler(deps, authorize));
  app.patch("/:id", patchServerHandler(deps, authorize));
  app.delete("/:id", deleteServerHandler(deps, authorize));
  app.post("/:id/rotate-key", rotateKeyHandler(deps, authorize));
  app.get("/:id/first-data", firstDataHandler(deps, authorize));
  app.get("/:id/incidents", incidentsHandler(deps, authorize));
  app.get("/:id/metrics", metricsHandler(deps, authorize));
  app.get("/:id/metrics/batch", metricsBatchHandler(deps, authorize));
  app.get("/:id/live", liveHandler(deps, authorize));

  return app;
}
