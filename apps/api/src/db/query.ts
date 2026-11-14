import type { SQL } from "drizzle-orm";
import type { Db } from "./client.js";

/** Anything that can run a statement: the Db or a transaction. */
export type Exec = Pick<Db, "execute">;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Runs a raw (parameterised) statement and returns its rows. */
export async function rows<T = Record<string, unknown>>(db: Exec, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** timestamptz → ISO string (postgres.js may hand back Date or string depending on the query). */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}
export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}
export const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/** A Postgres array literal of timestamps as ONE bind parameter (use with ::timestamptz[]). */
export function tsArray(values: number[]): string {
  return `{${values.map((v) => new Date(v).toISOString()).join(",")}}`;
}
