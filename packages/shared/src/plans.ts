// Plans live in code, not the DB. All limit checks go through apps/api's limits module,
// which reads these values. Prices are display-only: no real payments exist.
export type PlanId = "free" | "pro" | "network";

export interface Plan {
  id: PlanId;
  name: string;
  priceEurMonthly: number;
  servers: number;
  rawRetentionDays: number; // metric_samples
  rollup1mRetentionDays: number;
  rollup1hRetentionDays: number;
  incidentRetentionDays: number;
  /** "basic" (Free): title, severity and time only; the why, evidence, fix, what-changed and chunk coordinates are locked. "all": everything. Enforced server-side (apps/api findings/gate.ts). Tuning tips are never locked. */
  findings: "basic" | "all";
  discordAlerts: boolean;
  statusPage: "branded" | "custom";
}

export const plans: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceEurMonthly: 0,
    servers: 1,
    rawRetentionDays: 1,
    rollup1mRetentionDays: 3,
    rollup1hRetentionDays: 7,
    incidentRetentionDays: 7,
    findings: "basic",
    discordAlerts: true,
    statusPage: "branded",
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceEurMonthly: 7,
    servers: 2,
    rawRetentionDays: 3,
    rollup1mRetentionDays: 14,
    rollup1hRetentionDays: 90,
    incidentRetentionDays: 90,
    findings: "all",
    discordAlerts: true,
    statusPage: "custom",
  },
  network: {
    id: "network",
    name: "Network",
    priceEurMonthly: 19,
    servers: 10,
    rawRetentionDays: 7,
    rollup1mRetentionDays: 30,
    rollup1hRetentionDays: 365,
    incidentRetentionDays: 365,
    findings: "all",
    discordAlerts: true,
    statusPage: "custom",
  },
};
