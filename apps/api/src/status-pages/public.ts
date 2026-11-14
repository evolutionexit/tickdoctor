import { sql } from "drizzle-orm";
import type { PublicStatus, ServerHealth } from "@tickdoctor/shared";
import { iso, isoOrNull, rows, type Exec } from "../db/query.js";
import { loadServerState } from "../health.js";
import { retentionFor } from "../limits.js";
import { canHideBranding } from "./settings.js";

// Public status (contract app-phase7.ts publicStatus). Everything here is reachable without auth: build the response
// field by field from an allow-list, never by spreading a row.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Agent default metrics-interval-seconds (contract metrics.ts "raw (10 s samples)"); used when nothing is known. */
export const DEFAULT_INTERVAL_SECONDS = 10;

/** Simplified public view of THE health state (health.ts computeHealth). */
export function publicState(h: ServerHealth): PublicStatus["state"] {
  switch (h) {
    case "healthy":
      return "operational";
    case "degraded":
      return "degraded";
    case "lagging":
      return "lagging";
    default:
      return "offline"; // offline, waiting
  }
}

export interface HourData {
  /** Hour start (ms). */
  hourMs: number;
  /** 1-min rollup buckets in this hour that lie inside the window being computed. */
  minutes: number;
  /** sample_count of the 1-h rollup for this hour (null = no 1-h row). */
  hourSamples: number | null;
}

/**
 * Uptime = share of minutes covered by samples over [start, end), in percent with one decimal.
 *
 * The agent's sample interval I (metrics-interval-seconds, 5–300 s) matters: one sample covers I seconds.
 *  - 1-min rollups: each row is a minute with at least one sample; with I > 60 s a row stands for I / 60 minutes
 *    (a 300 s agent writes one row every 5 minutes, which is fully up).
 *  - 1-h rollups (older periods: plans keep 1-min rollups for 3–30 days): minutes covered ≈ sample_count × I / 60,
 *    capped at 60, scaled by how much of the hour lies inside the window (APPROXIMATION: samples are assumed to be
 *    spread evenly over the hour and to arrive every I seconds).
 * (In the hour where the server's data begins, the 1-h row holds only samples after that point, so it isn't scaled.)
 * Per hour the larger of the two is used (where 1-min rows exist they are exact and usually equal the estimate; at a
 * retention boundary the estimate fills in minutes already pruned), capped at the hour's minutes in the window.
 * null when the window is shorter than 60 minutes.
 */
export function computeUptime(
  startMs: number,
  endMs: number,
  hours: HourData[],
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  /** The server's first data. In the hour containing it, every sample of the 1-h row lies after it: no scaling. */
  firstMs: number | null = null,
): number | null {
  if (!(endMs - startMs >= HOUR)) return null;
  const perSampleMin = intervalSeconds / 60;
  const perRowMin = Math.max(1, perSampleMin);
  const total = (endMs - startMs) / MIN;
  let up = 0;
  for (const h of hours) {
    const from = Math.max(h.hourMs, startMs);
    const to = Math.min(h.hourMs + HOUR, endMs);
    if (to <= from) continue;
    const inWindow = (to - from) / MIN;
    const exact = h.minutes * perRowMin;
    const dataStartsHere = firstMs !== null && from === firstMs && firstMs > h.hourMs;
    const share = dataStartsHere ? 1 : inWindow / 60;
    const estimate = h.hourSamples === null ? 0 : Math.min(60, h.hourSamples * perSampleMin) * share;
    up += Math.min(inWindow, Math.max(exact, estimate));
  }
  const pct = Math.min(100, Math.max(0, (up / total) * 100));
  return Math.round(pct * 10) / 10;
}

/**
 * The server's sample interval in seconds. The hello doesn't report metrics-interval-seconds, but every sample
 * carries its windowSeconds (= the interval), kept in raw samples (detail) for the plan's raw retention. Without
 * recent raw samples it is inferred from the 1-min rollups: 60 / median samples per minute when that is ≥ 2,
 * else the median gap between minutes with data (an agent at 300 s fills every 5th minute). Default 10 s.
 * LIMITATION: an interval changed within the window is treated as if it had always been the current one.
 */
export async function estimateIntervalSeconds(db: Exec, serverId: string, nowMs: number): Promise<number> {
  const clamp = (v: number) => Math.min(300, Math.max(5, Math.round(v)));
  const [raw] = await rows<{ w: number | null }>(
    db,
    sql`select percentile_disc(0.5) within group (order by (detail->>'windowSeconds')::int) as w
          from metric_samples where server_id = ${serverId} and ts >= ${new Date(nowMs - DAY).toISOString()}::timestamptz
           and detail ? 'windowSeconds'`,
  );
  if (raw?.w !== null && raw?.w !== undefined && Number(raw.w) > 0) return clamp(Number(raw.w));
  const [r] = await rows<{ c: number | null; gap: number | null }>(
    db,
    sql`select percentile_disc(0.5) within group (order by sample_count) as c,
               percentile_disc(0.5) within group (order by gap) as gap
          from (select sample_count, extract(epoch from bucket - lag(bucket) over (order by bucket))::int as gap
                  from (select bucket, sample_count from metric_rollups_1m where server_id = ${serverId}
                         order by bucket desc limit 2000) x) y`,
  );
  if (!r || r.c === null) return DEFAULT_INTERVAL_SECONDS;
  if (Number(r.c) >= 2) return clamp(60 / Number(r.c));
  // One sample per minute or fewer: the typical gap between minutes with data (gaps from outages are rarer).
  return clamp(r.gap === null ? 60 : Math.max(60, Number(r.gap)));
}

/**
 * Uptime over the last 1, 7 and 30 days. Each window starts at the later of (end − days) and the server's first
 * data; a window that would reach further back than the plan keeps rollups (rollup1hRetentionDays) is null
 * (not available on this plan) instead of counting the pruned period as down.
 */
export async function loadUptime(db: Exec, serverId: string, nowMs: number): Promise<NonNullable<PublicStatus["uptime"]>> {
  const end = Math.floor(nowMs / MIN) * MIN;
  // First data = the earliest of the first receive time and any rollup (buffered/backfilled data can predate it).
  // A 1-h bucket is hour-floored, so from it we estimate where its samples began: the end of the hour minus the
  // minutes its sample_count covers (data is assumed to run up to the end of that first hour).
  const [f] = await rows<{ fsa: Date | null; m1: Date | null; h1: Date | null; h1_samples: number | null; plan: string | null }>(
    db,
    sql`select s.first_sample_at as fsa, s.plan,
               (select min(bucket) from metric_rollups_1m where server_id = s.id) as m1,
               h.bucket as h1, h.sample_count as h1_samples
          from servers s
          left join lateral (select bucket, sample_count from metric_rollups_1h where server_id = s.id order by bucket limit 1) h on true
         where s.id = ${serverId}`,
  );
  if (!f) return { d1: null, d7: null, d30: null };
  const interval = await estimateIntervalSeconds(db, serverId, nowMs);
  const candidates: number[] = [];
  if (f.fsa) candidates.push(new Date(f.fsa).getTime());
  if (f.m1) candidates.push(new Date(f.m1).getTime());
  if (f.h1) {
    const b = new Date(f.h1).getTime();
    const covered = Math.min(60, Number(f.h1_samples ?? 0) * (interval / 60)) * MIN;
    candidates.push(Math.max(b, b + HOUR - covered));
  }
  if (candidates.length === 0) return { d1: null, d7: null, d30: null };
  const first = Math.min(...candidates);
  const keepDays = retentionFor(f.plan ?? "free").rollup1h;
  // The retention job deletes 1-h buckets that START before now − keepDays, so the oldest complete hour still kept
  // begins at the next full hour: windows start there at the earliest (at most an hour shorter than asked).
  const oldestKept = Math.ceil((end - keepDays * DAY) / HOUR) * HOUR;
  const start = (days: number) => Math.max(end - days * DAY, first, oldestKept);
  const [s1, s7, s30] = [start(1), start(7), start(30)];
  // A window longer than the plan keeps data is not available (null), unless the server is younger than that.
  const coveredDays = { c1: 1, c7: 7, c30: 30 } as const;
  const covered = (key: keyof typeof coveredDays) => coveredDays[key] <= keepDays || first >= end - keepDays * DAY;
  const from = s30;
  const t = (v: number) => new Date(v).toISOString();
  const m = await rows<{ h: Date; c1: number; c7: number; c30: number }>(
    db,
    sql`select date_trunc('hour', bucket, 'UTC') as h,
               count(*) filter (where bucket >= ${t(s1)}::timestamptz)::int as c1,
               count(*) filter (where bucket >= ${t(s7)}::timestamptz)::int as c7,
               count(*)::int as c30
          from metric_rollups_1m
         where server_id = ${serverId} and bucket >= ${t(from)}::timestamptz and bucket < ${t(end)}::timestamptz
         group by 1`,
  );
  const hr = await rows<{ bucket: Date; sample_count: number }>(
    db,
    sql`select bucket, sample_count from metric_rollups_1h
         where server_id = ${serverId} and bucket >= ${t(Math.floor(from / HOUR) * HOUR)}::timestamptz and bucket < ${t(end)}::timestamptz`,
  );
  const byHour = new Map<number, { c1: number; c7: number; c30: number; samples: number | null }>();
  const slot = (ms: number) => {
    let e = byHour.get(ms);
    if (!e) byHour.set(ms, (e = { c1: 0, c7: 0, c30: 0, samples: null }));
    return e;
  };
  for (const r of m) Object.assign(slot(new Date(r.h).getTime()), { c1: Number(r.c1), c7: Number(r.c7), c30: Number(r.c30) });
  for (const r of hr) slot(new Date(r.bucket).getTime()).samples = Number(r.sample_count);
  const hours = (key: "c1" | "c7" | "c30") =>
    [...byHour].map(([hourMs, e]) => ({ hourMs, minutes: e[key], hourSamples: e.samples }));
  const one = (s: number, key: "c1" | "c7" | "c30") => (covered(key) ? computeUptime(s, end, hours(key), interval, first) : null);
  return { d1: one(s1, "c1"), d7: one(s7, "c7"), d30: one(s30, "c30") };
}

export interface PublicPage {
  serverId: string;
  plan: string;
  title: string;
  showPlayers: boolean;
  showUptime: boolean;
  showIncidents: boolean;
  theme: PublicStatus["theme"];
  hideBranding: boolean;
}

/** The enabled page for a slug (case-insensitive), or null for unknown AND disabled alike. */
export async function findPublicPage(db: Exec, slug: string): Promise<PublicPage | null> {
  const [r] = await rows<{
    server_id: string;
    plan: string;
    title: string;
    show_players: boolean;
    show_uptime: boolean;
    show_incidents: boolean;
    theme: PublicStatus["theme"];
    hide_branding: boolean;
  }>(
    db,
    sql`select p.server_id, s.plan, p.title, p.show_players, p.show_uptime, p.show_incidents, p.theme, p.hide_branding
          from status_pages p join servers s on s.id = p.server_id
         where lower(p.slug) = ${slug.toLowerCase()} and p.enabled`,
  );
  if (!r) return null;
  return {
    serverId: r.server_id,
    plan: r.plan,
    title: r.title,
    showPlayers: r.show_players,
    showUptime: r.show_uptime,
    showIncidents: r.show_incidents,
    theme: r.theme,
    hideBranding: r.hide_branding,
  };
}

/** branding true = show "Monitored with <brand>"; only plans with statusPage "custom" may hide it. */
export const showBranding = (p: Pick<PublicPage, "plan" | "hideBranding">) => !(p.hideBranding && canHideBranding(p.plan));

export async function buildPublicStatus(db: Exec, page: PublicPage, nowMs: number): Promise<PublicStatus> {
  const state = await loadServerState(db, page.serverId, nowMs);
  const pub = publicState(state.health);

  let players: PublicStatus["players"] = null;
  if (page.showPlayers) {
    const [i] = await rows<{ max: number | null }>(
      db,
      sql`select (info->'server'->>'maxPlayers')::int as max from server_info_history
           where server_id = ${page.serverId} and valid_to is null order by valid_from desc limit 1`,
    );
    const online = pub === "offline" ? 0 : Math.max(0, Math.trunc(state.latest?.players ?? 0));
    players = { online, max: i?.max === null || i?.max === undefined ? null : Number(i.max) };
  }

  const uptime = page.showUptime ? await loadUptime(db, page.serverId, nowMs) : null;

  let incidents: PublicStatus["incidents"] = null;
  if (page.showIncidents) {
    const r = await rows<{ started_at: Date; ended_at: Date | null; severity: "medium" | "high" | "critical" }>(
      db,
      sql`select started_at, ended_at, severity from incidents
           where server_id = ${page.serverId} and started_at >= ${new Date(nowMs - 30 * DAY).toISOString()}::timestamptz
             and severity in ('medium', 'high', 'critical')
           order by started_at desc limit 10`,
    );
    incidents = r.map((i) => {
      const start = new Date(i.started_at).getTime();
      const end = i.ended_at ? new Date(i.ended_at).getTime() : nowMs;
      return {
        startedAt: iso(i.started_at),
        endedAt: isoOrNull(i.ended_at),
        severity: i.severity,
        durationSeconds: Math.max(0, Math.round((end - start) / 1000)),
      };
    });
  }

  return {
    title: page.title,
    state: pub,
    lastSeenAt: state.lastSampleAt ?? state.lastSeenAt,
    players,
    uptime,
    incidents,
    theme: page.theme,
    branding: showBranding(page),
    generatedAt: new Date(nowMs).toISOString(),
  };
}
