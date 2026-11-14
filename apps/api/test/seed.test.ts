import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { metricSamples } from "../src/db/schema.js";
import { DEMO_SERVERS, EPISODES, assertSeedAllowed, parseSeedArgs, seed, wipeDemo } from "../src/seed.js";
import { handle, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];
const NOW = Date.UTC(2026, 10, 9, 18, 0, 3);
const H = 3_600_000;
let other = "";

beforeAll(async () => {
  await resetStorage();
  other = (await makeServer()).serverId;
  await handle.db.insert(metricSamples).values({ serverId: other, ts: new Date(NOW - 60_000), mspt_avg: 1, detail: {} });
});

describe("seed", () => {
  it("writes raw for the last hours, rollups before that, and is idempotent", async () => {
    const first = await seed(handle.db, { days: 2, rawHours: 12, now: NOW });
    const anchor = Math.floor(NOW / 10_000) * 10_000;
    const rawStart = Math.floor((anchor - 12 * H) / H) * H;
    const start = Math.floor((anchor - 48 * H) / H) * H;
    const rawPerServer = (anchor - rawStart) / 10_000;
    expect(first.counts.metric_samples).toBe(2 * rawPerServer);
    // 1m: older region written directly + the raw window rolled up by the job.
    expect(first.counts.metric_rollups_1m).toBe(2 * ((rawStart - start) / 60_000 + Math.floor(anchor / 60_000) - rawStart / 60_000 + 1));
    expect(first.counts.metric_rollups_1h).toBe(2 * (Math.floor(anchor / H) - start / H + 1));
    expect(first.counts.events).toBeGreaterThan(50);
    expect(first.counts.incident_snapshots).toBe(2);
    expect(first.counts.server_info_history).toBe(2); // plugin-update episode is outside a 2-day window

    const again = await seed(handle.db, { days: 2, rawHours: 12, now: NOW });
    expect(again.counts).toEqual(first.counts);
  }, 60_000); // two full seeds (2 days + rules passes): ~15 s on a busy machine

  it("contains the lag episodes where the header says", async () => {
    const anchor = Math.floor(NOW / 10_000) * 10_000;
    const ep = (id: string) => EPISODES.find((e) => e.id === id)!;
    const avg = async (server: string, col: string, fromH: number, toH: number) => {
      const [r] = await q(sql`select avg(${sql.identifier(col)})::float8 as v from metric_samples
        where server_id = ${server} and ts >= ${new Date(anchor + fromH * H).toISOString()} and ts < ${new Date(anchor + toH * H).toISOString()}`);
      return r!.v as number;
    };
    const hot = ep("pi-hot-afternoon");
    expect(await avg(DEMO_SERVERS.pi.id, "cpu_temp_c", hot.startH + 0.5, hot.endH - 0.5)).toBeGreaterThan(80);
    expect(await avg(DEMO_SERVERS.pi.id, "cpu_temp_c", -12, -8)).toBeLessThan(65);
    expect(await avg(DEMO_SERVERS.smp.id, "cpu_temp_c", -12, 0)).toBeNull(); // VPS: no temperature
    const [thr] = await q(sql`select count(*)::int as n from metric_samples where server_id = ${DEMO_SERVERS.pi.id} and detail->'host'->'throttled'->>'now' = 'true'`);
    expect(thr!.n).toBeGreaterThan(100);

    const build = ep("smp-entity-buildup");
    const late = await avg(DEMO_SERVERS.smp.id, "entities", build.endH - 0.5, build.endH);
    const before = await avg(DEMO_SERVERS.smp.id, "entities", build.startH - 1, build.startH);
    expect(late - before).toBeGreaterThan(3000);
    expect(await avg(DEMO_SERVERS.smp.id, "mspt_p95", build.endH - 0.5, build.endH)).toBeGreaterThan(
      2 * (await avg(DEMO_SERVERS.smp.id, "mspt_p95", build.startH - 1, build.startH)),
    );
    const [cku] = await q(sql`select count(*)::int as n from events where server_id = ${DEMO_SERVERS.smp.id} and type = 'cant_keep_up'`);
    expect(cku!.n).toBeGreaterThan(0);
  });

  it("player curve: busier evenings than mornings", async () => {
    const [r] = await q(sql`select
        avg(players_avg) filter (where extract(hour from bucket) between 19 and 21) as evening,
        avg(players_avg) filter (where extract(hour from bucket) between 6 and 9) as morning
      from metric_rollups_1h where server_id = ${DEMO_SERVERS.smp.id}`);
    expect(Number(r!.evening)).toBeGreaterThan(Number(r!.morning) + 3);
  });

  it("wipe/reset touch demo data only", async () => {
    await wipeDemo(handle.db);
    const [n] = await q(sql`select count(*)::int as n from servers where id in (${DEMO_SERVERS.pi.id}, ${DEMO_SERVERS.smp.id})`);
    expect(n!.n).toBe(0);
    const [u] = await q(sql`select count(*)::int as n from users where email = 'demo@tickdoctor.local'`);
    expect(u!.n).toBe(0);
    const [mine] = await q(sql`select count(*)::int as n from metric_samples where server_id = ${other}`);
    expect(mine!.n).toBe(1);
  });

  it("parses CLI args", () => {
    expect(parseSeedArgs(["--reset", "--days", "7"])).toEqual({ reset: true, wipe: false, force: false, days: 7 });
    expect(parseSeedArgs(["--force"]).force).toBe(true);
    expect(() => parseSeedArgs(["--days", "0"])).toThrow();
    expect(() => parseSeedArgs(["--bogus"])).toThrow();
  });

  it("refuses NODE_ENV=production unless --force", () => {
    expect(() => assertSeedAllowed("production", false)).toThrow(/--force/);
    expect(() => assertSeedAllowed("production", true)).not.toThrow();
    expect(() => assertSeedAllowed("development", false)).not.toThrow();
    expect(() => assertSeedAllowed(undefined, false)).not.toThrow();
  });
});
