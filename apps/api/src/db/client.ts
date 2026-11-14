import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  // Session TimeZone pinned to UTC: bucketing (date_trunc) and any timestamptz → text conversion
  // must never depend on the server's or a client's locale (contracts §5.2 "All bucketing is UTC").
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {}, connection: { TimeZone: "UTC" } });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
