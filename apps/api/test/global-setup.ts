import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.js";
import { testDatabaseUrl } from "./db-url.js";

/** Creates the tickdoctor_test database if needed and applies all migrations. */
export default async function setup() {
  const url = new URL(testDatabaseUrl());
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Refusing odd test database name: ${dbName}`);

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  await runMigrations(url.toString());
}
