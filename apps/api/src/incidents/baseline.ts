import { sql } from "drizzle-orm";
import { METRIC_NAMES, type Baseline, type HelloPayload, type MetricName } from "@tickdoctor/shared";
import { ms, rows, tsArray, type Exec } from "../db/query.js";
import { dict, ownNum } from "../rules/util.js";

// Baseline = what this server looks like when healthy (contracts §6.2), built when an incident opens.
//
// Healthy minute: a 1-min rollup with mspt_p95_avg < 30 that is not within 10 min of any incident. Window: the
// 7 days before startedAt minus the last 10 min; the most recent healthy minutes first, up to 24 h of them.
// < 30 healthy minutes → null. Per-type / per-world medians come from raw samples of those minutes while raw data
// still exists (one sample per healthy minute, which keeps it to ≤ 1,440 small jsonb reads).

export const BASELINE = {
  healthyP95Below: 30,
  lookbackMs: 7 * 86_400_000,
  marginMs: 10 * 60_000,
  maxMinutes: 24 * 60,
  minMinutes: 30,
} as const;

const MIN = 60_000;

/** Linear-interpolated quantile of a sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);
const round = (v: number) => Math.round(v * 1000) / 1000;

const avgCols = sql.join(
  METRIC_NAMES.map((m) => sql`${sql.identifier(`${m}_avg`)}`),
  sql`, `,
);

interface WorldDetail {
  name?: string;
  loadedChunks?: number;
  entities?: number;
  entitiesByType?: Record<string, number>;
  tileEntitiesByType?: Record<string, number>;
}

/** The server_info_history row valid at `atMs` (else the earliest one after it). */
export async function infoAt(db: Exec, serverId: string, atMs: number): Promise<HelloPayload | null> {
  const at = new Date(atMs).toISOString();
  const [r] = await rows<{ info: HelloPayload }>(
    db,
    sql`(select info, 0 as pref, valid_from from server_info_history
          where server_id = ${serverId} and valid_from <= ${at}::timestamptz order by valid_from desc limit 1)
        union all
        (select info, 1 as pref, valid_from from server_info_history
          where server_id = ${serverId} and valid_from > ${at}::timestamptz order by valid_from asc limit 1)
        order by pref limit 1`,
  );
  return r?.info ?? null;
}

export async function buildBaseline(db: Exec, serverId: string, startedAtMs: number): Promise<Baseline | null> {
  const to = startedAtMs - BASELINE.marginMs;
  const from = startedAtMs - BASELINE.lookbackMs;

  // Incidents near the window (any source, open ones count until now).
  const near = await rows<{ s: Date; e: Date | null }>(
    db,
    sql`select started_at as s, ended_at as e from incidents
         where server_id = ${serverId}
           and started_at < ${new Date(to + BASELINE.marginMs).toISOString()}::timestamptz
           and (ended_at is null or ended_at > ${new Date(from - BASELINE.marginMs).toISOString()}::timestamptz)`,
  );
  const excluded = near.map((i) => ({ s: ms(i.s) - BASELINE.marginMs, e: (i.e ? ms(i.e) : Infinity) + BASELINE.marginMs }));

  const minutes = await rows<Record<string, number | null> & { bucket: Date }>(
    db,
    sql`select bucket, ${avgCols} from metric_rollups_1m
         where server_id = ${serverId}
           and bucket >= ${new Date(from).toISOString()}::timestamptz
           and bucket + interval '1 minute' <= ${new Date(to).toISOString()}::timestamptz
           and mspt_p95_avg < ${BASELINE.healthyP95Below}
         order by bucket desc`,
  );
  const healthy: (Record<string, number | null> & { bucket: Date })[] = [];
  for (const m of minutes) {
    const b = ms(m.bucket);
    if (excluded.some((x) => b + MIN > x.s && b < x.e)) continue;
    healthy.push(m);
    if (healthy.length >= BASELINE.maxMinutes) break;
  }
  if (healthy.length < BASELINE.minMinutes) return null;

  const metrics: Baseline["metrics"] = {};
  for (const name of METRIC_NAMES) {
    const vals = healthy.map((h) => h[`${name}_avg`]).filter((v): v is number => v !== null && v !== undefined);
    if (vals.length === 0) continue;
    const sorted = vals.map(Number).sort((a, b) => a - b);
    metrics[name as MetricName] = { median: round(quantile(sorted, 0.5)), p90: round(quantile(sorted, 0.9)) };
  }

  const buckets = healthy.map((h) => ms(h.bucket));
  const firstBucket = Math.min(...buckets);
  const lastBucket = Math.max(...buckets);
  const out: Baseline = {
    from: new Date(firstBucket).toISOString(),
    to: new Date(lastBucket + MIN).toISOString(),
    healthyMinutes: healthy.length,
    metrics,
    plugins: [],
  };

  // Raw detail: the first sample of each healthy minute.
  const raw = await rows<{ world: WorldDetail[] | null }>(
    db,
    sql`select detail->'world' as world from metric_samples
         where server_id = ${serverId}
           and ts >= ${new Date(firstBucket).toISOString()}::timestamptz
           and ts < ${new Date(lastBucket + MIN).toISOString()}::timestamptz
           and date_trunc('minute', ts, 'UTC') = any(${tsArray(buckets)}::timestamptz[])
           and extract(second from ts) < 10`,
  );
  const samples = raw.map((r) => (Array.isArray(r.world) ? r.world : [])).filter((w) => w.length > 0);
  if (samples.length > 0) {
    const perType = (key: "entitiesByType" | "tileEntitiesByType") => {
      const sums = samples.map((worlds) => {
        const acc = dict<number>();
        for (const w of worlds) for (const [t, n] of Object.entries(w[key] ?? {})) acc[t] = ownNum(acc, t) + Number(n);
        return acc;
      });
      const types = new Set(sums.flatMap((s) => Object.keys(s)));
      const res = dict<number>();
      for (const t of types) res[t] = round(median(sums.map((s) => ownNum(s, t))));
      return res;
    };
    out.entitiesByType = perType("entitiesByType");
    out.tileEntitiesByType = perType("tileEntitiesByType");
    const names = [...new Set(samples.flatMap((ws) => ws.map((w) => w.name).filter((n): n is string => !!n)))].sort();
    out.worlds = names.map((name) => {
      const ws = samples.map((s) => s.find((w) => w.name === name));
      const pick = (f: (w: WorldDetail) => number) => round(median(ws.map((w) => (w ? f(w) : 0))));
      return {
        name,
        loadedChunks: pick((w) => w.loadedChunks ?? 0),
        entities: pick((w) => w.entities ?? 0),
        tileEntities: pick((w) => Object.values(w.tileEntitiesByType ?? {}).reduce((a, b) => a + Number(b), 0)),
      };
    });
  }

  const info = await infoAt(db, serverId, lastBucket + MIN);
  if (info) {
    out.plugins = (info.plugins ?? []).map((p) => ({ name: p.name, version: p.version }));
    if (info.config) out.config = { viewDistance: info.config.viewDistance, simulationDistance: info.config.simulationDistance };
    if (info.jvm) out.jvm = { heapMaxBytes: info.jvm.heapMaxBytes, heapInitBytes: info.jvm.heapInitBytes };
  }
  return out;
}
