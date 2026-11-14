import { sql } from "drizzle-orm";
import { CONFIG_RULE_IDS, type Finding, type FindingEvidence, type FindingScope, type RuleId } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { iso, isoOrNull, ms, rows, type Exec } from "../db/query.js";
import type { RecheckConfig } from "../env.js";
import type { RuleFinding } from "../rules/types.js";

// Findings lifecycle (contracts §6.4).
//
// Upsert per (server, ruleId, dedupKey) among rows that are not confirmed_fixed: refresh text/evidence/severity,
// lastSeenAt, occurrenceCount, link the incident. occurrenceCount = number of incidents the finding was seen in for
// incident scope (the "opened" and "closed" pass of one incident count once), number of passes that fired for
// server scope. A marked_fixed row goes back to open only when the problem is seen AFTER it was marked (a backfill
// of old data must not reopen it). All writes for one server are serialised with a transaction advisory lock.


const FINDINGS_LOCK_NS = 7_301_010;

export interface UpsertArgs {
  serverId: string;
  scope: FindingScope;
  finding: RuleFinding;
  incidentId?: string;
  /** When the problem was observed (ctx.now). */
  seenAt: number;
  /**
   * Config rules (CONFIG_RULE_IDS): when the hello the pass evaluated was received. A pass on a hello that is not
   * newer than markedFixedAt never reopens (or touches) a marked_fixed config finding.
   */
  helloAt?: number | null;
}

export async function upsertFinding(db: Db, a: UpsertArgs): Promise<{ id: string; created: boolean; reopened: boolean }> {
  const f = a.finding;
  const seen = new Date(a.seenAt).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FINDINGS_LOCK_NS}, hashtext(${a.serverId}))`);
    const [cur] = await rows<{ id: string; status: string; marked_fixed_at: Date | null }>(
      tx,
      sql`select id, status, marked_fixed_at from findings
           where server_id = ${a.serverId} and rule_id = ${f.ruleId} and dedup_key = ${f.dedupKey} and status <> 'confirmed_fixed'`,
    );
    let id: string;
    let created = false;
    let reopened = false;
    const isConfig = CONFIG_RULE_IDS.includes(f.ruleId);
    if (cur && cur.status === "marked_fixed" && isConfig && cur.marked_fixed_at && !(a.helloAt != null && a.helloAt > ms(cur.marked_fixed_at))) {
      // Still evaluating the configuration from before the fix: not a new observation.
      return { id: cur.id, created: false, reopened: false };
    }
    if (!cur) {
      const [ins] = await rows<{ id: string }>(
        tx,
        sql`insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix,
                                  status, occurrence_count, first_seen_at, last_seen_at)
            values (${a.serverId}, ${f.ruleId}, ${a.scope}, ${f.dedupKey}, ${f.severity}, ${f.title}, ${f.explanation},
                    ${JSON.stringify(f.evidence)}::jsonb, ${f.suggestedFix}, 'open', 1, ${seen}::timestamptz, ${seen}::timestamptz)
            returning id`,
      );
      id = ins!.id;
      created = true;
      if (a.incidentId) await tx.execute(sql`insert into finding_incidents (finding_id, incident_id) values (${id}, ${a.incidentId}) on conflict do nothing`);
    } else {
      id = cur.id;
      let newIncident = false;
      if (a.incidentId) {
        const ins = await rows(tx, sql`insert into finding_incidents (finding_id, incident_id) values (${id}, ${a.incidentId}) on conflict do nothing returning finding_id`);
        newIncident = ins.length > 0;
      }
      const bump = a.scope === "incident" ? newIncident : true;
      reopened = cur.status === "marked_fixed" && cur.marked_fixed_at !== null && a.seenAt > ms(cur.marked_fixed_at);
      await tx.execute(sql`
        update findings set severity = ${f.severity}, title = ${f.title}, explanation = ${f.explanation},
               evidence = ${JSON.stringify(f.evidence)}::jsonb, suggested_fix = ${f.suggestedFix},
               last_seen_at = greatest(last_seen_at, ${seen}::timestamptz),
               first_seen_at = least(first_seen_at, ${seen}::timestamptz),
               occurrence_count = occurrence_count + ${bump ? 1 : 0},
               status = ${reopened ? "open" : cur.status},
               scope = ${a.scope === "server" ? "server" : sql`scope`},
               marked_fixed_at = ${reopened ? null : cur.marked_fixed_at}::timestamptz,
               updated_at = now()
         where id = ${id}`);
    }
    return { id, created, reopened };
  });
}

/** Owner marks a finding fixed (CLI now, UI in Phase 6). Returns false for unknown / already confirmed findings. */
export async function markFixed(db: Exec, findingId: string, nowMs = Date.now()): Promise<boolean> {
  const res = await rows(
    db,
    sql`update findings set status = 'marked_fixed', marked_fixed_at = ${new Date(nowMs).toISOString()}::timestamptz, updated_at = now()
         where id = ${findingId} and status = 'open' returning id`,
  );
  return res.length > 0;
}

/** Undo of markFixed (Phase 6 PATCH status "open"): only from marked_fixed. False otherwise (caller → 409). */
export async function undoMarkFixed(db: Exec, findingId: string): Promise<boolean> {
  const res = await rows(
    db,
    sql`update findings set status = 'open', marked_fixed_at = null, updated_at = now()
         where id = ${findingId} and status = 'marked_fixed' returning id`,
  );
  return res.length > 0;
}

/**
 * "Fresh data" in [from, to]: the server sent metrics in both halves of the window. Short windows look at raw
 * samples; long ones (> 6 h) at 1-h rollups, which outlive raw retention.
 */
export async function hasFreshData(db: Exec, serverId: string, from: number, to: number): Promise<boolean> {
  const mid = from + (to - from) / 2;
  const f = new Date(from).toISOString();
  const m = new Date(mid).toISOString();
  const t = new Date(to).toISOString();
  const long = to - from > 6 * 3_600_000;
  const [r] = await rows<{ a: boolean; b: boolean }>(
    db,
    long
      ? sql`select exists(select 1 from metric_rollups_1h where server_id = ${serverId} and bucket >= ${f}::timestamptz and bucket < ${m}::timestamptz) as a,
                   exists(select 1 from metric_rollups_1h where server_id = ${serverId} and bucket >= ${m}::timestamptz and bucket <= ${t}::timestamptz) as b`
      : sql`select exists(select 1 from metric_samples where server_id = ${serverId} and ts >= ${f}::timestamptz and ts < ${m}::timestamptz) as a,
                   exists(select 1 from metric_samples where server_id = ${serverId} and ts >= ${m}::timestamptz and ts <= ${t}::timestamptz) as b`,
  );
  return !!r?.a && !!r?.b;
}

export interface RecheckResult {
  confirmedOwner: string[];
  confirmedAuto: string[];
}

/**
 * Recheck job (every 5 min):
 * - marked_fixed, not seen since marking, window elapsed, fresh data during it (server scope: a server pass ran after
 *   the window; config rules: a hello after marking) → confirmed_fixed, resolvedBy "owner".
 * - server-scope + open, not seen for the window, fresh data since, and a server pass ran after the window →
 *   confirmed_fixed, resolvedBy "auto". Incident-scope findings never auto-resolve.
 */
export async function recheckFindings(db: Db, cfg: RecheckConfig, nowMs = Date.now()): Promise<RecheckResult> {
  const out: RecheckResult = { confirmedOwner: [], confirmedAuto: [] };
  const serverW = cfg.serverMinutes * 60_000;
  const incidentW = cfg.incidentHours * 3_600_000;
  const cands = await rows<{
    id: string; server_id: string; rule_id: RuleId; scope: FindingScope; status: string;
    last_seen_at: Date; marked_fixed_at: Date | null; server_rules_at: Date | null; last_hello_at: Date | null;
    last_seen_text: string; marked_fixed_text: string | null;
  }>(
    db,
    sql`select f.id, f.server_id, f.rule_id, f.scope, f.status, f.last_seen_at, f.marked_fixed_at,
               f.last_seen_at::text as last_seen_text, f.marked_fixed_at::text as marked_fixed_text,
               st.server_rules_at, st.last_hello_at
          from findings f left join server_analysis_state st on st.server_id = f.server_id
         where f.status <> 'confirmed_fixed' and (f.status = 'marked_fixed' or f.scope = 'server')`,
  );
  for (const c of cands) {
    const w = c.scope === "server" ? serverW : incidentW;
    const rulesAt = c.server_rules_at ? ms(c.server_rules_at) : -Infinity;
    const lastSeen = ms(c.last_seen_at);
    let resolvedBy: "owner" | "auto" | null = null;
    if (c.status === "marked_fixed" && c.marked_fixed_at) {
      const marked = ms(c.marked_fixed_at);
      if (nowMs - marked < w || lastSeen > marked) continue;
      if (c.scope === "server" && rulesAt < marked + w) continue;
      // Config rules: a hello received after the problem was last seen (it may predate the marking: the owner
      // restarted with the fix, then marked it).
      if (CONFIG_RULE_IDS.includes(c.rule_id) && !(c.last_hello_at && ms(c.last_hello_at) > lastSeen)) continue;
      if (!(await hasFreshData(db, c.server_id, marked, nowMs))) continue;
      resolvedBy = "owner";
    } else if (c.status === "open" && c.scope === "server") {
      if (nowMs - lastSeen < w || rulesAt < lastSeen + w) continue;
      if (!(await hasFreshData(db, c.server_id, lastSeen, nowMs))) continue;
      resolvedBy = "auto";
    }
    if (!resolvedBy) continue;
    // Under the per-server findings lock and only if nothing changed since we read it (a rule firing, or the owner
    // marking it fixed: then the owner path decides later, so the owner wins over auto).
    const res = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${FINDINGS_LOCK_NS}, hashtext(${c.server_id}))`);
      return rows(
        tx,
        sql`update findings set status = 'confirmed_fixed', confirmed_fixed_at = ${new Date(nowMs).toISOString()}::timestamptz,
                   resolved_by = ${resolvedBy}, updated_at = now()
             where id = ${c.id} and status = ${c.status} and last_seen_at = ${c.last_seen_text}::timestamptz
               and marked_fixed_at is not distinct from ${c.marked_fixed_text}::timestamptz
            returning id`,
      );
    });
    if (res.length > 0) (resolvedBy === "owner" ? out.confirmedOwner : out.confirmedAuto).push(c.id);
  }
  return out;
}

// ---------- reading ----------

export function toFinding(r: Record<string, unknown>, incidentIds: string[]): Finding {
  return {
    id: String(r.id),
    serverId: String(r.server_id),
    ruleId: r.rule_id as RuleId,
    scope: r.scope as FindingScope,
    dedupKey: String(r.dedup_key),
    severity: r.severity as Finding["severity"],
    title: String(r.title),
    explanation: String(r.explanation),
    evidence: r.evidence as FindingEvidence,
    suggestedFix: String(r.suggested_fix),
    status: r.status as Finding["status"],
    incidentIds,
    occurrenceCount: Number(r.occurrence_count),
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    markedFixedAt: isoOrNull(r.marked_fixed_at),
    confirmedFixedAt: isoOrNull(r.confirmed_fixed_at),
    resolvedBy: (r.resolved_by as Finding["resolvedBy"]) ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function incidentIdsOf(db: Exec, findingIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(findingIds.map((id) => [id, []]));
  if (findingIds.length === 0) return map;
  const rs = await rows<{ finding_id: string; incident_id: string }>(
    db,
    sql`select fi.finding_id, fi.incident_id from finding_incidents fi join incidents i on i.id = fi.incident_id
         where fi.finding_id in (${sql.join(findingIds.map((x) => sql`${x}`), sql`, `)})
         order by i.started_at`,
  );
  for (const r of rs) map.get(r.finding_id)?.push(r.incident_id);
  return map;
}

export async function getFinding(db: Exec, id: string): Promise<Finding | null> {
  const [r] = await rows(db, sql`select * from findings where id = ${id}`);
  if (!r) return null;
  return toFinding(r, (await incidentIdsOf(db, [id])).get(id) ?? []);
}

export async function listFindings(db: Exec, serverId: string, status?: string): Promise<Finding[]> {
  const rs = await rows(
    db,
    sql`select * from findings where server_id = ${serverId} ${status ? sql`and status = ${status}` : sql``}
         order by case status when 'open' then 0 when 'marked_fixed' then 1 else 2 end, last_seen_at desc limit 500`,
  );
  const ids = await incidentIdsOf(db, rs.map((r) => String(r.id)));
  return rs.map((r) => toFinding(r, ids.get(String(r.id)) ?? []));
}

export async function listFindingsForIncident(db: Exec, incidentId: string): Promise<Finding[]> {
  const rs = await rows(
    db,
    sql`select f.* from findings f join finding_incidents fi on fi.finding_id = f.id where fi.incident_id = ${incidentId} order by f.last_seen_at desc`,
  );
  const ids = await incidentIdsOf(db, rs.map((r) => String(r.id)));
  return rs.map((r) => toFinding(r, ids.get(String(r.id)) ?? []));
}
