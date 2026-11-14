import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { configureLimits } from "../src/limits.js";
import { runRetention } from "../src/jobs/retention.js";
import { purgeExpiredAuth, purgePendingUsers } from "../src/auth/store.js";
import { handle, makeServer, resetStorage } from "./helpers.js";

// Dry run of the retention job against rows straddling every window boundary, for every plan, with the
// beta switch off and on. Windows are hard-coded here on purpose (they are the documented numbers in
// pricing.md / docs data-and-privacy.md), so a change in plans.ts has to be a conscious change here too.
// Safe against any database named by TEST_DATABASE_URL (default tickdoctor_test); never the dev database.

afterAll(() => handle.close());
beforeEach(resetStorage);
afterEach(() => configureLimits({ betaAllPro: false }));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];

type Win = { raw: number; m1: number; h1: number; inc: number };
const WINDOWS: Record<"free" | "pro" | "network", Win> = {
  free: { raw: 1, m1: 3, h1: 7, inc: 7 },
  pro: { raw: 3, m1: 14, h1: 90, inc: 90 },
  network: { raw: 7, m1: 30, h1: 365, inc: 365 },
};
const AGES = [0.5, 1.5, 2.5, 5, 8, 20, 40, 100, 200, 400]; // days; none sits on a window boundary
const now = Date.now();
const iso = (d: number) => new Date(now - d * 86_400_000).toISOString();
const kept = (w: number) => AGES.filter((a) => a < w);

async function seed(serverId: string) {
  const id = sql`${serverId}`;
  for (const a of AGES) {
    const t = iso(a);
    await q(sql`insert into metric_samples (server_id, ts, detail) values (${id}, ${t}::timestamptz, '{}')`);
    await q(sql`insert into metric_rollups_1m (server_id, bucket, sample_count) values (${id}, ${t}::timestamptz, 6)`);
    await q(sql`insert into metric_rollups_1h (server_id, bucket, sample_count) values (${id}, ${t}::timestamptz, 360)`);
    await q(sql`insert into events (server_id, ts, type, data, event_hash) values (${id}, ${t}::timestamptz, 'server_start', '{}', ${`e${a}-${serverId}`})`);
    await q(sql`insert into incident_snapshots (server_id, trigger, captured_at, mspt_p95_at_trigger, snapshot) values (${id}, 'threshold', ${t}::timestamptz, 80, '{}')`);
    await q(sql`insert into incidents (server_id, started_at, ended_at, end_reason, severity, peak_mspt_p95, source)
      values (${id}, ${iso(a + 0.1)}::timestamptz, ${t}::timestamptz, 'recovered', 'high', 90, 'raw')`);
    await q(sql`insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix, status,
        first_seen_at, last_seen_at, confirmed_fixed_at, resolved_by)
      values (${id}, 'r', 'server', ${`k${a}`}, 'high', 't', 'x', '{}', 'f', 'confirmed_fixed', ${iso(a + 1)}::timestamptz, ${iso(a + 1)}::timestamptz, ${t}::timestamptz, 'auto')`);
    await q(sql`insert into server_info_history (server_id, valid_from, valid_to, info, info_hash)
      values (${id}, ${iso(a + 1)}::timestamptz, ${t}::timestamptz, '{"plugins":[]}'::jsonb, ${`h${a}`})`);
    await q(sql`insert into plugin_inventory_history (server_id, plugin, version, first_seen, last_seen) values (${id}, ${`P${a}`}, '1', ${iso(a + 1)}::timestamptz, ${t}::timestamptz)`);
    await q(sql`insert into alert_deliveries (server_id, event, status, created_at) values (${id}, 'test', 'sent', ${t}::timestamptz)`);
    await q(sql`insert into api_keys (server_id, key_hash, prefix, created_at, revoked_at) values (${id}, ${`k${a}-${serverId}`}, ${`td_${a}`}, ${iso(a + 1)}::timestamptz, ${t}::timestamptz)`);
  }
  // Must never be deleted, however old.
  await q(sql`insert into server_info_history (server_id, valid_from, valid_to, info, info_hash)
    values (${id}, ${iso(500)}::timestamptz, null, '{"plugins":[{"name":"Cur","version":"9"}]}'::jsonb, 'current')`);
  await q(sql`insert into plugin_inventory_history (server_id, plugin, version, first_seen, last_seen) values (${id}, 'Cur', '9', ${iso(500)}::timestamptz, ${iso(500)}::timestamptz)`);
  await q(sql`insert into incidents (server_id, started_at, severity, peak_mspt_p95, source) values (${id}, ${iso(500)}::timestamptz, 'high', 90, 'raw')`); // open
  for (const status of ["open", "marked_fixed"]) {
    await q(sql`insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix, status, first_seen_at, last_seen_at)
      values (${id}, 'r', 'server', ${`live-${status}`}, 'high', 't', 'x', '{}', 'f', ${status}, ${iso(500)}::timestamptz, ${iso(500)}::timestamptz)`);
  }
}

// Ages of the rows that must survive, by table.
const expectedAges = (w: Win, table: string): number[] => {
  const d = { metric_samples: w.raw, metric_rollups_1m: w.m1, metric_rollups_1h: w.h1, events: w.h1 } as Record<string, number>;
  return kept(d[table] ?? w.inc);
};
const col: Record<string, string> = {
  metric_samples: "ts", metric_rollups_1m: "bucket", metric_rollups_1h: "bucket", events: "ts", incident_snapshots: "captured_at",
  incidents: "ended_at", findings: "confirmed_fixed_at", server_info_history: "valid_to",
};
const agesLeft = async (table: string, serverId: string) =>
  (await q(sql`select round((extract(epoch from (${new Date(now).toISOString()}::timestamptz - ${sql.identifier(col[table]!)})) / 86400)::numeric, 1)::float as a
    from ${sql.identifier(table)} where server_id = ${serverId} and ${sql.identifier(col[table]!)} is not null order by 1`)).map((r) => r.a as number);

async function check(serverId: string, w: Win) {
  for (const table of Object.keys(col)) {
    expect(await agesLeft(table, serverId), `${table} ages kept`).toEqual(expectedAges(w, table));
  }
  // Rows that never expire.
  const [cur] = await q(sql`select count(*)::int n from server_info_history where server_id = ${serverId} and valid_to is null`);
  expect(cur!.n).toBe(1);
  const [inv] = await q(sql`select count(*)::int n from plugin_inventory_history where server_id = ${serverId} and plugin = 'Cur'`);
  expect(inv!.n).toBe(1);
  const [openInc] = await q(sql`select count(*)::int n from incidents where server_id = ${serverId} and ended_at is null`);
  expect(openInc!.n).toBe(1);
  const [live] = await q(sql`select count(*)::int n from findings where server_id = ${serverId} and status in ('open','marked_fixed')`);
  expect(live!.n).toBe(2);
  const [active] = await q(sql`select count(*)::int n from api_keys where server_id = ${serverId} and revoked_at is null`);
  expect(active!.n).toBe(1);
  // Plugin inventory: last_seen older than the incident window goes (Cur is protected by the current hello).
  const plugins = (await q(sql`select plugin from plugin_inventory_history where server_id = ${serverId} and plugin <> 'Cur'`)).map((r) => r.plugin).sort();
  expect(plugins).toEqual(kept(w.inc).map((a) => `P${a}`).sort());
  // Alert deliveries 30 d and revoked keys 30 d on every plan.
  const dAges = (await q(sql`select count(*)::int n from alert_deliveries where server_id = ${serverId}`))[0]!.n;
  expect(dAges).toBe(kept(30).length);
  const revoked = (await q(sql`select count(*)::int n from api_keys where server_id = ${serverId} and revoked_at is not null`))[0]!.n;
  expect(revoked).toBe(kept(30).length);
}

async function seedThree() {
  const s = { free: await makeServer({ plan: "free" }), pro: await makeServer({ plan: "pro" }), network: await makeServer({ plan: "network" }) };
  for (const v of Object.values(s)) await seed(v.serverId);
  return s;
}

describe("retention dry run", () => {
  it("BETA_ALL_PRO=false: each plan keeps exactly its own windows", async () => {
    configureLimits({ betaAllPro: false });
    const s = await seedThree();
    const r = await runRetention(handle.db, { now });
    expect(r.skipped).toBe(false);
    for (const p of ["free", "pro", "network"] as const) await check(s[p].serverId, WINDOWS[p]);
  });

  it("BETA_ALL_PRO=true: free and pro servers get Pro windows, network stays Network", async () => {
    configureLimits({ betaAllPro: true });
    const s = await seedThree();
    await runRetention(handle.db, { now });
    await check(s.free.serverId, WINDOWS.pro);
    await check(s.pro.serverId, WINDOWS.pro);
    await check(s.network.serverId, WINDOWS.network);
  });

  it("auth housekeeping: expired sessions/tokens and pending users after 7 days", async () => {
    const a = await makeServer();
    const u = a.ownerId;
    await q(sql`insert into sessions (id_hash, user_id, expires_at) values ('s-old', ${u}, ${iso(1)}::timestamptz), ('s-live', ${u}, ${new Date(now + 86_400_000).toISOString()}::timestamptz)`);
    await q(sql`insert into email_tokens (token_hash, kind, user_id, expires_at, used_at) values
      ('t-exp', 'reset', ${u}, ${iso(1)}::timestamptz, null),
      ('t-live', 'reset', ${u}, ${new Date(now + 3_600_000).toISOString()}::timestamptz, null),
      ('t-used-old', 'verify', ${u}, ${new Date(now + 3_600_000).toISOString()}::timestamptz, ${iso(2)}::timestamptz),
      ('t-used-new', 'verify', ${u}, ${new Date(now + 3_600_000).toISOString()}::timestamptz, ${iso(0.1)}::timestamptz)`);
    await q(sql`insert into users (email, last_signup_at) values ('pend-old@t.local', ${iso(8)}::timestamptz), ('pend-new@t.local', ${iso(6)}::timestamptz)`);
    await q(sql`insert into users (email, last_signup_at, created_at) values ('pend-old-created@t.local', null, ${iso(8)}::timestamptz)`);
    await purgeExpiredAuth(handle.db, now);
    expect(await purgePendingUsers(handle.db, now)).toBe(2);
    expect((await q(sql`select id_hash from sessions`)).map((r) => r.id_hash)).toEqual(["s-live"]);
    expect((await q(sql`select token_hash from email_tokens order by 1`)).map((r) => r.token_hash)).toEqual(["t-live", "t-used-new"]);
    expect((await q(sql`select email from users where email like 'pend-%'`)).map((r) => r.email)).toEqual(["pend-new@t.local"]);
    expect((await q(sql`select count(*)::int n from users where id = ${u}`))[0]!.n).toBe(1); // owner of a server is verified/kept
  });
});
