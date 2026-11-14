import { DETECTOR, type Incident } from "@tickdoctor/shared";

// Pure incident state machine (contracts §6.1), shared by the live detector (raw samples, state persisted in
// server_analysis_state + the open incident row) and the backfill (raw samples and/or 1-min rollups, state in
// memory). No DB, no clock.
//
// Every input is a Point covering [start, end] (ms). Raw sample: end = ts, start = ts - windowSeconds.
// 1-min rollup: start = bucket, end = bucket + 60 s, p95 = mspt_p95_avg (peak = mspt_p95_max), tps = tps_1m_avg
// (minTps = tps_1m_min).
//
// - Open ("mspt"): points with p95 ≥ 50 covering ≥ 30 s without interruption (first.start → last.end).
// - Open ("tps"): points with tps_1m < 18 covering ≥ 90 s (DETECTOR.openTpsSeconds). Catches stall lag (single multi-second ticks) that p95
//   misses. A 1-min bucket over either threshold opens on its own. startedAt = first.start of the run that opened
//   it; if both runs complete on the same point, "mspt" wins.
// - Close "recovered": healthy points (p95 < 40 AND tps_1m ≥ 19, or no TPS value) covering ≥ 120 s (two healthy
//   buckets). endedAt = first.start of that run (when the server was healthy again).
// - Close "offline": the next point ends ≥ 5 min after the previous one (or, live, the clock is ≥ 5 min past the
//   last sample) → endedAt = last point's end (= the last sample's ts).
// - A gap between points larger than GAP_TOLERANCE_MS (but < offline) breaks a run: missing time is not counted
//   as "over" or "under" threshold.
// - Peak p95 / lowest TPS are taken over the points of the opening run and every unhealthy point while open.

export const GAP_TOLERANCE_MS = 15_000;
const OPEN_MS = DETECTOR.openSeconds * 1000;
const OPEN_TPS_MS = DETECTOR.openTpsSeconds * 1000;
const CLOSE_MS = DETECTOR.closeSeconds * 1000;
const OFFLINE_MS = DETECTOR.offlineGapSeconds * 1000;

export type Trigger = Incident["trigger"];

export interface Point {
  start: number;
  end: number;
  p95: number;
  /** Peak p95 inside the point (rollup _max); defaults to p95. */
  peak?: number;
  /** tps_1m (raw) or tps_1m_avg (rollup); undefined/null = not available. */
  tps?: number | null;
  /** Lowest tps inside the point (rollup _min); defaults to tps. */
  minTps?: number | null;
}

export interface OpenState {
  startedAt: number;
  peak: number;
  minTps: number | null;
  trigger: Trigger;
}

export interface DetectorState {
  /** End of the last processed point (live: the detector watermark). */
  lastEnd: number | null;
  /** Nothing open: start of the current p95 ≥ 50 run. Open: start of the current healthy run. */
  streakStart: number | null;
  /** Highest p95 in the current p95 run (nothing open). */
  streakPeak: number | null;
  /** Nothing open: start of the current tps < 18 run. */
  tpsStreakStart: number | null;
  /** Lowest tps in the current tps run. */
  tpsStreakMin: number | null;
  /** Highest p95 in the current tps run (becomes the peak of a tps-opened incident). */
  tpsStreakPeak: number | null;
  open: OpenState | null;
}

export type DetectorEvent =
  | { kind: "open"; startedAt: number; peak: number; minTps: number | null; trigger: Trigger; at: number }
  | { kind: "peak"; peak: number; minTps: number | null }
  | { kind: "close"; startedAt: number; endedAt: number; peak: number; minTps: number | null; reason: "recovered" | "offline" };

const RANK = { medium: 0, high: 1, critical: 2 } as const;

export function severityFor(peak: number, minTps: number | null = null): Incident["severity"] {
  const s = DETECTOR.severity;
  const byMs: Incident["severity"] = peak >= s.criticalFromMs ? "critical" : peak >= s.highFromMs ? "high" : "medium";
  const byTps: Incident["severity"] =
    minTps === null ? "medium" : minTps < s.criticalBelowTps ? "critical" : minTps < s.highBelowTps ? "high" : "medium";
  return RANK[byTps] > RANK[byMs] ? byTps : byMs;
}

export const emptyState = (): DetectorState => ({
  lastEnd: null,
  streakStart: null,
  streakPeak: null,
  tpsStreakStart: null,
  tpsStreakMin: null,
  tpsStreakPeak: null,
  open: null,
});

function resetStreaks(state: DetectorState) {
  state.streakStart = null;
  state.streakPeak = null;
  state.tpsStreakStart = null;
  state.tpsStreakMin = null;
  state.tpsStreakPeak = null;
}

const minOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** Applies one point (must have end > state.lastEnd). Mutates and returns events in order. */
export function step(state: DetectorState, p: Point): DetectorEvent[] {
  const out: DetectorEvent[] = [];
  const peakOf = Math.max(p.p95, p.peak ?? p.p95);
  const tps = p.tps ?? null;
  const tpsMinOf = minOf(tps, p.minTps ?? null);
  const highMspt = p.p95 >= DETECTOR.openMsptP95;
  const lowTps = tps !== null && tps < DETECTOR.openTps1m;
  const healthy = p.p95 < DETECTOR.closeMsptP95 && (tps === null || tps >= DETECTOR.closeTps1m);

  if (state.lastEnd !== null) {
    const gap = p.end - state.lastEnd;
    if (gap >= OFFLINE_MS && state.open) {
      const o = state.open;
      out.push({ kind: "close", startedAt: o.startedAt, endedAt: state.lastEnd, peak: o.peak, minTps: o.minTps, reason: "offline" });
      state.open = null;
      resetStreaks(state);
    } else if (p.start - state.lastEnd > GAP_TOLERANCE_MS) {
      resetStreaks(state); // missing time breaks any run
    }
  }

  if (!state.open) {
    if (highMspt) {
      if (state.streakStart === null) state.streakStart = p.start;
      state.streakPeak = Math.max(state.streakPeak ?? 0, peakOf);
    } else {
      state.streakStart = null;
      state.streakPeak = null;
    }
    if (lowTps) {
      if (state.tpsStreakStart === null) state.tpsStreakStart = p.start;
      state.tpsStreakMin = minOf(state.tpsStreakMin, tpsMinOf);
      state.tpsStreakPeak = Math.max(state.tpsStreakPeak ?? 0, peakOf);
    } else {
      state.tpsStreakStart = null;
      state.tpsStreakMin = null;
      state.tpsStreakPeak = null;
    }
    let trigger: Trigger | null = null;
    if (state.streakStart !== null && p.end - state.streakStart >= OPEN_MS) trigger = "mspt";
    else if (state.tpsStreakStart !== null && p.end - state.tpsStreakStart >= OPEN_TPS_MS) trigger = "tps";
    if (trigger) {
      const startedAt = trigger === "mspt" ? state.streakStart! : state.tpsStreakStart!;
      const peak = trigger === "mspt" ? state.streakPeak! : Math.max(state.tpsStreakPeak ?? 0, state.streakPeak ?? 0, peakOf);
      const minT = minOf(state.tpsStreakMin, tpsMinOf);
      state.open = { startedAt, peak, minTps: minT, trigger };
      resetStreaks(state);
      out.push({ kind: "open", startedAt, peak, minTps: minT, trigger, at: p.end });
    }
  } else {
    if (healthy) {
      if (state.streakStart === null) state.streakStart = p.start;
      if (p.end - state.streakStart >= CLOSE_MS) {
        const o = state.open;
        out.push({ kind: "close", startedAt: o.startedAt, endedAt: state.streakStart, peak: o.peak, minTps: o.minTps, reason: "recovered" });
        state.open = null;
        resetStreaks(state);
      }
    } else {
      state.streakStart = null;
      const o = state.open;
      const newMin = minOf(o.minTps, tpsMinOf);
      if (peakOf > o.peak || newMin !== o.minTps) {
        o.peak = Math.max(o.peak, peakOf);
        o.minTps = newMin;
        out.push({ kind: "peak", peak: o.peak, minTps: o.minTps });
      }
    }
  }
  state.lastEnd = p.end;
  return out;
}

/** True when an open incident should be closed as offline at `nowMs` (no point for ≥ 5 min). */
export function isOffline(state: DetectorState, nowMs: number): boolean {
  return state.open !== null && state.lastEnd !== null && nowMs - state.lastEnd >= OFFLINE_MS;
}
