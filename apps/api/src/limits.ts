import { effectivePlan, plans, type Plan, type PlanId } from "@tickdoctor/shared";

// The single place plan limits are read (plans.ts lives in packages/shared). Every lookup goes through
// effectivePlanId(), which applies the BETA_ALL_PRO switch (contract app-phase8.ts): stored plans never change,
// only the limits that apply to them. Nothing outside this module may read plans[...] for a limit.

let betaAllPro = false;

/** Set once at startup from env BETA_ALL_PRO (index.ts, cli.ts). Tests flip it and reset it afterwards. */
export function configureLimits(opts: { betaAllPro: boolean }): void {
  betaAllPro = opts.betaAllPro;
}

export function isPlanId(v: string): v is PlanId {
  return Object.prototype.hasOwnProperty.call(plans, v);
}

/** Stored plan string → stored PlanId (unknown → free). */
export function storedPlanId(stored: string): PlanId {
  return isPlanId(stored) ? stored : "free";
}

/** The plan whose limits apply to a stored plan right now. */
export function effectivePlanId(stored: string): PlanId {
  return effectivePlan(storedPlanId(stored), betaAllPro);
}

/** "beta" when the switch lifted this stored plan to a higher one. */
export function planSource(stored: string): "stored" | "beta" {
  return effectivePlanId(stored) === storedPlanId(stored) ? "stored" : "beta";
}

/** Limits for a STORED plan id (the beta switch is applied here). */
export function planOf(stored: string): Plan {
  return plans[effectivePlanId(stored)];
}

export interface RetentionDays {
  raw: number;
  rollup1m: number;
  rollup1h: number;
  /** Events are chart annotations: kept as long as the longest chart (1h rollups). */
  events: number;
  snapshots: number;
  incidents: number;
  findings: number;
}

/** Retention for a STORED plan id (effective plan applied, so the retention job follows the beta switch). */
export function retentionFor(stored: string): RetentionDays {
  const p = planOf(stored);
  return {
    raw: p.rawRetentionDays,
    rollup1m: p.rollup1mRetentionDays,
    rollup1h: p.rollup1hRetentionDays,
    events: p.rollup1hRetentionDays,
    snapshots: p.incidentRetentionDays,
    incidents: p.incidentRetentionDays,
    findings: p.incidentRetentionDays,
  };
}

/** Every stored plan id (the retention job iterates stored values of servers.plan). */
export function allPlanIds(): PlanId[] {
  return Object.keys(plans) as PlanId[];
}
