import { sql } from "drizzle-orm";
import { z } from "zod";
import { findingEvidence, ruleId as ruleIdSchema, severity as severitySchema, type FindingScope } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { ms, rows } from "../db/query.js";
import { RULES } from "../rules/index.js";
import type { Rule, RuleContext, RuleFinding } from "../rules/types.js";
import { backfillIncidents, type BackfillResult } from "../incidents/backfill.js";
import { buildContext } from "./context.js";
import { upsertFinding } from "./lifecycle.js";

// Runs rules for a scope, isolates failures, validates output and stores findings (contracts §6.3, §6.4).

/** What a stored RuleFinding must satisfy (the Finding contract's field limits). Invalid ones are dropped + logged. */
export const ruleFindingSchema = z.object({
  ruleId: ruleIdSchema,
  dedupKey: z.string().min(1).max(200),
  severity: severitySchema,
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2000),
  evidence: findingEvidence,
  suggestedFix: z.string().max(4000),
});

export type Log = (line: string) => void;

/** Evaluates every rule that supports ctx.scope. A throwing rule is logged and skipped; invalid findings dropped. */
export function runRules(rules: readonly Rule[], ctx: RuleContext, log: Log = console.log): RuleFinding[] {
  const out: RuleFinding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.scopes.includes(ctx.scope)) continue;
    let res: RuleFinding[];
    try {
      res = rule.evaluate(ctx);
      if (!Array.isArray(res)) throw new Error("evaluate() did not return an array");
    } catch (err) {
      log(`rule ${rule.id} failed (${ctx.scope}, server ${ctx.server.id.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const f of res) {
      const parsed = ruleFindingSchema.safeParse(f);
      if (!parsed.success) {
        const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        log(`rule ${rule.id} returned an invalid finding, dropped: ${why}`);
        continue;
      }
      if (parsed.data.ruleId !== rule.id) {
        log(`rule ${rule.id} returned a finding for ${parsed.data.ruleId}, dropped`);
        continue;
      }
      const key = `${parsed.data.ruleId}\u0000${parsed.data.dedupKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed.data as RuleFinding);
    }
  }
  return out;
}

export interface EvalOptions {
  nowMs?: number;
  rules?: readonly Rule[];
  log?: Log;
}

export interface EvalResult {
  scope: FindingScope;
  findings: { id: string; ruleId: string; dedupKey: string; created: boolean; reopened: boolean }[];
}

async function store(db: Db, ctx: RuleContext, found: RuleFinding[], incidentId?: string): Promise<EvalResult> {
  const result: EvalResult = { scope: ctx.scope, findings: [] };
  // When the hello this pass evaluated was received: the later of the last hello and the current info row.
  const [h] = await rows<{ hello_at: Date | null }>(
    db,
    sql`select greatest((select last_hello_at from server_analysis_state where server_id = ${ctx.server.id}),
                        (select max(valid_from) from server_info_history where server_id = ${ctx.server.id}
                          and valid_from <= ${ctx.now}::timestamptz)) as hello_at`,
  );
  const helloAt = h?.hello_at ? ms(h.hello_at) : null;
  for (const f of found) {
    const r = await upsertFinding(db, { serverId: ctx.server.id, scope: ctx.scope, finding: f, incidentId, seenAt: Date.parse(ctx.now), helloAt });
    result.findings.push({ id: r.id, ruleId: f.ruleId, dedupKey: f.dedupKey, created: r.created, reopened: r.reopened });
  }
  return result;
}

/** Incident-scope pass ("opened" or "closed"); stamps incidents.rules_evaluated_at with the wall clock. */
export async function evaluateIncident(db: Db, incidentId: string, opts: EvalOptions = {}): Promise<EvalResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const [inc] = await rows<{ server_id: string }>(db, sql`select server_id from incidents where id = ${incidentId}`);
  if (!inc) throw new Error("incident not found");
  const ctx = await buildContext(db, { serverId: inc.server_id, scope: "incident", incidentId, nowMs });
  const res = await store(db, ctx, runRules(opts.rules ?? RULES, ctx, opts.log), incidentId);
  await db.execute(sql`update incidents set rules_evaluated_at = ${new Date(nowMs).toISOString()}::timestamptz where id = ${incidentId}`);
  return res;
}

/** Server-scope pass over the last 30 minutes; stamps server_analysis_state.server_rules_at. */
export async function evaluateServer(db: Db, serverId: string, opts: EvalOptions = {}): Promise<EvalResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const ctx = await buildContext(db, { serverId, scope: "server", nowMs });
  const res = await store(db, ctx, runRules(opts.rules ?? RULES, ctx, opts.log));
  await db.execute(sql`
    insert into server_analysis_state (server_id, server_rules_at) values (${serverId}, ${new Date(nowMs).toISOString()}::timestamptz)
    on conflict (server_id) do update set server_rules_at = excluded.server_rules_at, updated_at = now()`);
  return res;
}

/** incidents:backfill + the incident-rules pass for every incident it created (CLI, seed). */
export async function backfillAndEvaluate(
  db: Db,
  serverId: string,
  opts: { from?: number; to?: number; nowMs?: number; rules?: readonly Rule[]; log?: Log } = {},
): Promise<BackfillResult> {
  const r = await backfillIncidents(db, serverId, { from: opts.from, to: opts.to, nowMs: opts.nowMs, log: opts.log });
  for (const id of r.created) {
    try {
      await evaluateIncident(db, id, { nowMs: opts.nowMs, rules: opts.rules, log: opts.log });
    } catch (err) {
      opts.log?.(`incident rules ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return r;
}
