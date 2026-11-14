import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createApp, type AppDeps } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { createServer } from "../src/servers.js";
import { testDatabaseUrl } from "./db-url.js";

export const WEB_ORIGIN = "http://localhost:3000";
export const PEPPER = "test-pepper-0123456789abcdef";
export const ADMIN_TOKEN = "a".repeat(64);

export const handle = createDb(testDatabaseUrl(), { max: 2 });

export async function resetDb() {
  await handle.db.execute(sql`truncate table waitlist`);
}

/** Wipes every Phase 3 table (users cascade to servers and everything hanging off them). */
export async function resetStorage() {
  await handle.db.execute(sql`truncate table users, job_state cascade`);
}

export function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    db: handle.db,
    env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER },
    // No background server-rules pass after hello in tests (it would outlive the test); detection stays on.
    onHello: false,
    ...overrides,
  });
}

let serverCounter = 0;
export async function makeServer(opts: { plan?: string; name?: string } = {}) {
  serverCounter++;
  return createServer(handle.db, PEPPER, {
    name: opts.name ?? `Test server ${serverCounter}`,
    ownerEmail: `owner${serverCounter}@test.local`,
    plan: opts.plan,
  });
}

let ipCounter = 0;
/** A fresh client IP per call so tests don't share rate-limit buckets. */
export function freshIp() {
  ipCounter++;
  return `203.0.113.${ipCounter % 250}`;
}

export const ENDPOINTS = ["hello", "metrics", "events", "snapshot"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** Hand-made fixtures with players, pings, entities and host data. */
export const fixture = (name: Endpoint) =>
  JSON.parse(readFileSync(new URL(`./fixtures/ingest/${name}.json`, import.meta.url), "utf8"));

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A fixture with every ISO timestamp shifted so its `sentAt` is `nowMs` (default: now). The hand-made fixtures are
 * stamped 2026-11-09; once that is older than a plan's raw retention, ingest would silently drop their samples.
 */
export function freshFixture(name: Endpoint, nowMs = Date.now()) {
  const f = fixture(name);
  const shift = nowMs - Date.parse(f.sentAt);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && ISO_RE.test(v)) return new Date(Date.parse(v) + shift).toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(f) as ReturnType<typeof fixture>;
}

/** Real payloads captured from the Pi (debug-endpoint responses: items[].body). */
export const piReal = (name: Endpoint): unknown[] =>
  JSON.parse(readFileSync(new URL(`../../../e2e/fixtures/pi-real/${name}.json`, import.meta.url), "utf8")).items.map(
    (i: { body: unknown }) => i.body,
  );
