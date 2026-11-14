import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDb, type Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { INGEST_TX_TIMEOUT_MS, ingestTx } from "../src/ingest/storage.js";
import { events, incidentSnapshots, metricRollups1m, metricSamples } from "../src/db/schema.js";
import { ROLLUP_LOCK_KEY, runRollup } from "../src/jobs/rollup.js";
import { RETENTION_LOCK_KEY, runRetention } from "../src/jobs/retention.js";
import { testDatabaseUrl } from "./db-url.js";
import { handle, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeEach(resetStorage);

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];

const HOUR = Date.UTC(2026, 10, 9, 10, 0, 0);
const at = (minute: number, second: number) => new Date(HOUR + minute * 60_000 + second * 1000);

async function insertSample(serverId: string, ts: Date, msptAvg: number, extra: Partial<Record<string, number | null>> = {}) {
  await handle.db.insert(metricSamples).values({
    serverId,
    ts,
    tps_1m: 20,
    mspt_avg: msptAvg,
    players: 3,
    ping_avg: null,
    detail: {},
    ...extra,
  });
}

describe("rollup job", () => {
  it("writes 1m avg/min/max/count and a sample-weighted 1h", async () => {
    const s = await makeServer();
    for (let i = 0; i < 6; i++) await insertSample(s.serverId, at(0, i * 10), 10 * (i + 1), { ping_avg: i < 2 ? 40 + i * 20 : null });
    for (let i = 0; i < 3; i++) await insertSample(s.serverId, at(1, i * 10), 100);

    const r = await runRollup(handle.db);
    expect(r).toMatchObject({ skipped: false, minutes: 2, hours: 1 });

    const m = await q(sql`select * from metric_rollups_1m where server_id = ${s.serverId} order by bucket`);
    expect(m).toHaveLength(2);
    expect(new Date(m[0]!.bucket).toISOString()).toBe(at(0, 0).toISOString());
    expect(m[0]).toMatchObject({ sample_count: 6, mspt_avg_avg: 35, mspt_avg_min: 10, mspt_avg_max: 60 });
    expect(m[0]).toMatchObject({ ping_avg_avg: 50, ping_avg_min: 40, ping_avg_max: 60 }); // NULLs ignored
    expect(m[1]).toMatchObject({ sample_count: 3, mspt_avg_avg: 100, ping_avg_avg: null, cpu_temp_c_avg: null });

    const h = await q(sql`select * from metric_rollups_1h where server_id = ${s.serverId}`);
    expect(h).toHaveLength(1);
    expect(h[0]!.sample_count).toBe(9);
    expect(h[0]!.mspt_avg_avg).toBeCloseTo((35 * 6 + 100 * 3) / 9, 9);
    expect(h[0]).toMatchObject({ mspt_avg_min: 10, mspt_avg_max: 100, players_avg: 3, ping_avg_avg: 50 });

    // Re-running changes nothing (idempotent upserts).
    await runRollup(handle.db);
    const again = await q(sql`select sample_count, mspt_avg_avg from metric_rollups_1m where server_id = ${s.serverId} order by bucket`);
    expect(again.map((x) => x.sample_count)).toEqual([6, 3]);
  });

  it("rolls up late data (old ts, new received_at) into already-built buckets", async () => {
    const s = await makeServer();
    for (let i = 0; i < 3; i++) await insertSample(s.serverId, at(5, i * 10), 20);
    await runRollup(handle.db);
    // An agent flushes its disk buffer: same minute, arriving after the rollup ran.
    await insertSample(s.serverId, at(5, 45), 60);
    await insertSample(s.serverId, at(7, 0), 30); // and a minute nobody had seen yet
    await runRollup(handle.db);

    const m = await q(sql`select * from metric_rollups_1m where server_id = ${s.serverId} order by bucket`);
    expect(m.map((x) => x.sample_count)).toEqual([4, 1]);
    expect(m[0]).toMatchObject({ mspt_avg_avg: 30, mspt_avg_max: 60 });
    const [h] = await q(sql`select * from metric_rollups_1h where server_id = ${s.serverId}`);
    expect(h).toMatchObject({ sample_count: 5, mspt_avg_avg: 30, mspt_avg_max: 60 });
  });

  it("only revisits rows received after the watermark (minus overlap)", async () => {
    const s = await makeServer();
    await insertSample(s.serverId, at(0, 0), 10);
    await runRollup(handle.db);
    // Pretend the row arrived long ago, then tamper with its rollup: a run must not touch it.
    await handle.db.execute(sql`update metric_samples set received_at = now() - interval '1 hour'`);
    await handle.db.execute(sql`update metric_rollups_1m set mspt_avg_avg = 999`);
    await runRollup(handle.db);
    const [m] = await q(sql`select mspt_avg_avg from metric_rollups_1m where server_id = ${s.serverId}`);
    expect(m!.mspt_avg_avg).toBe(999);
    const [st] = await q(sql`select watermark from job_state where name = 'rollup'`);
    expect(Date.now() - new Date(st!.watermark).getTime()).toBeLessThan(60_000);
  });

  it("is single-flight via an advisory lock", async () => {
    const other = createDb(testDatabaseUrl(), { max: 1 });
    try {
      await other.db.execute(sql`select pg_advisory_lock(${ROLLUP_LOCK_KEY})`);
      expect(await runRollup(handle.db)).toEqual({ skipped: true, minutes: 0, hours: 0 });
      await other.db.execute(sql`select pg_advisory_unlock(${ROLLUP_LOCK_KEY})`);
      expect((await runRollup(handle.db)).skipped).toBe(false);
    } finally {
      await other.close();
    }
  });

  it("rolls up rows of an ingest transaction that commits after a run, without relying on the overlap", async () => {
    const s = await makeServer();
    const other = createDb(testDatabaseUrl(), { max: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inserted = new Promise<void>((r) => (started = r));
    try {
      // A slow ingest: received_at = its start time, still uncommitted while the rollup runs.
      const slow = ingestTx(other.db, async (tx) => {
        await tx.insert(metricSamples).values({ serverId: s.serverId, ts: at(3, 0), mspt_avg: 42, detail: {} });
        started();
        await gate;
      });
      await inserted;
      await new Promise((r) => setTimeout(r, 50)); // the clock moves past the slow transaction's start
      await runRollup(handle.db, { overlapSeconds: 0 });
      expect(await q(sql`select * from metric_rollups_1m where server_id = ${s.serverId}`)).toHaveLength(0);
      release();
      await slow;
      await runRollup(handle.db, { overlapSeconds: 0 });
      const m = await q(sql`select * from metric_rollups_1m where server_id = ${s.serverId}`);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ sample_count: 1, mspt_avg_avg: 42 });
    } finally {
      release();
      await other.close();
    }
  });

  it("ingest transactions carry statement + transaction timeouts", async () => {
    const r = await ingestTx(handle.db, async (tx) =>
      tx.execute<{ st: string; tt: string }>(
        sql`select current_setting('statement_timeout') as st, current_setting('transaction_timeout') as tt`,
      ),
    );
    expect(INGEST_TX_TIMEOUT_MS).toBe(30_000);
    expect(r[0]).toEqual({ st: "30s", tt: "30s" });
    // SET LOCAL: the pool connection is back to no timeout afterwards.
    const [after] = await q(sql`select current_setting('transaction_timeout') as tt`);
    expect(after!.tt).toBe("0");
  });

  it("buckets in UTC even when the session TimeZone is Asia/Kolkata (+05:30)", async () => {
    const s = await makeServer();
    // 10:59:50 and 11:00:10 UTC straddle a UTC hour; in Kolkata they're 16:29:50 / 16:30:10 (same local hour).
    await insertSample(s.serverId, at(59, 50), 10);
    await insertSample(s.serverId, at(60, 10), 30);
    const client = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {}, connection: { TimeZone: "Asia/Kolkata" } });
    try {
      const kolkata = drizzle(client, { schema }) as unknown as Db;
      const [tz] = (await kolkata.execute(sql`show timezone`)) as unknown as Row[];
      expect(tz!.TimeZone).toBe("Asia/Kolkata");
      await runRollup(kolkata);
    } finally {
      await client.end({ timeout: 5 });
    }
    const m = await q(sql`select bucket from metric_rollups_1m where server_id = ${s.serverId} order by bucket`);
    expect(m.map((r) => new Date(r.bucket).toISOString())).toEqual([at(59, 0).toISOString(), at(60, 0).toISOString()]);
    const h = await q(sql`select bucket, sample_count from metric_rollups_1h where server_id = ${s.serverId} order by bucket`);
    expect(h.map((r) => [new Date(r.bucket).toISOString(), r.sample_count])).toEqual([
      [at(0, 0).toISOString(), 1],
      [at(60, 0).toISOString(), 1],
    ]);
    // And the API's own connections are UTC.
    const [own] = await q(sql`show timezone`);
    expect(own!.TimeZone).toBe("UTC");
  });
});

describe("retention job", () => {
  it("deletes per plan: raw / 1m / 1h / events / snapshots", async () => {
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000);
    const free = await makeServer({ plan: "free" }); // raw 1, 1m 3, 1h 7, incidents 7
    const pro = await makeServer({ plan: "pro" }); // raw 3, 1m 14, 1h 90, incidents 90

    for (const s of [free, pro]) {
      await insertSample(s.serverId, daysAgo(2), 10);
      await insertSample(s.serverId, daysAgo(0.5), 10);
      await handle.db.insert(metricRollups1m).values([
        { serverId: s.serverId, bucket: daysAgo(5), sampleCount: 6 },
        { serverId: s.serverId, bucket: daysAgo(1), sampleCount: 6 },
      ]);
      await handle.db.execute(sql`insert into metric_rollups_1h (server_id, bucket, sample_count) values
        (${s.serverId}, ${daysAgo(10).toISOString()}, 360), (${s.serverId}, ${daysAgo(2).toISOString()}, 360)`);
      await handle.db.insert(events).values([
        { serverId: s.serverId, ts: daysAgo(10), type: "server_start", data: {}, eventHash: `old-${s.serverId}` },
        { serverId: s.serverId, ts: daysAgo(1), type: "server_start", data: {}, eventHash: `new-${s.serverId}` },
      ]);
      await handle.db.insert(incidentSnapshots).values([
        { serverId: s.serverId, trigger: "threshold", capturedAt: daysAgo(10), msptP95AtTrigger: 80, snapshot: {} },
        { serverId: s.serverId, trigger: "threshold", capturedAt: daysAgo(1), msptP95AtTrigger: 80, snapshot: {} },
      ]);
    }

    const r = await runRetention(handle.db, { now });
    expect(r.skipped).toBe(false);
    expect(r.deleted).toEqual({
      metric_samples: 1,
      metric_rollups_1m: 1,
      metric_rollups_1h: 1,
      events: 1,
      incident_snapshots: 1,
      incidents: 0, // incident/finding retention: test/incidents.test.ts
      findings: 0,
      server_info_history: 0, // info / inventory / revoked keys: the next test
      plugin_inventory_history: 0,
      api_keys: 0,
      alert_deliveries: 0, // test/alerts.test.ts
    });

    const n = async (table: string, id: string) =>
      Number((await q(sql`select count(*) as n from ${sql.identifier(table)} where server_id = ${id}`))[0]!.n);
    for (const t of ["metric_samples", "metric_rollups_1m", "metric_rollups_1h", "events", "incident_snapshots"]) {
      expect(await n(t, free.serverId)).toBe(1);
      expect(await n(t, pro.serverId)).toBe(2);
    }
  });

  it("prunes superseded server info and stale plugin inventory after the incident retention, revoked keys after 30 days", async () => {
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const free = await makeServer({ plan: "free" }); // incidents 7 days
    const pro = await makeServer({ plan: "pro" }); // incidents 90 days
    const info = (plugins: { name: string; version: string }[]) => JSON.stringify({ plugins });
    for (const s of [free, pro]) {
      // Closed 10 days ago (gone on free, kept on pro), closed 1 day ago (kept), current since 200 days (kept everywhere).
      await q(sql`insert into server_info_history (server_id, valid_from, valid_to, info, info_hash) values
        (${s.serverId}, ${daysAgo(30)}, ${daysAgo(10)}, ${info([])}::jsonb, 'a'),
        (${s.serverId}, ${daysAgo(10)}, ${daysAgo(1)}, ${info([])}::jsonb, 'b'),
        (${s.serverId}, ${daysAgo(1)}, null, ${info([{ name: "Current", version: "1.0" }])}::jsonb, 'c')`);
      await q(sql`insert into plugin_inventory_history (server_id, plugin, version, first_seen, last_seen) values
        (${s.serverId}, 'Removed', '1.0', ${daysAgo(200)}, ${daysAgo(100)}),
        (${s.serverId}, 'Removed', '0.9', ${daysAgo(200)}, ${daysAgo(10)}),
        (${s.serverId}, 'Current', '1.0', ${daysAgo(200)}, ${daysAgo(200)}),
        (${s.serverId}, 'Recent', '2.0', ${daysAgo(2)}, ${daysAgo(2)})`);
      await q(sql`insert into api_keys (server_id, key_hash, prefix, created_at, revoked_at) values
        (${s.serverId}, ${`old-${s.serverId}`}, 'td_live_old', ${daysAgo(60)}, ${daysAgo(31)}),
        (${s.serverId}, ${`new-${s.serverId}`}, 'td_live_new', ${daysAgo(60)}, ${daysAgo(29)})`);
    }

    const r = await runRetention(handle.db, { now });
    expect(r.deleted).toMatchObject({ server_info_history: 1, plugin_inventory_history: 3, api_keys: 2 });

    const infos = async (id: string) =>
      (await q(sql`select info_hash from server_info_history where server_id = ${id} order by valid_from`)).map((x) => x.info_hash);
    expect(await infos(free.serverId)).toEqual(["b", "c"]);
    expect(await infos(pro.serverId)).toEqual(["a", "b", "c"]);
    const plugins = async (id: string) =>
      (await q(sql`select plugin || '@' || version as p from plugin_inventory_history where server_id = ${id} order by 1`)).map((x) => x.p);
    expect(await plugins(free.serverId)).toEqual(["Current@1.0", "Recent@2.0"]);
    expect(await plugins(pro.serverId)).toEqual(["Current@1.0", "Recent@2.0", "Removed@0.9"]);
    for (const s of [free, pro]) {
      const revoked = (await q(sql`select prefix from api_keys where server_id = ${s.serverId} and revoked_at is not null`)).map((x) => x.prefix);
      expect(revoked).toEqual(["td_live_new"]);
      const [active] = await q(sql`select count(*)::int as n from api_keys where server_id = ${s.serverId} and revoked_at is null`);
      expect(active!.n).toBe(1); // the active key from makeServer stays
    }
  });

  it("account deletion cascades through every table", async () => {
    const s = await makeServer();
    await insertSample(s.serverId, new Date(), 10);
    await handle.db.insert(events).values({ serverId: s.serverId, ts: new Date(), type: "server_start", data: {}, eventHash: "x" });
    await runRollup(handle.db);
    await handle.db.execute(sql`delete from users where id = ${s.ownerId}`);
    for (const t of ["servers", "api_keys", "metric_samples", "metric_rollups_1m", "metric_rollups_1h", "events"]) {
      const [row] = await q(sql`select count(*) as n from ${sql.identifier(t)}`);
      expect(Number(row!.n)).toBe(0);
    }
  });

  it("deletes > 5000 rows in batches and leaves newer rows alone", async () => {
    const s = await makeServer({ plan: "free" });
    const now = Date.now();
    // 12,345 raw samples 2–3 days old (free keeps 1 day) + 10 fresh ones.
    await handle.db.execute(sql`
      insert into metric_samples (server_id, ts, detail)
      select ${s.serverId}, ${new Date(now - 3 * 86_400_000).toISOString()}::timestamptz + g * interval '1 second', '{}'::jsonb
        from generate_series(1, 12345) g`);
    for (let i = 0; i < 10; i++) await insertSample(s.serverId, new Date(now - i * 10_000), 10);
    const r = await runRetention(handle.db, { now });
    expect(r.deleted.metric_samples).toBe(12_345);
    const [left] = await q(sql`select count(*)::int as n from metric_samples where server_id = ${s.serverId}`);
    expect(left!.n).toBe(10);
  });

  it("is single-flight via a session advisory lock, released afterwards", async () => {
    const other = createDb(testDatabaseUrl(), { max: 1 });
    try {
      await other.db.execute(sql`select pg_advisory_lock(${RETENTION_LOCK_KEY})`);
      expect(await runRetention(handle.db)).toEqual({ skipped: true, deleted: {} });
      await other.db.execute(sql`select pg_advisory_unlock(${RETENTION_LOCK_KEY})`);
      expect((await runRetention(handle.db)).skipped).toBe(false);
      // Our run unlocked in finally: another session can take the lock now.
      const [l] = (await other.db.execute(sql`select pg_try_advisory_lock(${RETENTION_LOCK_KEY}) as locked`)) as unknown as Row[];
      expect(l!.locked).toBe(true);
      await other.db.execute(sql`select pg_advisory_unlock(${RETENTION_LOCK_KEY})`);
    } finally {
      await other.close();
    }
  });
});
