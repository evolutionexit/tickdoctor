import { sql } from "drizzle-orm";
import { DETECTOR, type Baseline, type Incident } from "@tickdoctor/shared";
import { iso, isoOrNull, rows, type Exec } from "../db/query.js";
import { buildBaseline } from "./baseline.js";
import { severityFor } from "./core.js";

// Incident rows + snapshot linking (contracts §6.1, §6.5). Callers serialise per server (detector lock).

const LEAD_MS = DETECTOR.snapshotLeadSeconds * 1000;

export interface OpenArgs {
  serverId: string;
  startedAt: number;
  peak: number;
  minTps: number | null;
  trigger: "mspt" | "tps";
  source: "raw" | "rollup_1m";
  nowMs: number;
  /** Set for incidents that are already over (backfill). */
  end?: { endedAt: number; reason: "recovered" | "offline" };
}

/** Inserts an incident with its baseline and links snapshots in [startedAt - 60 s, endedAt]. Returns its id. */
export async function insertIncident(db: Exec, a: OpenArgs): Promise<string> {
  const baseline = await buildBaseline(db, a.serverId, a.startedAt);
  const now = new Date(a.nowMs).toISOString();
  const [row] = await rows<{ id: string }>(
    db,
    sql`insert into incidents (server_id, started_at, ended_at, end_reason, severity, initial_severity, peak_mspt_p95, min_tps_1m, trigger, source, baseline,
                               opened_at, closed_at, created_at, updated_at)
        values (${a.serverId}, ${new Date(a.startedAt).toISOString()}::timestamptz,
                ${a.end ? new Date(a.end.endedAt).toISOString() : null}::timestamptz, ${a.end?.reason ?? null},
                ${severityFor(a.peak, a.minTps)}, ${severityFor(a.peak, a.minTps)}, ${a.peak}, ${a.minTps}, ${a.trigger}, ${a.source}, ${baseline === null ? null : JSON.stringify(baseline)}::jsonb,
                ${now}::timestamptz, ${a.end ? now : null}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
        returning id`,
  );
  await linkSnapshots(db, row!.id);
  return row!.id;
}

export async function closeIncident(
  db: Exec,
  id: string,
  c: { endedAt: number; reason: "recovered" | "offline"; peak: number; minTps: number | null; nowMs: number },
): Promise<void> {
  const now = new Date(c.nowMs).toISOString();
  await db.execute(sql`
    update incidents set ended_at = ${new Date(c.endedAt).toISOString()}::timestamptz, end_reason = ${c.reason},
           peak_mspt_p95 = ${c.peak}, min_tps_1m = ${c.minTps}, severity = ${severityFor(c.peak, c.minTps)},
           closed_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     where id = ${id} and ended_at is null`);
  // While open, every snapshot from startedAt - 60 s on was linked; drop those captured after the end.
  await db.execute(sql`
    update incident_snapshots set incident_id = null, baseline = null
     where incident_id = ${id} and captured_at > ${new Date(c.endedAt).toISOString()}::timestamptz`);
}

export async function updatePeak(db: Exec, id: string, peak: number, minTps: number | null, nowMs: number): Promise<void> {
  await db.execute(sql`
    update incidents set peak_mspt_p95 = ${peak}, min_tps_1m = ${minTps}, severity = ${severityFor(peak, minTps)},
           updated_at = ${new Date(nowMs).toISOString()}::timestamptz
     where id = ${id} and ended_at is null`);
}

/**
 * Links unlinked snapshots of the incident's server captured in [startedAt - 60 s, endedAt] (no upper bound while
 * open) and copies the incident's baseline onto them. Returns how many were linked.
 */
export async function linkSnapshots(db: Exec, incidentId: string): Promise<number> {
  const res = await rows<{ id: string }>(
    db,
    sql`update incident_snapshots s set incident_id = i.id, baseline = i.baseline
          from incidents i
         where i.id = ${incidentId} and s.server_id = i.server_id and s.incident_id is null
           and s.captured_at >= i.started_at - ${sql.raw(`interval '${DETECTOR.snapshotLeadSeconds} seconds'`)}
           and (i.ended_at is null or s.captured_at <= i.ended_at)
        returning s.id`,
  );
  return res.length;
}

/** Called after a snapshot is stored: links it to the incident whose window contains it, if any. */
export async function linkSnapshotToIncident(db: Exec, serverId: string, capturedAtMs: number): Promise<string | null> {
  const at = new Date(capturedAtMs).toISOString();
  const lead = new Date(capturedAtMs + LEAD_MS).toISOString();
  const [inc] = await rows<{ id: string }>(
    db,
    sql`select id from incidents
         where server_id = ${serverId} and started_at <= ${lead}::timestamptz
           and (ended_at is null or ended_at >= ${at}::timestamptz)
         order by started_at desc limit 1`,
  );
  if (!inc) return null;
  await db.execute(sql`
    update incident_snapshots s set incident_id = i.id, baseline = i.baseline
      from incidents i
     where i.id = ${inc.id} and s.server_id = ${serverId} and s.captured_at = ${at}::timestamptz and s.incident_id is null`);
  return inc.id;
}

// ---------- reading ----------

const incidentCols = sql`i.id, i.server_id, i.started_at, i.ended_at, i.end_reason, i.severity, i.peak_mspt_p95, i.min_tps_1m, i.trigger, i.source,
  i.baseline, i.rules_evaluated_at, i.created_at, i.updated_at,
  (select s.id from incident_snapshots s where s.incident_id = i.id
    order by (s.captured_at >= i.started_at) desc, s.captured_at limit 1) as snapshot_id`;

type IncidentRow = Record<string, unknown>;

export function toIncident(r: IncidentRow): Incident {
  return {
    id: String(r.id),
    serverId: String(r.server_id),
    startedAt: iso(r.started_at),
    endedAt: isoOrNull(r.ended_at),
    endReason: (r.end_reason as Incident["endReason"]) ?? null,
    severity: r.severity as Incident["severity"],
    peakMsptP95: Number(r.peak_mspt_p95),
    minTps1m: r.min_tps_1m === null || r.min_tps_1m === undefined ? null : Number(r.min_tps_1m),
    trigger: (r.trigger as Incident["trigger"]) ?? "mspt",
    source: r.source as Incident["source"],
    snapshotId: (r.snapshot_id as string | null) ?? null,
    baseline: (r.baseline as Baseline | null) ?? null,
    rulesEvaluatedAt: isoOrNull(r.rules_evaluated_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getIncident(db: Exec, id: string): Promise<Incident | null> {
  const [r] = await rows(db, sql`select ${incidentCols} from incidents i where i.id = ${id}`);
  return r ? toIncident(r) : null;
}

export async function listIncidents(db: Exec, serverId: string, limit = 200): Promise<Incident[]> {
  const rs = await rows(db, sql`select ${incidentCols} from incidents i where i.server_id = ${serverId} order by i.started_at desc limit ${limit}`);
  return rs.map(toIncident);
}

