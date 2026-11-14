import { z } from "zod";

// Phase 3 contract: stored metric series + the read endpoint.
// GET /api/servers/:id/metrics?metric=<MetricName>&from=<iso>&to=<iso>

/** Series the API stores as real columns (fast to chart). Everything else lives in jsonb detail. */
export const METRIC_NAMES = [
  "tps_1m",
  "mspt_avg",
  "mspt_p95",
  "mspt_p99",
  "mspt_max",
  "slow_ticks", // count of ticks > 50 ms in the window (capped at 100 by the ingest contract)
  "players",
  "ping_avg", // ms, across online players
  "heap_used_bytes",
  "heap_max_bytes",
  "gc_pause_ms", // total GC pause time in the window, all collectors
  "process_cpu", // 0..1
  "loaded_chunks", // sum over worlds
  "entities", // sum over worlds
  "tile_entities", // sum over worlds
  "chunk_gen_per_min", // sum over worlds
  "host_cpu", // 0..1
  "cpu_temp_c",
  "mem_available_bytes",
  "swap_used_bytes",
  "disk_used_bytes",
  "agent_ms_per_tick", // plugin's own main-thread overhead
] as const;
export const metricName = z.enum(METRIC_NAMES);
export type MetricName = z.infer<typeof metricName>;

export const metricsQuery = z
  .object({
    metric: metricName,
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: "from must be before to", path: ["from"] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 400 * 86_400_000, {
    message: "range too large (max 400 days)",
    path: ["to"],
  });
export type MetricsQuery = z.infer<typeof metricsQuery>;

/**
 * Resolution is picked from the range: ≤ 6 h → "raw" (10 s samples), ≤ 7 d → "1m", else "1h".
 * At most 2,000 points: if the chosen table has more, the API buckets evenly (avg of avgs, min of
 * mins, max of maxes). Buckets without data are omitted (gaps = server offline).
 * Point = [bucketStartIso, avg, min, max]; for raw samples avg = min = max = the value.
 * A null value means the metric wasn't available on that server (e.g. cpu_temp_c on Windows).
 */
export const metricPoint = z.tuple([z.string(), z.number().nullable(), z.number().nullable(), z.number().nullable()]);
export const metricsResponse = z.object({
  metric: metricName,
  resolution: z.enum(["raw", "1m", "1h"]),
  bucketSeconds: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  points: z.array(metricPoint).max(2000),
});
export type MetricsResponse = z.infer<typeof metricsResponse>;
