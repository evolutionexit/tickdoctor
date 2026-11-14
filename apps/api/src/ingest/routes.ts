import { Hono, type Context } from "hono";
import {
  eventsRequest,
  helloRequest,
  metricsRequest,
  snapshotRequest,
  type EventsPayload,
  type HelloPayload,
  type IngestAccepted,
  type IngestEnvelope,
  type MetricSample,
  type MetricsPayload,
  type SnapshotPayload,
} from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import type { ZodError, ZodTypeAny } from "zod";
import type { ClientIpResolver } from "../middleware/client-ip.js";
import type { RateLimitStore } from "../middleware/rate-limit.js";
import { ingestAuth, type IngestEnv, type IngestKeyVerifier } from "./auth.js";
import { readIngestBody } from "./body.js";
import { IngestError, isDataException } from "./errors.js";
import { INGEST_ENDPOINTS, IngestRing, type IngestEndpoint } from "./store.js";
import { storeEvents, storeHello, storeMetrics, storeSnapshot, type DetectHook } from "./storage.js";

export interface IngestRouteDeps {
  verifier: IngestKeyVerifier;
  /** Counts only requests that FAIL auth (see failedAuthPerIpLimit); valid keys use perKeyLimiter. */
  failedAuthPerIpLimiter: RateLimitStore;
  clientIp: ClientIpResolver;
  perKeyLimiter: RateLimitStore;
  /** Contract: snapshots ≤ 1 per 2 min per server (keyed by serverId). */
  snapshotPerServerLimiter: RateLimitStore;
  db: Db;
  /** Set only when INGEST_DEBUG is on: keeps the caller's recent payloads for /v1/debug/last. */
  ring?: IngestRing;
  now: () => number;
  log: (line: string) => void;
  /** Phase 4: incident detection inside the metrics transaction (failures are logged, never fail the ingest). */
  detect?: DetectHook;
  /** Phase 4: server-scope rules after a hello (fire and forget). */
  onHello?: (serverId: string, nowMs: number) => unknown;
  /** Phase 5: live bus, called after the samples were stored (fire and forget). */
  onSamples?: (serverId: string, samples: MetricSample[]) => Promise<unknown>;
  /** Phase 6: alert check after metrics / events were stored (fire and forget; must not throw). */
  onIngested?: (serverId: string) => void;
}

const schemas: Record<IngestEndpoint, ZodTypeAny> = {
  hello: helloRequest,
  metrics: metricsRequest,
  events: eventsRequest,
  snapshot: snapshotRequest,
};

/** Short, value-free summary: paths and zod issue codes of the first 5 issues. */
export function summarizeIssues(err: ZodError): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    const path = i.path.map((p) => String(p).slice(0, 40)).join(".") || "(root)";
    return `${path} (${i.code})`;
  });
  const more = err.issues.length > 5 ? ` (+${err.issues.length - 5} more)` : "";
  return `Invalid fields: ${parts.join(", ")}${more}`.slice(0, 600);
}

type Envelope = { bootId: string; payload: Record<string, unknown> };

function latestOf(samples: MetricSample[]): MetricSample | undefined {
  return samples[samples.length - 1];
}

/** One log line per accepted request. Never includes player ids or the JSON body. */
function summaryLine(
  endpoint: IngestEndpoint,
  data: Envelope,
  rawBytes: number,
  jsonBytes: number,
  stored: string,
): string {
  const p = data.payload;
  let count = 0;
  let sample: MetricSample | undefined;
  if (endpoint === "metrics") {
    const samples = p.samples as MetricSample[];
    count = samples.length;
    sample = latestOf(samples);
  } else if (endpoint === "snapshot") {
    count = 1;
    sample = p.sample as MetricSample;
  } else if (endpoint === "events") {
    count = (p.events as unknown[]).length;
  }
  const f = (n: number | undefined, d = 1) => (n === undefined ? "-" : n.toFixed(d));
  const fields = [
    `ingest ${endpoint}`,
    `boot=${data.bootId.slice(0, 8)}`,
    `n=${count}`,
    `p95=${f(sample?.tick.msptP95)}ms`,
    `players=${sample?.players.count ?? "-"}`,
    `heapMB=${sample ? Math.round(sample.jvm.heapUsedBytes / 1048576) : "-"}`,
    `agentMsPerTick=${f(sample?.agentOverhead.mainThreadMsPerTick, 3)}`,
    `bytes=${rawBytes}${rawBytes !== jsonBytes ? `/${jsonBytes}` : ""}`,
    stored,
  ];
  return fields.join(" ");
}

/**
 * Per client IP, counting ONLY requests that fail auth (missing, malformed, unknown or revoked key).
 *
 * Why not every request: many legitimate agents share one egress IP (a Network-plan owner with 10
 * servers behind one NAT, a shared host's outbound IP), and an attacker sending `Bearer junk` from that
 * IP could otherwise lock all of them out. So the key is always verified first:
 * - a valid key is never counted or blocked here; it relies on the per-key limit;
 * - a failed attempt is counted; once the IP's bucket is full, further failed attempts get 429 instead
 *   of 401 (and when the limiter store is full of live buckets, new IPs' failures get 429 too: fail closed).
 * Cost of verifying first: a well-formed but unknown key costs one indexed lookup by peppered hash
 * (malformed tokens are rejected without touching the DB). Keys are 256-bit random, so guessing one is
 * not feasible regardless of the rate; this limiter only caps noisy misconfigured fleets / scanners.
 */
function failedAuthPerIpLimit(
  deps: Pick<IngestRouteDeps, "failedAuthPerIpLimiter" | "clientIp" | "now">,
): (c: Context<IngestEnv>) => void {
  return (c) => {
    const retryAfter = deps.failedAuthPerIpLimiter.hit(deps.clientIp(c), deps.now());
    if (retryAfter > 0) throw new IngestError(429, "rate_limited", "Too many requests, back off", retryAfter);
  };
}

export function ingestRoutes(deps: IngestRouteDeps) {
  const app = new Hono<IngestEnv>();
  const notifyIngested = (serverId: string) => {
    try {
      deps.onIngested?.(serverId);
    } catch {
      /* alerts must never affect ingest */
    }
  };

  app.use("*", ingestAuth(deps.verifier, failedAuthPerIpLimit(deps)));
  app.use("*", async (c, next) => {
    const retryAfter = deps.perKeyLimiter.hit(c.var.ingest.keyId, deps.now());
    if (retryAfter > 0) throw new IngestError(429, "rate_limited", "Too many requests, back off", retryAfter);
    await next();
  });

  for (const endpoint of INGEST_ENDPOINTS) {
    app.post(`/${endpoint}`, async (c) => {
      const principal = c.var.ingest;
      const body = await readIngestBody(c.req.raw);
      const parsed = schemas[endpoint].safeParse(body.json);
      if (!parsed.success) throw new IngestError(400, "invalid_payload", summarizeIssues(parsed.error));
      const data = parsed.data as Envelope;

      if (endpoint === "snapshot") {
        const retryAfter = deps.snapshotPerServerLimiter.hit(principal.serverId, deps.now());
        if (retryAfter > 0) {
          throw new IngestError(429, "rate_limited", "At most one snapshot per 2 minutes", retryAfter);
        }
      }

      const res: IngestAccepted = { ok: true };
      let stored: string;
      try {
      switch (endpoint) {
        case "hello": {
          const r = await storeHello(deps.db, principal, parsed.data as IngestEnvelope<HelloPayload>);
          stored = `infoChanged=${r.changed}`;
          if (deps.onHello) void Promise.resolve(deps.onHello(principal.serverId, deps.now())).catch(() => {});
          break;
        }
        case "metrics": {
          const r = await storeMetrics(deps.db, principal, parsed.data as IngestEnvelope<MetricsPayload>, deps.now(), deps.detect);
          stored = `stored=${r.inserted}${r.skippedTooOld ? ` tooOld=${r.skippedTooOld}` : ""}${r.skippedFuture ? ` future=${r.skippedFuture}` : ""}`;
          if (r.requestSnapshot) res.config = { requestSnapshot: true };
          if (r.detected?.opened.length) stored += ` incidentOpened=${r.detected.opened.map((x) => x.slice(0, 8)).join(",")}`;
          if (r.detected?.closed.length) stored += ` incidentClosed=${r.detected.closed.map((x) => x.slice(0, 8)).join(",")}`;
          if (r.detectError) deps.log(`incident detection failed server=${principal.serverId.slice(0, 8)}: ${r.detectError}`);
          notifyIngested(principal.serverId);
          if (deps.onSamples) {
            void deps.onSamples(principal.serverId, r.insertedSamples).catch((err: unknown) => {
              deps.log(`live publish failed server=${principal.serverId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }
        case "events": {
          const r = await storeEvents(deps.db, principal, parsed.data as IngestEnvelope<EventsPayload>, deps.now());
          stored = `stored=${r.inserted}${r.skippedFuture ? ` future=${r.skippedFuture}` : ""}`;
          if (r.inserted > 0) notifyIngested(principal.serverId);
          break;
        }
        case "snapshot": {
          const r = await storeSnapshot(deps.db, principal, parsed.data as IngestEnvelope<SnapshotPayload>, deps.now());
          stored = `stored=${r.inserted}${r.skippedFuture ? ` future=${r.skippedFuture}` : ""}${r.incidentId ? ` incident=${r.incidentId.slice(0, 8)}` : ""}`;
          break;
        }
      }
      } catch (err) {
        // A value Postgres can't hold is the sender's fault (400, so a buggy agent drops the batch instead of
        // retrying forever); anything else is a real fault and stays a 500.
        if (isDataException(err)) throw new IngestError(400, "invalid_payload", "A value is out of range or not storable");
        throw err;
      }

      // DEV ONLY: the debug ring keeps the RAW request bodies (unscrubbed: player ids, names, IPs in
      // free text) in memory. It exists only when INGEST_DEBUG=true, which env.ts refuses in production.
      deps.ring?.add(principal.serverId, endpoint, {
        receivedAt: new Date(deps.now()).toISOString(),
        keyId: principal.keyId,
        body: data,
      });
      deps.log(`${summaryLine(endpoint, data, body.rawBytes, body.jsonBytes, stored)} server=${principal.serverId.slice(0, 8)}`);
      return c.json(res, 200);
    });
  }

  return app;
}

/** GET /last?endpoint=metrics — only mounted when INGEST_DEBUG=true; shows only the key's own server. */
export function ingestDebugRoutes(
  deps: Pick<IngestRouteDeps, "verifier" | "failedAuthPerIpLimiter" | "clientIp" | "now"> & { ring: IngestRing },
) {
  const app = new Hono<IngestEnv>();
  app.use("*", ingestAuth(deps.verifier, failedAuthPerIpLimit(deps)));
  app.get("/last", (c) => {
    const q = c.req.query("endpoint") ?? "metrics";
    if (!(INGEST_ENDPOINTS as readonly string[]).includes(q)) {
      throw new IngestError(400, "invalid_payload", `endpoint must be one of ${INGEST_ENDPOINTS.join(", ")}`);
    }
    const endpoint = q as IngestEndpoint;
    const items = deps.ring.list(c.var.ingest.serverId, endpoint);
    return c.json({ ok: true as const, endpoint, count: items.length, items });
  });
  return app;
}
