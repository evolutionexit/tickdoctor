import { sql, type SQL } from "drizzle-orm";
import { SEVERITIES, SEVERITY_RANK, isTuningTip, type Finding, type Severity } from "@tickdoctor/shared";

// Tuning tips (contract app-phase6.ts): `isTuningTip` from shared is the only definition. SQL filters are derived
// from it, so a change there changes every query (server card top finding, incident findings, alerts).

/** Severities that are causes, not tips. */
export const NON_TIP_SEVERITIES: Severity[] = SEVERITIES.filter((s) => !isTuningTip({ severity: s }));
export const TIP_SEVERITIES: Severity[] = SEVERITIES.filter((s) => isTuningTip({ severity: s }));

const list = (xs: readonly string[]) => `{${xs.join(",")}}`;

/** `<col> = any(non-tip severities)` (one bind parameter). */
export const nonTipSql = (col: SQL): SQL => sql`${col} = any(${list(NON_TIP_SEVERITIES)}::text[])`;
export const tipSql = (col: SQL): SQL => sql`${col} = any(${list(TIP_SEVERITIES)}::text[])`;

/** SQL `order by` key for impact order: severity desc (SEVERITY_RANK), open before marked_fixed, lastSeenAt desc. */
export const impactOrderSql = (alias: string): SQL => {
  const a = sql.raw(alias);
  const sev = sql.join(
    Object.entries(SEVERITY_RANK).map(([s, r]) => sql`when ${sql.raw(`'${s}'`)} then ${sql.raw(String(r))}`),
    sql` `,
  );
  return sql`case ${a}.severity ${sev} else -1 end desc,
             case ${a}.status when 'open' then 0 when 'marked_fixed' then 1 else 2 end, ${a}.last_seen_at desc`;
};

const STATUS_ORDER: Record<Finding["status"], number> = { open: 0, marked_fixed: 1, confirmed_fixed: 2 };

/** Same impact order in TS. */
export function byImpact(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)
  );
}
