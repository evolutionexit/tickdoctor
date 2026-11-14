import { sql } from "drizzle-orm";
import { DETECTOR } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { rows } from "../db/query.js";
import type { RecheckConfig } from "../env.js";
import { detectorTick } from "../incidents/detector.js";
import { linkSnapshots } from "../incidents/store.js";
import { withJobLock } from "../jobs/lock.js";
import type { Rule } from "../rules/types.js";
import { evaluateIncident, evaluateServer, type Log } from "./engine.js";
import { recheckFindings, type RecheckResult } from "./lifecycle.js";

// Background jobs for Phase 4 (scheduled in jobs/scheduler.ts; tests call them directly with a fixed clock).

export const INCIDENT_JOB_LOCK = 7_301_003;
export const SERVER_RULES_JOB_LOCK = 7_301_004;
export const RECHECK_JOB_LOCK = 7_301_005;

/** Server-scope pass every 5 min for servers seen in the last 10 min. */
export const SERVER_RULES_SEEN_WITHIN_MS = 10 * 60_000;
const MAX_PASSES_PER_TICK = 25;
const RELINK_WINDOW_MS = 60 * 60_000;

export interface JobOpts {
  nowMs?: number;
  rules?: readonly Rule[];
  log?: Log;
}

/**
 * Every ~15 s: offline closes + due snapshot requests (detectorTick), then pending incident-rule passes:
 * "opened" pass once the snapshot is linked or 90 s after opening, "closed" pass after close.
 */
export async function runIncidentJob(db: Db, opts: JobOpts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  return withJobLock(db, INCIDENT_JOB_LOCK, async () => {
    const tick = await detectorTick(db, nowMs);
    // Re-link snapshots that arrived while their incident was being opened in a concurrent transaction.
    const recent = await rows<{ id: string }>(
      db,
      sql`select id from incidents where ended_at is null or ended_at >= ${new Date(nowMs - RELINK_WINDOW_MS).toISOString()}::timestamptz`,
    );
    for (const r of recent) await linkSnapshots(db, r.id);
    const due = new Date(nowMs - DETECTOR.rulesTimeoutSeconds * 1000).toISOString();
    const pending = await rows<{ id: string }>(
      db,
      sql`(select i.id, i.opened_at as k from incidents i
            where i.ended_at is null and i.rules_evaluated_at is null
              and (i.opened_at <= ${due}::timestamptz or exists (select 1 from incident_snapshots s where s.incident_id = i.id)))
          union all
          (select i.id, i.closed_at as k from incidents i
            where i.closed_at is not null and (i.rules_evaluated_at is null or i.rules_evaluated_at < i.closed_at))
          order by k limit ${MAX_PASSES_PER_TICK}`,
    );
    const evaluated: string[] = [];
    for (const p of pending) {
      try {
        await evaluateIncident(db, p.id, { nowMs, rules: opts.rules, log: opts.log });
        evaluated.push(p.id);
      } catch (err) {
        opts.log?.(`incident rules ${p.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ...tick, evaluated };
  });
}

export async function runServerRulesJob(db: Db, opts: JobOpts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  return withJobLock(db, SERVER_RULES_JOB_LOCK, async () => {
    const servers = await rows<{ id: string }>(
      db,
      sql`select s.id from servers s left join server_analysis_state st on st.server_id = s.id
           where s.last_seen_at >= ${new Date(nowMs - SERVER_RULES_SEEN_WITHIN_MS).toISOString()}::timestamptz
           order by st.server_rules_at asc nulls first limit ${MAX_PASSES_PER_TICK}`,
    );
    const done: string[] = [];
    for (const s of servers) {
      try {
        await evaluateServer(db, s.id, { nowMs, rules: opts.rules, log: opts.log });
        done.push(s.id);
      } catch (err) {
        opts.log?.(`server rules ${s.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  });
}

export async function runRecheckJob(db: Db, cfg: RecheckConfig, opts: { nowMs?: number } = {}): Promise<RecheckResult | null> {
  return withJobLock(db, RECHECK_JOB_LOCK, () => recheckFindings(db, cfg, opts.nowMs ?? Date.now()));
}

/**
 * Hello → server-scope pass, in the background (the hello response doesn't wait). Coalesces bursts per server:
 * one pass in flight, at most one queued.
 */
export function helloRulesTrigger(db: Db, log: Log = console.log, rules?: readonly Rule[]) {
  const running = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const run = (serverId: string, nowMs: number): Promise<void> => {
    const p = (async () => {
      try {
        const at = new Date(nowMs).toISOString();
        await db.execute(sql`
          insert into server_analysis_state (server_id, last_hello_at) values (${serverId}, ${at}::timestamptz)
          on conflict (server_id) do update set last_hello_at = excluded.last_hello_at, updated_at = now()`);
        await evaluateServer(db, serverId, { nowMs, rules, log });
      } catch (err) {
        log(`server rules after hello ${serverId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running.delete(serverId);
        if (queued.delete(serverId)) void run(serverId, Date.now());
      }
    })();
    running.set(serverId, p);
    return p;
  };
  return {
    trigger(serverId: string, nowMs: number = Date.now()): Promise<void> {
      const cur = running.get(serverId);
      if (cur) {
        queued.add(serverId);
        return cur;
      }
      return run(serverId, nowMs);
    },
  };
}
