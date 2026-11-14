import { sql } from "drizzle-orm";
import { DETECTOR } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { ms, rows, type Exec } from "../db/query.js";
import { ingestTx } from "../ingest/storage.js";
import { GAP_TOLERANCE_MS, emptyState, isOffline, step, type DetectorState, type OpenState } from "./core.js";
import { closeIncident, insertIncident, updatePeak } from "./store.js";
import { lockServerState, type StateRow } from "./lock.js";

export { lockServerState };

// Live incident detection (contracts §6.1), run inline after every metrics ingest for that server.
//
// Cheap and replay-safe by construction: it reads only samples with watermark < ts ≤ now (primary-key range scan
// on (server_id, ts)), feeds them in ts order to the pure state machine (core.ts) and stores the new watermark + run
// state. Retries and replays (same ts) are ≤ watermark → ignored. A buffered catch-up batch is just more samples in
// order. Late samples older than the watermark are ignored live (`incidents:backfill` repairs).
//
// Per-server serialisation: lockServerState() (row lock on server_analysis_state). The metrics ingest takes it
// BEFORE inserting and runs detection in the same transaction (ingest/storage.ts storeMetrics), so store + detect
// are atomic per server and the watermark can never move past samples another request hasn't committed yet.

/** First run for a server: don't replay its whole history, start this far back (backfill covers older data). */
export const INITIAL_LOOKBACK_MS = 15 * 60_000;
/** Upper bound of samples per run; a bigger backlog continues on the next ingest or incident-job tick. */
export const MAX_SAMPLES_PER_RUN = 2000;
/** Ask for a snapshot only while the data is live (not for a lag seen in an old catch-up batch). */
const LIVE_DATA_MS = 120_000;
const OFFLINE_MS = DETECTOR.offlineGapSeconds * 1000;

export interface DetectResult {
  processed: number;
  opened: string[];
  closed: string[];
  reopened: string[];
  snapshotRequested: boolean;
}

interface OpenRow {
  id: string;
  started_at: Date;
  peak_mspt_p95: number;
  min_tps_1m: number | null;
  trigger: "mspt" | "tps";
}

/** Read AFTER the lock, in its own statement, so it sees whatever the previous lock holder committed. */
async function openIncidentOf(tx: Exec, serverId: string): Promise<OpenRow | null> {
  const [r] = await rows<OpenRow>(
    tx,
    sql`select id, started_at, peak_mspt_p95, min_tps_1m, trigger from incidents where server_id = ${serverId} and ended_at is null`,
  );
  return r ?? null;
}

const toOpen = (r: OpenRow): OpenState => ({
  startedAt: ms(r.started_at),
  peak: Number(r.peak_mspt_p95),
  minTps: r.min_tps_1m === null ? null : Number(r.min_tps_1m),
  trigger: r.trigger ?? "mspt",
});
const tsOrNull = (v: number | null) => (v === null ? null : new Date(v).toISOString());

async function saveState(tx: Exec, serverId: string, s: DetectorState) {
  await tx.execute(sql`
    update server_analysis_state
       set detector_watermark = ${tsOrNull(s.lastEnd)}::timestamptz,
           streak_start = ${tsOrNull(s.streakStart)}::timestamptz, streak_peak = ${s.streakPeak},
           tps_streak_start = ${tsOrNull(s.tpsStreakStart)}::timestamptz, tps_streak_min = ${s.tpsStreakMin},
           tps_streak_peak = ${s.tpsStreakPeak}, updated_at = now()
     where server_id = ${serverId}`);
}

/**
 * Detection for one server inside a transaction that already holds lockServerState() (`st` is its result).
 * Samples with ts > nowMs (allowed up to 10 min ahead by ingest) wait until the clock passes them.
 */
export async function detectInTx(tx: Exec, serverId: string, nowMs: number, st: StateRow): Promise<DetectResult> {
  const open = await openIncidentOf(tx, serverId);
  const state: DetectorState = {
    lastEnd: st.watermark ? ms(st.watermark) : null,
    streakStart: st.streak_start ? ms(st.streak_start) : null,
    streakPeak: st.streak_peak,
    tpsStreakStart: st.tps_streak_start ? ms(st.tps_streak_start) : null,
    tpsStreakMin: st.tps_streak_min,
    tpsStreakPeak: st.tps_streak_peak,
    open: open ? toOpen(open) : null,
  };
  let openId = open?.id ?? null;
  const since = new Date(state.lastEnd ?? nowMs - INITIAL_LOOKBACK_MS).toISOString();
  const samples = await rows<{ ts: Date; p95: number; tps: number | null; w: number | null }>(
    tx,
    sql`select ts, mspt_p95 as p95, tps_1m as tps, (detail->>'windowSeconds')::int as w from metric_samples
         where server_id = ${serverId} and ts > ${since}::timestamptz and ts <= ${new Date(nowMs).toISOString()}::timestamptz
           and mspt_p95 is not null
         order by ts limit ${MAX_SAMPLES_PER_RUN}`,
  );
  const result: DetectResult = { processed: samples.length, opened: [], closed: [], reopened: [], snapshotRequested: false };
  if (samples.length === 0) return result;

  // An incident closed as "offline" at exactly the watermark, and the next sample continues it without a gap: the
  // agent kept buffering through an outage on our side (or the catch-up arrived in several batches). Reopen it.
  const first = samples[0]!;
  const firstStart = ms(first.ts) - (first.w && first.w > 0 ? first.w : 10) * 1000;
  if (!state.open && state.lastEnd !== null && firstStart - state.lastEnd <= GAP_TOLERANCE_MS) {
    const [prev] = await rows<OpenRow>(
      tx,
      sql`update incidents set ended_at = null, end_reason = null, closed_at = null, updated_at = ${new Date(nowMs).toISOString()}::timestamptz
           where id = (select id from incidents where server_id = ${serverId} and end_reason = 'offline'
                        and ended_at = ${new Date(state.lastEnd).toISOString()}::timestamptz order by started_at desc limit 1)
          returning id, started_at, peak_mspt_p95, min_tps_1m, trigger`,
    );
    if (prev) {
      state.open = toOpen(prev);
      state.streakStart = state.streakPeak = state.tpsStreakStart = state.tpsStreakMin = state.tpsStreakPeak = null;
      openId = prev.id;
      result.reopened.push(prev.id);
    }
  }

  let peakDirty = false;
  for (const s of samples) {
    const end = ms(s.ts);
    const w = s.w && s.w > 0 ? s.w : 10;
    for (const ev of step(state, { start: end - w * 1000, end, p95: Number(s.p95), tps: s.tps === null ? null : Number(s.tps) })) {
      if (ev.kind === "open") {
        openId = await insertIncident(tx, {
          serverId, startedAt: ev.startedAt, peak: ev.peak, minTps: ev.minTps, trigger: ev.trigger, source: "raw", nowMs,
        });
        result.opened.push(openId);
        peakDirty = false;
      } else if (ev.kind === "peak") {
        peakDirty = true;
      } else if (openId) {
        await closeIncident(tx, openId, { endedAt: ev.endedAt, reason: ev.reason, peak: ev.peak, minTps: ev.minTps, nowMs });
        result.closed.push(openId);
        openId = null;
        peakDirty = false;
      }
    }
  }
  if (peakDirty && openId && state.open) await updatePeak(tx, openId, state.open.peak, state.open.minTps, nowMs);
  await saveState(tx, serverId, state);
  if (openId && state.lastEnd !== null && nowMs - state.lastEnd <= LIVE_DATA_MS) {
    result.snapshotRequested = await maybeRequestSnapshot(tx, openId, serverId, nowMs);
  }
  return result;
}

/** Standalone detection run (own transaction + lock). The ingest path uses detectInTx inside storeMetrics. */
export async function detectIncidents(db: Db, serverId: string, nowMs: number): Promise<DetectResult> {
  return ingestTx(db, async (tx) => detectInTx(tx, serverId, nowMs, await lockServerState(tx, serverId)));
}

/** No snapshot linked 30 s after opening → servers.snapshot_requested_at (once per incident). */
async function maybeRequestSnapshot(tx: Exec, incidentId: string, serverId: string, nowMs: number): Promise<boolean> {
  const due = new Date(nowMs - DETECTOR.requestSnapshotAfterSeconds * 1000).toISOString();
  const marked = await rows<{ id: string }>(
    tx,
    sql`update incidents i set snapshot_requested_at = ${new Date(nowMs).toISOString()}::timestamptz
         where i.id = ${incidentId} and i.ended_at is null and i.snapshot_requested_at is null
           and i.opened_at <= ${due}::timestamptz
           and not exists (select 1 from incident_snapshots s where s.incident_id = i.id)
        returning i.id`,
  );
  if (marked.length === 0) return false;
  // Same flag as `cli server:request-snapshot` (ingest/storage.ts requestSnapshot): delivered with the next metrics response.
  await tx.execute(sql`update servers set snapshot_requested_at = now() where id = ${serverId}`);
  return true;
}

/**
 * Periodic part (incident job, every ~15 s), per server with an open incident:
 * - stored samples newer than the watermark (a backlog beyond MAX_SAMPLES_PER_RUN, or samples whose ts was ahead of
 *   the clock) → process them first; never close "offline" while such samples exist (catch-up in progress);
 * - otherwise ≥ 5 min since the last sample AND no contact from the agent for 5 min → close "offline" at the last
 *   sample (a buffered catch-up keeps last_seen_at fresh, so it isn't cut into pieces; see also the reopen above);
 * - otherwise request a snapshot when one is due.
 */
export async function detectorTick(db: Db, nowMs: number): Promise<{ closed: string[]; snapshotRequests: number; caughtUp: number }> {
  const out = { closed: [] as string[], snapshotRequests: 0, caughtUp: 0 };
  const candidates = await rows<{ server_id: string }>(db, sql`select server_id from incidents where ended_at is null`);
  for (const { server_id: serverId } of candidates) {
    await ingestTx(db, async (tx) => {
      const st = await lockServerState(tx, serverId);
      const open = await openIncidentOf(tx, serverId);
      if (!open) return;
      const wm = st.watermark ? ms(st.watermark) : null;
      const [pending] = await rows<{ backlog: boolean; seen: Date | null }>(
        tx,
        sql`select exists(select 1 from metric_samples where server_id = ${serverId}
                            and ts > ${tsOrNull(wm) ?? "-infinity"}::timestamptz and ts <= ${new Date(nowMs).toISOString()}::timestamptz) as backlog,
                   (select last_seen_at from servers where id = ${serverId}) as seen`,
      );
      if (pending?.backlog) {
        await detectInTx(tx, serverId, nowMs, st);
        out.caughtUp++;
        return;
      }
      const state: DetectorState = { ...emptyState(), lastEnd: wm, open: toOpen(open) };
      const recentContact = pending?.seen ? nowMs - ms(pending.seen) < OFFLINE_MS : false;
      if (isOffline(state, nowMs) && !recentContact) {
        await closeIncident(tx, open.id, { endedAt: wm!, reason: "offline", peak: state.open!.peak, minTps: state.open!.minTps, nowMs });
        await tx.execute(sql`update server_analysis_state set streak_start = null, streak_peak = null, tps_streak_start = null,
                             tps_streak_min = null, tps_streak_peak = null, updated_at = now() where server_id = ${serverId}`);
        out.closed.push(open.id);
      } else if (wm !== null && nowMs - wm <= LIVE_DATA_MS) {
        if (await maybeRequestSnapshot(tx, open.id, serverId, nowMs)) out.snapshotRequests++;
      }
    });
  }
  return out;
}
