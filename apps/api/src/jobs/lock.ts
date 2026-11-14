import type { Db } from "../db/client.js";

/**
 * Single-flight across processes: a SESSION advisory lock on one reserved connection (like retention.ts), so the
 * job itself may use many short transactions on other connections. Returns null when another run holds the lock.
 */
export async function withJobLock<T>(db: Db, key: number, fn: () => Promise<T>): Promise<T | null> {
  const conn = await db.$client.reserve();
  try {
    const [lock] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(${key}) as locked`;
    if (!lock?.locked) return null;
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${key})`;
    }
  } finally {
    conn.release();
  }
}
