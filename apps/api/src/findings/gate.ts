import { sql } from "drizzle-orm";
import { isTuningTip, type Finding, type FindingView } from "@tickdoctor/shared";
import { rows, type Exec } from "../db/query.js";
import { planOf } from "../limits.js";

// Plan gating for findings (F-04, contract app-phase6.ts findingView): a "basic" plan (Free) sees THAT something is
// wrong and how severe; the why (explanation, evidence, fix, what changed, chunk coordinates) is omitted from the
// response, not hidden. The plan is the server's EFFECTIVE plan (planOf applies BETA_ALL_PRO). Tuning tips never lock.

/** True when this stored plan only gets the basic view right now. */
export const planLocksFindings = (storedPlan: string): boolean => planOf(storedPlan).findings === "basic";

/** The plan check for a server id (servers.plan; a missing row counts as free). */
export async function serverFindingsLocked(db: Exec, serverId: string): Promise<boolean> {
  const [s] = await rows<{ plan: string }>(db, sql`select plan from servers where id = ${serverId}`);
  return planLocksFindings(s?.plan ?? "free");
}

/** The finding as the API sends it: full, or (locked and not a tip) without the fields the plan withholds. */
export function viewFinding(f: Finding, locked: boolean): FindingView {
  if (!locked || isTuningTip(f)) return f;
  const { explanation: _e, evidence: _ev, suggestedFix: _s, dedupKey: _d, ...rest } = f;
  return { ...rest, locked: true, lockedReason: "plan" };
}
