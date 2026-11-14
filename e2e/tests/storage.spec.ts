import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Phase 3 storage tests against the live stack. Secrets come from env at runtime:
//   set -a; . ../.env; set +a; npx playwright test storage
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const { PI_AGENT_KEY, PI_SERVER_ID, DEV_ADMIN_TOKEN } = process.env;
const fx = (ep: string): any[] => JSON.parse(readFileSync(join(here, `../fixtures/pi-real/${ep}.json`), "utf8")).items.map((i: any) => i.body);

test.describe.configure({ mode: "serial" });
test.skip(!PI_AGENT_KEY || !DEV_ADMIN_TOKEN, "PI_AGENT_KEY / DEV_ADMIN_TOKEN not set: export them from .env to run storage tests");
test.beforeEach(({}, ti) => { test.skip(ti.project.name !== "desktop", "API tests run once (desktop project)"); });

const dc = (args: string[]) => execFileSync("docker", ["compose", ...args], { cwd: repo, encoding: "utf8" });
const sql = (q: string) => dc(["exec", "-T", "postgres", "psql", "-U", "tickdoctor", "-tAc", q]).trim();
const admin = { Authorization: `Bearer ${DEV_ADMIN_TOKEN}` };

const SAMPLES = 24; // 4 full minutes of 10 s samples
const MIN = 60_000;
let id = "";
let key = "";
let bootId = randomUUID();
let base = 0; // minute-aligned start of the first sample
let sent: { ts: string; entities: number }[] = [];
let email = "qa@tickdoctor.local";
let cleaned = false;

const env = (body: any, payload: any) => ({ ...body, sentAt: new Date().toISOString(), bootId, payload });
const post = (request: APIRequestContext, ep: string, body: any, k = key) =>
  request.post(`/v1/ingest/${ep}`, { headers: { Authorization: `Bearer ${k}` }, data: body });
const metrics = async (request: APIRequestContext, sid: string, metric: string, from: Date, to: Date, headers: any = admin) =>
  request.get(`/api/servers/${sid}/metrics`, { headers, params: { metric, from: from.toISOString(), to: to.toISOString() } });

function buildSamples() {
  const src = fx("metrics").flatMap((b) => b.payload.samples);
  base = Math.floor((Date.now() - 10 * MIN) / MIN) * MIN;
  sent = [];
  return Array.from({ length: SAMPLES }, (_, i) => {
    const s = structuredClone(src[i % src.length]);
    s.ts = new Date(base + i * 10_000).toISOString();
    s.world.forEach((w: any, wi: number) => (w.entities = wi === 0 ? 100 + i : 5));
    sent.push({ ts: s.ts, entities: 100 + i + 5 * (s.world.length - 1) });
    return s;
  });
}

test.beforeAll(({}, ti) => {
  if (ti.project.name !== "desktop" || !PI_AGENT_KEY || !DEV_ADMIN_TOKEN) return;
  const out = dc(["exec", "-T", "api", "node", "dist/cli.js", "server:create", "--name", `qa-${Date.now()}`, "--owner-email", email]);
  id = /server_id=([0-9a-f-]{36})/.exec(out)?.[1] ?? "";
  key = /api_key=(td_live_\S+)/.exec(out)?.[1] ?? "";
  if (!id || !key) throw new Error("could not parse server:create output");
});

test.afterAll(() => {
  if (id && !cleaned) try { sql(`delete from users where email='${email}'`); } catch { /* best effort */ }
});

test("ingest hello/metrics/events/snapshot all accepted", async ({ request }) => {
  const hello = fx("hello")[0];
  let r = await post(request, "hello", env(hello, hello.payload));
  expect(r.status(), await r.text()).toBeLessThan(300);
  expect((await r.json()).ok).toBe(true);

  const samples = buildSamples();
  for (let i = 0; i < samples.length; i += 6) {
    r = await post(request, "metrics", env(fx("metrics")[0], { samples: samples.slice(i, i + 6) }));
    expect(r.status(), await r.text()).toBeLessThan(300);
  }

  const ev = fx("events")[0];
  const now = new Date().toISOString();
  const events = [
    ...ev.payload.events.map((e: any) => ({ ...e, ts: now })),
    {
      type: "exception", ts: now, exceptionClass: "java.io.IOException", stackHash: "abc123", count: 1,
      message: "Player Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5) lost connection from /1.2.3.4:5555",
      topFrames: ["net.minecraft.Foo.bar(Foo.java:1)"],
    },
  ];
  r = await post(request, "events", env(ev, { events: events }));
  expect(r.status(), await r.text()).toBeLessThan(300);

  const snap = fx("snapshot")[0];
  const p = structuredClone(snap.payload);
  p.ts = now;
  p.sample.ts = now;
  r = await post(request, "snapshot", env(snap, p));
  expect(r.status(), await r.text()).toBeLessThan(300);

  expect(sql(`select count(*) from server_info_history where server_id='${id}'`)).toBe("1");
  expect(Number(sql(`select count(*) from plugin_inventory_history where server_id='${id}'`))).toBeGreaterThan(0);
  expect(sql(`select count(*) from incident_snapshots where server_id='${id}' and incident_id is null`)).toBe("1");
  expect(sql(`select boot_id from servers where id='${id}'`)).toBe(bootId);
});

test("metrics read: raw resolution, points match what was sent", async ({ request }) => {
  const r = await metrics(request, id, "entities", new Date(base - MIN), new Date());
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.resolution).toBe("raw");
  expect(j.points.length).toBeLessThanOrEqual(2000);
  expect(j.points.length).toBe(SAMPLES);
  j.points.forEach((p: any, i: number) => {
    expect(Date.parse(p[0])).toBe(Date.parse(sent[i].ts));
    expect(p.slice(1)).toEqual([sent[i].entities, sent[i].entities, sent[i].entities]);
  });
});

test("re-sending the same metrics is idempotent", async ({ request }) => {
  const samples = buildSamples().map((s, i) => ({ ...s })); // new base would shift ts: reuse stored ones instead
  // buildSamples recomputed base; if a minute boundary passed, ts differ, so use stored timestamps
  const stored = await (await metrics(request, id, "entities", new Date(base - 10 * MIN), new Date())).json();
  const before = stored.points.length;
  const first = stored.points.slice(0, 6).map((p: any) => p[0]);
  const resend = samples.slice(0, 6).map((s, i) => ({ ...s, ts: first[i] }));
  const r = await post(request, "metrics", env(fx("metrics")[0], { samples: resend }));
  expect(r.status()).toBeLessThan(300);
  const after = await (await metrics(request, id, "entities", new Date(base - 10 * MIN), new Date())).json();
  expect(after.points.length).toBe(before);
  expect(sql(`select count(*) from metric_samples where server_id='${id}'`)).toBe(String(before));
});

test("sample 1 h in the future is not stored", async ({ request }) => {
  const s = buildSamples()[0];
  const ts = new Date(Date.now() + 3600_000);
  s.ts = ts.toISOString();
  const r = await post(request, "metrics", env(fx("metrics")[0], { samples: [s] }));
  expect(r.status(), await r.text()).toBeLessThan(500);
  expect(sql(`select count(*) from metric_samples where server_id='${id}' and ts > now() + interval '10 minutes'`)).toBe("0");
  const j = await (await metrics(request, id, "entities", new Date(Date.now() - MIN), new Date(Date.now() + 2 * 3600_000))).json();
  expect(j.points.some((p: any) => Date.parse(p[0]) > Date.now() + 10 * MIN)).toBe(false);
});

test("exception event is stored scrubbed", async () => {
  const data = sql(`select data::text from events where server_id='${id}' and type='exception'`);
  expect(data).toContain("<uuid>");
  expect(data).toContain("<ip>");
  expect(data).not.toContain("069a79f4-44e9-4726-a5be-fca90e38aaf5");
  expect(data).not.toContain("1.2.3.4");
});

test("rollup job writes metric_rollups_1m with correct sample_count", async () => {
  test.setTimeout(150_000);
  const bucket = new Date(base + MIN).toISOString(); // a full minute of 6 samples
  let n = "";
  for (let i = 0; i < 30; i++) {
    n = sql(`select sample_count from metric_rollups_1m where server_id='${id}' and bucket='${bucket}'`);
    if (n) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  expect(n, "no 1m rollup row after ~150 s").toBe("6");
  const avg = sql(`select entities_avg from metric_rollups_1m where server_id='${id}' and bucket='${bucket}'`);
  const exp = sent.slice(6, 12).reduce((a, s) => a + s.entities, 0) / 6;
  expect(Number(avg)).toBeCloseTo(exp, 3);
});

test("wrong key -> 401, revoked key -> 401 revoked_key", async ({ request }) => {
  let r = await post(request, "metrics", { x: 1 }, "td_live_" + "A".repeat(32));
  expect(r.status()).toBe(401);
  r = await request.post("/v1/ingest/metrics", { data: {} });
  expect(r.status()).toBe(401);

  dc(["exec", "-T", "api", "node", "dist/cli.js", "server:revoke-key", id]);
  const s = buildSamples().slice(0, 1);
  r = await post(request, "metrics", env(fx("metrics")[0], { samples: s }));
  expect(r.status()).toBe(401);
  expect(JSON.stringify(await r.json())).toContain("revoked_key");
});

test("cleanup: deleting the user cascades everything", async () => {
  sql(`delete from users where email='${email}'`);
  cleaned = true;
  for (const t of ["servers:id", "api_keys:server_id", "metric_samples:server_id", "metric_rollups_1m:server_id", "metric_rollups_1h:server_id",
    "events:server_id", "incident_snapshots:server_id", "server_info_history:server_id", "plugin_inventory_history:server_id"]) {
    const [tbl, col] = t.split(":");
    expect(sql(`select count(*) from ${tbl} where ${col}='${id}'`), tbl).toBe("0");
  }
});

test.describe("metrics endpoint", () => {
  test("404 for random uuid, 401 without token, 400 bad metric / bad range", async ({ request }) => {
    const now = new Date();
    const from = new Date(now.getTime() - 3600_000);
    let r = await metrics(request, randomUUID(), "entities", from, now);
    expect(r.status()).toBe(404);
    expect((await r.json()).error?.code).toBeTruthy();
    r = await metrics(request, randomUUID(), "entities", from, now, {});
    expect(r.status()).toBe(401);
    r = await metrics(request, randomUUID(), "entities", from, now, { Authorization: "Bearer wrong" });
    expect(r.status()).toBe(401);
    const seed = sql(`select id from servers where name='Friends SMP'`);
    r = await metrics(request, seed, "not_a_metric", from, now);
    expect(r.status()).toBe(400);
    r = await metrics(request, seed, "entities", now, from);
    expect(r.status()).toBe(400);
    r = await metrics(request, seed, "entities", new Date(now.getTime() - 500 * 86_400_000), now);
    expect(r.status()).toBe(400);
  });

  test("resolution by range, always <= 2000 points", async ({ request }) => {
    const seed = sql(`select id from servers where name='Friends SMP'`);
    expect(seed).toMatch(/^[0-9a-f-]{36}$/);
    // The seed is a fixed-age snapshot (created when `pnpm seed` ran), so anchor the windows at its newest sample, not at "now".
    const now = new Date(sql(`select to_char(max(ts) at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from metric_samples where server_id='${seed}'`));
    for (const [hours, res] of [[1, "raw"], [6, "raw"], [12, "1m"], [24, "1m"], [7 * 24, "1m"], [30 * 24, "1h"]] as const) {
      const r = await metrics(request, seed, "tps_1m", new Date(now.getTime() - hours * 3600_000), now);
      expect(r.status(), `${hours}h`).toBe(200);
      const j = await r.json();
      expect(j.resolution, `${hours}h`).toBe(res);
      expect(j.points.length, `${hours}h`).toBeLessThanOrEqual(2000);
      if (hours >= 12) expect(j.points.length, `${hours}h has data`).toBeGreaterThan(0);
    }
  });
});

test.describe("real Pi data sanity (read-only)", () => {
  test.skip(!PI_SERVER_ID, "PI_SERVER_ID not set");
  test("samples exist, no 64-hex strings, Paper 26.2", async () => {
    const n = Number(sql(`select count(*) from metric_samples where server_id='${PI_SERVER_ID}'`));
    expect(n).toBeGreaterThan(0);
    const re = "[0-9a-fA-F]{64}";
    expect(sql(`select count(*) from events where server_id='${PI_SERVER_ID}' and data::text ~ '${re}'`), "events.data").toBe("0");
    expect(sql(`select count(*) from metric_samples where server_id='${PI_SERVER_ID}' and detail::text ~ '${re}'`), "metric_samples.detail").toBe("0");
    expect(sql(`select count(*) from incident_snapshots where server_id='${PI_SERVER_ID}' and snapshot::text ~ '${re}'`), "snapshots").toBe("0");
    const info = sql(`select * from server_info_history where server_id='${PI_SERVER_ID}' and valid_to is null`);
    expect(info).toMatch(/Paper/);
    expect(info).toMatch(/26\.2/);
  });
});
