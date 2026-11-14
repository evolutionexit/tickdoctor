import { sql } from "drizzle-orm";
import {
  DEGRADED,
  OFFLINE_AFTER_SECONDS,
  type LatestSample,
  type ServerHealth,
} from "@tickdoctor/shared";
import type { Exec } from "./db/query.js";
import { iso, isoOrNull, rows } from "./db/query.js";

// THE health function (contract app.ts "Health state"): the web app only displays what this returns.

export interface HealthInput {
  /** First accepted metrics call ever (null = never). */
  firstSampleAt: number | null;
  /** Latest accepted metrics call (receive time). */
  lastSampleAt: number | null;
  /** An incident is open. */
  incidentOpen: boolean;
  /** Medians over the last DEGRADED.windowSeconds of raw samples (null = no data / metric missing). */
  medianMsptP95: number | null;
  medianTps1m: number | null;
  nowMs: number;
}

export function computeHealth(h: HealthInput): ServerHealth {
  if (h.firstSampleAt === null && h.lastSampleAt === null) return "waiting";
  if (h.lastSampleAt === null || h.nowMs - h.lastSampleAt > OFFLINE_AFTER_SECONDS * 1000) return "offline";
  if (h.incidentOpen) return "lagging";
  if ((h.medianMsptP95 !== null && h.medianMsptP95 >= DEGRADED.msptP95) || (h.medianTps1m !== null && h.medianTps1m < DEGRADED.tps1m)) {
    return "degraded";
  }
  return "healthy";
}

export interface ServerState {
  health: ServerHealth;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  lastSeenAt: string | null;
  openIncidentId: string | null;
  latest: LatestSample | null;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Loads everything computeHealth needs (plus the latest sample) for one server. */
export async function loadServerState(db: Exec, serverId: string, nowMs: number): Promise<ServerState> {
  const since = new Date(nowMs - DEGRADED.windowSeconds * 1000).toISOString();
  const [r] = await rows<{
    first_sample_at: Date | null;
    last_sample_at: Date | null;
    last_seen_at: Date | null;
    open_incident_id: string | null;
    med_p95: number | null;
    med_tps: number | null;
  }>(
    db,
    sql`select s.first_sample_at, s.last_sample_at, s.last_seen_at,
               (select i.id from incidents i where i.server_id = s.id and i.ended_at is null limit 1) as open_incident_id,
               m.med_p95, m.med_tps
          from servers s
          left join lateral (
            select percentile_cont(0.5) within group (order by mspt_p95) as med_p95,
                   percentile_cont(0.5) within group (order by tps_1m) as med_tps
              from metric_samples where server_id = s.id and ts >= ${since}::timestamptz
          ) m on true
         where s.id = ${serverId}`,
  );
  const [l] = await rows<{ ts: Date; tps_1m: number | null; mspt_avg: number | null; mspt_p95: number | null; players: number | null }>(
    db,
    sql`select ts, tps_1m, mspt_avg, mspt_p95, players from metric_samples where server_id = ${serverId} order by ts desc limit 1`,
  );
  const ms = (v: Date | null) => (v ? new Date(v).getTime() : null);
  const health = r
    ? computeHealth({
        firstSampleAt: ms(r.first_sample_at),
        lastSampleAt: ms(r.last_sample_at),
        incidentOpen: r.open_incident_id !== null,
        medianMsptP95: n(r.med_p95),
        medianTps1m: n(r.med_tps),
        nowMs,
      })
    : "waiting";
  return {
    health,
    firstSampleAt: isoOrNull(r?.first_sample_at),
    lastSampleAt: isoOrNull(r?.last_sample_at),
    lastSeenAt: isoOrNull(r?.last_seen_at),
    openIncidentId: r?.open_incident_id ?? null,
    latest: l
      ? { ts: iso(l.ts), tps1m: n(l.tps_1m), msptAvg: n(l.mspt_avg), msptP95: n(l.mspt_p95), players: n(l.players) }
      : null,
  };
}
