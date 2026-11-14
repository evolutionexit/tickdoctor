import type { SessionUser } from "@tickdoctor/shared";

export const PLAN_NAMES = { free: "Free", pro: "Pro", network: "Network" } as const;

/** Effective plan as a label: "Pro (beta)" when the beta switch lifted the account, else the plain plan name. */
export function planLabel(plan: keyof typeof PLAN_NAMES, source: "stored" | "beta"): string {
  return source === "beta" ? `${PLAN_NAMES[plan]} (beta)` : PLAN_NAMES[plan];
}

export const userPlanLabel = (u: Pick<SessionUser, "effectivePlan" | "planSource">) => planLabel(u.effectivePlan, u.planSource);
