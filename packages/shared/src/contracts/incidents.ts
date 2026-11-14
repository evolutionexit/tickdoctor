import { z } from "zod";
import { METRIC_NAMES, type MetricName } from "./metrics";

// Phase 4 contract (frozen): incident detection + baselines (apps/api/src/incidents/).

/**
 * Detection runs inline after every metrics ingest, per server, over samples in ts order. Buffered catch-up
 * batches are processed in order; samples older than the server's detector watermark (already-processed time)
 * are ignored live and repaired by backfill. Store + detect for one server are serialised by a per-server lock.
 * The offline close never fires while stored samples newer than the watermark exist (catch-up in progress). State lives in the `incidents` table (an open incident has endedAt = null) plus the
 * recent samples, so a restart of the API loses nothing.
 */
export const DETECTOR = {
  /** Open when MSPT p95 ≥ openMsptP95 for at least openSeconds of consecutive samples. */
  openMsptP95: 50,
  openSeconds: 30,
  /**
   * Also open when TPS (1-min average) stays below openTps1m for at least openTpsSeconds. Catches "stall" lag:
   * single multi-second ticks (chunk generation, forceload, world saves) that p95 misses because each is one tick.
   * Added in Phase 4 after the real Pi chunk-generation run (TPS 11.8 with p95 < 10 ms).
   */
  openTps1m: 18,
  openTpsSeconds: 90, // 90 not 60: tps_1m is a moving average, so one ~6 s stall alone keeps it < 18 for ~60 s (review M4)
  /** Close when MSPT p95 < closeMsptP95 AND tps_1m ≥ closeTps1m for at least closeSeconds (hysteresis). */
  closeMsptP95: 40,
  closeTps1m: 19,
  closeSeconds: 120,
  /** No samples for this long while open → close at the last sample, endReason "offline". */
  offlineGapSeconds: 300,
  /** Severity = the worse of: peak MSPT p95 (below highFromMs → medium) and lowest tps_1m (below highBelowTps → high, below criticalBelowTps → critical). */
  severity: { highFromMs: 100, criticalFromMs: 250, highBelowTps: 15, criticalBelowTps: 10 },
  /** A snapshot captured in [startedAt - snapshotLeadSeconds, endedAt] is linked to the incident. */
  snapshotLeadSeconds: 60,
  /** If no snapshot is linked this long after opening, set servers.snapshot_requested_at (agent sends one). */
  requestSnapshotAfterSeconds: 30,
  /** Incident rules run once the snapshot is linked, or after this timeout without one. */
  rulesTimeoutSeconds: 90,
} as const;

/**
 * Backfill (CLI `incidents:backfill <serverId> [--from --to]`, also run by the seed) uses metric_rollups_1m
 * when raw samples are gone: a 1-min bucket with mspt_p95_avg ≥ 50 (or tps_1m_avg < 18) counts as 60 s over
 * threshold, two healthy buckets close it. Incidents found this way have source "rollup_1m" and no snapshot unless one was stored.
 */
export const incidentSource = z.enum(["raw", "rollup_1m"]);
export const incidentEndReason = z.enum(["recovered", "offline"]);

/**
 * Baseline = what this server looks like when healthy, built when an incident opens (and stored on the incident
 * and on its snapshot). Healthy minute = 1-min rollup with mspt_p95_avg < 30 that is not within 10 min of any
 * incident. Window: the 7 days before startedAt minus the last 10 min; the most recent healthy minutes first, up
 * to 24 h of them. Fewer than 30 healthy minutes → baseline null (rules must cope; they then fire only on
 * absolute thresholds, never on "vs baseline" comparisons).
 */
export const baselineStat = z.object({ median: z.number(), p90: z.number() });
export const baseline = z.object({
  from: z.string(),
  to: z.string(),
  healthyMinutes: z.number().int(),
  /** From 1-min rollups (the _avg column). Metrics with no data are omitted. */
  metrics: z.record(z.enum(METRIC_NAMES), baselineStat),
  /** Medians over raw samples' detail in the baseline window, summed over worlds (omitted when no raw data is left). */
  entitiesByType: z.record(z.string(), z.number()).optional(),
  tileEntitiesByType: z.record(z.string(), z.number()).optional(),
  /** Per-world medians of loaded chunks / entities (omitted when no raw data is left). */
  worlds: z
    .array(z.object({ name: z.string(), loadedChunks: z.number(), entities: z.number(), tileEntities: z.number() }))
    .optional(),
  /** State at the end of the baseline window (from server_info_history / plugin_inventory_history). */
  plugins: z.array(z.object({ name: z.string(), version: z.string() })),
  config: z.object({ viewDistance: z.number().int(), simulationDistance: z.number().int() }).optional(),
  jvm: z.object({ heapMaxBytes: z.number(), heapInitBytes: z.number() }).optional(),
});
export type Baseline = z.infer<typeof baseline>;
export type BaselineMetrics = Partial<Record<MetricName, { median: number; p90: number }>>;

export const incident = z.object({
  id: z.string().uuid(),
  serverId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: incidentEndReason.nullable(),
  severity: z.enum(["medium", "high", "critical"]),
  peakMsptP95: z.number(),
  /** Lowest tps_1m during the incident (null when no TPS data). */
  minTps1m: z.number().nullable(),
  /** What opened it: sustained high p95 ("mspt"), sustained low TPS ("tps"). */
  trigger: z.enum(["mspt", "tps"]),
  source: incidentSource,
  snapshotId: z.string().uuid().nullable(),
  baseline: baseline.nullable(),
  /** When incident rules last ran ("opened" pass and "closed" pass). */
  rulesEvaluatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Incident = z.infer<typeof incident>;
