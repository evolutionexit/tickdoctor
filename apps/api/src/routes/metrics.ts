import { sql } from "drizzle-orm";
import type { MetricName, MetricsResponse } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";

// Metrics read helpers (contracts §5.4). The routes live in routes/servers.ts (session + owner).

export const MAX_POINTS = 2000;
const RAW_MAX_MS = 6 * 3600_000;
const ROLLUP_1M_MAX_MS = 7 * 86_400_000;

type Resolution = MetricsResponse["resolution"];

/**
 * Picks the table and bucket size for a range (contracts §5.4): ≤ 6 h raw (10 s), ≤ 7 d 1m, else 1h.
 * The bucket grows in multiples of the base step until the range fits in MAX_POINTS buckets
 * (+1 for a range that doesn't start on a bucket boundary).
 */
export function pickResolution(fromMs: number, toMs: number): { resolution: Resolution; bucketSeconds: number } {
  const range = toMs - fromMs;
  const [resolution, base]: [Resolution, number] =
    range <= RAW_MAX_MS ? ["raw", 10] : range <= ROLLUP_1M_MAX_MS ? ["1m", 60] : ["1h", 3600];
  const minBucket = range / 1000 / (MAX_POINTS - 1);
  const bucketSeconds = Math.max(base, Math.ceil(minBucket / base) * base);
  return { resolution, bucketSeconds };
}

type Row = { b: Date | string; avg: number | string | null; min: number | string | null; max: number | string | null };
const num = (v: number | string | null) => (v === null ? null : Number(v));

/** Buckets with no rows are simply absent (gaps = server offline). */
export async function queryPoints(
  db: Db,
  serverId: string,
  metric: MetricName,
  resolution: Resolution,
  bucketSeconds: number,
  from: Date,
  to: Date,
): Promise<MetricsResponse["points"]> {
  // `metric` is validated against METRIC_NAMES (zod enum), so it is safe as an identifier.
  const stride = sql.raw(`interval '${bucketSeconds} seconds'`);
  const origin = sql.raw(`timestamptz '1970-01-01T00:00:00Z'`);
  let rows: Row[];
  if (resolution === "raw") {
    const col = sql.identifier(metric);
    rows = await db.execute<Row>(sql`
      select date_bin(${stride}, ts, ${origin}) as b, avg(${col})::float8 as avg, min(${col})::float8 as min, max(${col})::float8 as max
        from metric_samples
       where server_id = ${serverId} and ts >= ${from.toISOString()} and ts < ${to.toISOString()}
       group by b order by b`);
  } else {
    // Re-bucketing rollups: avg weighted by each bucket's sample count (as the 1h rollup does).
    const table = sql.identifier(resolution === "1m" ? "metric_rollups_1m" : "metric_rollups_1h");
    const [a, mn, mx] = [sql.identifier(`${metric}_avg`), sql.identifier(`${metric}_min`), sql.identifier(`${metric}_max`)];
    rows = await db.execute<Row>(sql`
      select date_bin(${stride}, bucket, ${origin}) as b,
             sum(${a} * sample_count) / nullif(sum(sample_count) filter (where ${a} is not null), 0) as avg,
             min(${mn}) as min, max(${mx}) as max
        from ${table}
       where server_id = ${serverId} and bucket >= ${from.toISOString()} and bucket < ${to.toISOString()}
       group by b order by b`);
  }
  return rows.map((r) => [new Date(r.b).toISOString(), num(r.avg), num(r.min), num(r.max)]);
}
