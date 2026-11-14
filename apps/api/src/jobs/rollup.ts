import { sql, type SQL } from "drizzle-orm";
import { METRIC_NAMES } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";

// Raw → metric_rollups_1m → metric_rollups_1h (contracts §5.3).
//
// Late-data correctness: every run recomputes every minute/hour bucket touched by raw rows whose
// received_at lies in [lo, hi), then stores hi as the watermark (job_state 'rollup'); the next run
// starts at lo = watermark - overlap.
//
// received_at defaults to now() = the ingest transaction's START time, and such a transaction may
// commit after a rollup run whose clock is already past that start. So hi is not simply the clock:
// it is capped at the oldest xact_start of any other transaction still open in this database
// (pg_stat_activity). Every row not yet visible therefore has received_at >= hi and is picked up
// by a later run, however long its transaction took. Ingest transactions are capped at
// INGEST_TX_TIMEOUT_MS (storage.ts), so transactions older than STALE_XACT_SECONDS cannot be
// ingest ones and are ignored (a forgotten idle-in-transaction psql session must not freeze the
// rollups). The overlap is only belt-and-braces now (e.g. the instant between a backend taking
// its transaction timestamp and publishing it in pg_stat_activity). Recomputing a bucket from all
// its rows + upsert is idempotent, so the overlap only costs a little repeated work.
//
// All bucketing is explicit UTC: date_trunc(unit, ts, 'UTC') (the session is UTC too, db/client.ts).

export const ROLLUP_LOCK_KEY = 7_301_001;
export const ROLLUP_JOB = "rollup";
export const DEFAULT_OVERLAP_SECONDS = 120;
export const STALE_XACT_SECONDS = 600;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Pick<Db, "execute"> | Tx;

const id = (s: string): SQL => sql`${sql.identifier(s)}`;
const join = (parts: SQL[]) => sql.join(parts, sql`, `);

const rollupColumnList = join(
  METRIC_NAMES.flatMap((m) => [id(`${m}_avg`), id(`${m}_min`), id(`${m}_max`)]),
);
const upsertSet = join([
  sql`sample_count = excluded.sample_count`,
  ...METRIC_NAMES.flatMap((m) =>
    ["avg", "min", "max"].map((k) => sql`${id(`${m}_${k}`)} = excluded.${id(`${m}_${k}`)}`),
  ),
]);
/** From raw samples: plain avg/min/max per column. */
const rawAggregates = join(
  METRIC_NAMES.flatMap((m) => [
    sql`avg(m.${id(m)})::float8`,
    sql`min(m.${id(m)})::float8`,
    sql`max(m.${id(m)})::float8`,
  ]),
);
/** From 1m rollups: avg weighted by sample count (over buckets where the metric existed), min of mins, max of maxes. */
const minuteAggregates = join(
  METRIC_NAMES.flatMap((m) => {
    const a = id(`${m}_avg`);
    return [
      sql`sum(r.${a} * r.sample_count) / nullif(sum(r.sample_count) filter (where r.${a} is not null), 0)`,
      sql`min(r.${id(`${m}_min`)})`,
      sql`max(r.${id(`${m}_max`)})`,
    ];
  }),
);

/** Recomputes the 1m buckets of `touched` (a SQL select yielding server_id, bucket). */
function upsertMinutes(touched: SQL) {
  return sql`
    with touched as (${touched})
    insert into metric_rollups_1m (server_id, bucket, sample_count, ${rollupColumnList})
    select m.server_id, date_trunc('minute', m.ts, 'UTC') as b, count(*)::int, ${rawAggregates}
      from metric_samples m
      join touched t on t.server_id = m.server_id and m.ts >= t.bucket and m.ts < t.bucket + interval '1 minute'
     group by m.server_id, b
    on conflict (server_id, bucket) do update set ${upsertSet}`;
}

/** Recomputes the 1h buckets of `touched` (server_id, bucket = hour start) from 1m rollups. */
function upsertHours(touched: SQL) {
  return sql`
    with touched as (${touched})
    insert into metric_rollups_1h (server_id, bucket, sample_count, ${rollupColumnList})
    select r.server_id, date_trunc('hour', r.bucket, 'UTC') as b, sum(r.sample_count)::int, ${minuteAggregates}
      from metric_rollups_1m r
      join touched t on t.server_id = r.server_id and r.bucket >= t.bucket and r.bucket < t.bucket + interval '1 hour'
     group by r.server_id, b
    on conflict (server_id, bucket) do update set ${upsertSet}`;
}

export interface RollupResult {
  skipped: boolean;
  minutes: number;
  hours: number;
}

/** One single-flight run (transaction-scoped advisory lock; a concurrent run returns skipped). */
export async function runRollup(db: Db, opts: { overlapSeconds?: number } = {}): Promise<RollupResult> {
  const overlap = sql.raw(`interval '${Math.max(0, Math.floor(opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS))} seconds'`);
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${ROLLUP_LOCK_KEY}) as locked`);
    if (!lock[0]?.locked) return { skipped: true, minutes: 0, hours: 0 };

    const state = await tx.execute<{ lo: string; hi: string }>(sql`
      with clock as (select clock_timestamp() as c)
      select (coalesce((select watermark from job_state where name = ${ROLLUP_JOB}), '-infinity'::timestamptz) - ${overlap})::text as lo,
             least(
               (select c from clock),
               (select min(a.xact_start) from pg_stat_activity a, clock
                 where a.datname = current_database() and a.pid <> pg_backend_pid()
                   and a.xact_start is not null
                   and a.xact_start > clock.c - ${sql.raw(`interval '${STALE_XACT_SECONDS} seconds'`)})
             )::text as hi`);
    const { lo, hi } = state[0]!;
    // Half-open [lo, hi): a row stamped exactly hi belongs to a transaction that was still open.
    const changed = (unit: "minute" | "hour") => sql`
      select distinct server_id, date_trunc(${unit}, ts, 'UTC') as bucket
        from metric_samples where received_at >= ${lo}::timestamptz and received_at < ${hi}::timestamptz`;

    const minutes = await tx.execute(upsertMinutes(changed("minute")));
    const hours = await tx.execute(upsertHours(changed("hour")));
    await tx.execute(sql`
      insert into job_state (name, watermark, updated_at) values (${ROLLUP_JOB}, ${hi}::timestamptz, now())
      on conflict (name) do update set watermark = excluded.watermark, updated_at = now()`);
    return { skipped: false, minutes: minutes.count ?? 0, hours: hours.count ?? 0 };
  });
}

/** Rebuilds 1h rollups from 1m for a server and time range (seed writes 1m directly). */
export async function rebuildHoursFromMinutes(db: Exec, serverId: string, from: Date, to: Date) {
  await db.execute(
    upsertHours(sql`
      select distinct server_id, date_trunc('hour', bucket, 'UTC') as bucket from metric_rollups_1m
       where server_id = ${serverId} and bucket >= ${from.toISOString()} and bucket < ${to.toISOString()}`),
  );
}
