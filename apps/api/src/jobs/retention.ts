import type { Db } from "../db/client.js";
import { allPlanIds, retentionFor } from "../limits.js";

// Hourly: deletes raw / 1m / 1h / events / snapshots older than each server's plan allows
// (contracts §5.3; limits read through limits.ts → plans.ts), plus superseded server info / stale plugin
// inventory after the incident retention and revoked API keys after 30 days.

export const RETENTION_LOCK_KEY = 7_301_002;

const TABLES = [
  { table: "metric_samples", col: "ts", key: "raw" },
  { table: "metric_rollups_1m", col: "bucket", key: "rollup1m" },
  { table: "metric_rollups_1h", col: "bucket", key: "rollup1h" },
  { table: "events", col: "ts", key: "events" },
  { table: "incident_snapshots", col: "captured_at", key: "snapshots" },
  // Phase 4 (contracts §6.5): closed incidents by ended_at (open ones have NULL → kept); findings only once
  // confirmed_fixed (open / marked_fixed have NULL confirmed_fixed_at → kept). finding_incidents cascades.
  { table: "incidents", col: "ended_at", key: "incidents" },
  { table: "findings", col: "confirmed_fixed_at", key: "findings" },
  // Superseded hello info (valid_to set; the current row has NULL → kept) after the incident retention:
  // nothing older than the oldest kept incident needs the server's past configuration.
  { table: "server_info_history", col: "valid_to", key: "incidents" },
] as const;

/** Revoked agent keys are kept this long (shown as "revoked" in the app, then deleted). */
export const REVOKED_KEY_RETENTION_DAYS = 30;

export const RETENTION_BATCH = 5000;
export const ALERT_DELIVERY_RETENTION_DAYS = 30;

export type RetentionResult = { skipped: boolean; deleted: Record<string, number> };

/**
 * Single-flight via a SESSION advisory lock on one reserved connection (released in finally), so the
 * work itself can be split into short transactions: one per (table, plan), deleting in batches of
 * RETENTION_BATCH rows by ctid until a batch comes back empty. No long transaction holds back
 * vacuum or the rollup job's watermark (rollup.ts caps it at the oldest open transaction).
 */
export async function runRetention(db: Db, opts: { now?: number; batchSize?: number } = {}): Promise<RetentionResult> {
  const now = opts.now ?? Date.now();
  const batch = Math.max(1, Math.floor(opts.batchSize ?? RETENTION_BATCH));
  const conn = await db.$client.reserve();
  try {
    const [lock] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(${RETENTION_LOCK_KEY}) as locked`;
    if (!lock?.locked) return { skipped: true, deleted: {} };
    try {
      const deleted: Record<string, number> = {};
      for (const { table, col, key } of TABLES) {
        deleted[table] = 0;
        for (const plan of allPlanIds()) {
          const cutoff = new Date(now - retentionFor(plan)[key] * 86_400_000).toISOString();
          // ReservedSql has no begin(): plain BEGIN/COMMIT on the reserved connection.
          await conn`begin`;
          try {
            for (;;) {
              const res = await conn`
                delete from ${conn(table)} where ctid in (
                  select t.ctid from ${conn(table)} t join servers s on s.id = t.server_id
                   where s.plan = ${plan} and t.${conn(col)} < ${cutoff}::timestamptz
                   limit ${batch})`;
              deleted[table] += res.count;
              if (res.count === 0) break;
            }
            await conn`commit`;
          } catch (err) {
            await conn`rollback`.catch(() => {});
            throw err;
          }
        }
      }
      // Plugin inventory rows not seen within the incident retention AND not in the server's current hello
      // info (hellos only come on enable / plugin changes, so a long-running server's current plugins can
      // have an old last_seen: those are kept).
      deleted.plugin_inventory_history = 0;
      for (const plan of allPlanIds()) {
        const cutoff = new Date(now - retentionFor(plan).incidents * 86_400_000).toISOString();
        await conn`begin`;
        try {
          for (;;) {
            const res = await conn`
              delete from plugin_inventory_history where ctid in (
                select t.ctid from plugin_inventory_history t join servers s on s.id = t.server_id
                 where s.plan = ${plan} and t.last_seen < ${cutoff}::timestamptz
                   and not exists (
                     select 1 from server_info_history h
                       cross join lateral jsonb_array_elements(
                         case when jsonb_typeof(h.info->'plugins') = 'array' then h.info->'plugins' else '[]'::jsonb end) p
                      where h.server_id = t.server_id and h.valid_to is null
                        and p->>'name' = t.plugin and p->>'version' = t.version)
                 limit ${batch})`;
            deleted.plugin_inventory_history += res.count;
            if (res.count === 0) break;
          }
          await conn`commit`;
        } catch (err) {
          await conn`rollback`.catch(() => {});
          throw err;
        }
      }
      // Revoked API keys: 30 days after revocation on every plan.
      const keyCutoff = new Date(now - REVOKED_KEY_RETENTION_DAYS * 86_400_000).toISOString();
      deleted.api_keys = 0;
      for (;;) {
        const res = await conn`
          delete from api_keys where ctid in (
            select ctid from api_keys where revoked_at < ${keyCutoff}::timestamptz limit ${batch})`;
        deleted.api_keys += res.count;
        if (res.count === 0) break;
      }
      // Phase 6: alert deliveries are kept 30 days on every plan (contract app-phase6.ts).
      const cutoff = new Date(now - ALERT_DELIVERY_RETENTION_DAYS * 86_400_000).toISOString();
      deleted.alert_deliveries = 0;
      for (;;) {
        const res = await conn`
          delete from alert_deliveries where ctid in (
            select ctid from alert_deliveries where created_at < ${cutoff}::timestamptz limit ${batch})`;
        deleted.alert_deliveries += res.count;
        if (res.count === 0) break;
      }
      return { skipped: false, deleted };
    } finally {
      await conn`select pg_advisory_unlock(${RETENTION_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}
