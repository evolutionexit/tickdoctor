import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ms, rows } from "../db/query.js";
import { ingestTx } from "../ingest/storage.js";
import { emptyState, step, type Point, type Trigger } from "./core.js";
import { insertIncident } from "./store.js";

// `incidents:backfill <serverId> [--from --to]` (contracts §6.1, run by the seed too).
//
// Input: raw samples where they exist in the range (source "raw"); 1-min rollups only for the part of the range
// before the first raw sample (source "rollup_1m"). Both feed the same state machine as the live detector
// (core.ts), so a 1-min bucket ≥ 50 opens (60 s over threshold) and two buckets < 40 close (120 s).
//
// Non-destructive and idempotent: an incident found here that overlaps any existing incident (live or from an
// earlier backfill) is skipped, so re-running changes nothing and live incidents keep their findings. An incident
// still ongoing at the end of the range is left to the live detector, unless the data stopped ≥ 5 min before `to`
// (then it closes as "offline").

export const DEFAULT_BACKFILL_DAYS = 30;
const MIN = 60_000;

export interface BackfillResult {
  created: string[];
  skippedOverlap: number;
  ongoing: boolean;
  points: { raw: number; rollup: number };
}

export async function backfillIncidents(
  db: Db,
  serverId: string,
  opts: { from?: number; to?: number; nowMs?: number; log?: (l: string) => void } = {},
): Promise<BackfillResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const to = opts.to ?? nowMs;
  const from = opts.from ?? to - DEFAULT_BACKFILL_DAYS * 86_400_000;
  if (!(from < to)) throw new Error("--from must be before --to");
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  const [first] = await rows<{ ts: Date | null }>(
    db,
    sql`select min(ts) as ts from metric_samples where server_id = ${serverId} and ts >= ${fromIso}::timestamptz and ts <= ${toIso}::timestamptz`,
  );
  const rawStart = first?.ts ? ms(first.ts) : null;
  const rollupEnd = rawStart ?? to;

  const rollups = await rows<{ bucket: Date; avg: number; max: number | null; tps: number | null; tps_min: number | null }>(
    db,
    sql`select bucket, mspt_p95_avg as avg, mspt_p95_max as max, tps_1m_avg as tps, tps_1m_min as tps_min from metric_rollups_1m
         where server_id = ${serverId} and bucket >= ${fromIso}::timestamptz
           and bucket + interval '1 minute' <= ${new Date(rollupEnd).toISOString()}::timestamptz
           and mspt_p95_avg is not null
         order by bucket`,
  );
  const raw =
    rawStart === null
      ? []
      : await rows<{ ts: Date; p95: number; tps: number | null; w: number | null }>(
          db,
          sql`select ts, mspt_p95 as p95, tps_1m as tps, (detail->>'windowSeconds')::int as w from metric_samples
               where server_id = ${serverId} and ts >= ${new Date(rawStart).toISOString()}::timestamptz
                 and ts <= ${toIso}::timestamptz and mspt_p95 is not null
               order by ts`,
        );

  const points: (Point & { src: "raw" | "rollup_1m" })[] = [
    ...rollups.map((r) => ({ start: ms(r.bucket), end: ms(r.bucket) + MIN, p95: Number(r.avg), peak: r.max === null ? undefined : Number(r.max),
      tps: r.tps === null ? null : Number(r.tps), minTps: r.tps_min === null ? null : Number(r.tps_min), src: "rollup_1m" as const })),
    ...raw.map((r) => {
      const end = ms(r.ts);
      return { start: end - (r.w && r.w > 0 ? r.w : 10) * 1000, end, p95: Number(r.p95), tps: r.tps === null ? null : Number(r.tps), src: "raw" as const };
    }),
  ];

  type Found = { startedAt: number; endedAt: number; peak: number; minTps: number | null; trigger: Trigger; reason: "recovered" | "offline"; source: "raw" | "rollup_1m" };
  const found: Found[] = [];
  const state = emptyState();
  let openSource: "raw" | "rollup_1m" = "raw";
  let openTrigger: Trigger = "mspt";
  for (const p of points) {
    for (const ev of step(state, p)) {
      if (ev.kind === "open") {
        openSource = p.src;
        openTrigger = ev.trigger;
      }
      if (ev.kind === "close") found.push({ ...ev, trigger: openTrigger, source: openSource });
    }
  }
  let ongoing = false;
  if (state.open) {
    if (state.lastEnd !== null && to - state.lastEnd >= 300_000) {
      const o = state.open;
      found.push({ startedAt: o.startedAt, endedAt: state.lastEnd, peak: o.peak, minTps: o.minTps, trigger: o.trigger, reason: "offline", source: openSource });
    } else {
      ongoing = true;
      opts.log?.(`incident since ${new Date(state.open.startedAt).toISOString()} still ongoing; left to the live detector`);
    }
  }

  const result: BackfillResult = { created: [], skippedOverlap: 0, ongoing, points: { raw: raw.length, rollup: rollups.length } };
  for (const f of found) {
    const id = await ingestTx(db, async (tx) => {
      // Serialise with the live detector for this server.
      await tx.execute(sql`insert into server_analysis_state (server_id) values (${serverId}) on conflict do nothing`);
      await tx.execute(sql`select 1 from server_analysis_state where server_id = ${serverId} for update`);
      const overlap = await rows(
        tx,
        sql`select 1 from incidents where server_id = ${serverId}
             and started_at <= ${new Date(f.endedAt).toISOString()}::timestamptz
             and (ended_at is null or ended_at >= ${new Date(f.startedAt).toISOString()}::timestamptz) limit 1`,
      );
      if (overlap.length > 0) return null;
      return insertIncident(tx, {
        serverId,
        startedAt: f.startedAt,
        peak: f.peak,
        minTps: f.minTps,
        trigger: f.trigger,
        source: f.source,
        nowMs,
        end: { endedAt: f.endedAt, reason: f.reason },
      });
    });
    if (id) result.created.push(id);
    else result.skippedOverlap++;
  }
  opts.log?.(
    `backfill ${fromIso} → ${toIso}: ${points.length} points (${raw.length} raw, ${rollups.length} rollup), ` +
      `${result.created.length} incidents created, ${result.skippedOverlap} skipped (overlap)`,
  );
  return result;
}
