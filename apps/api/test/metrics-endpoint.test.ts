import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metricsResponse } from "@tickdoctor/shared";
import { metricRollups1h, metricRollups1m, metricSamples } from "../src/db/schema.js";
import { pickResolution } from "../src/routes/metrics.js";
import { ADMIN_TOKEN, PEPPER, WEB_ORIGIN, handle, makeApp, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01
const iso = (ms: number) => new Date(ms).toISOString();
let SERVER = "";

const app = makeApp({ env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, DEV_ADMIN_TOKEN: ADMIN_TOKEN } });

function get(path: string, token: string | null = ADMIN_TOKEN) {
  return app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
const url = (metric: string, from: number, to: number, id = SERVER) =>
  `/api/servers/${id}/metrics?metric=${metric}&from=${iso(from)}&to=${iso(to)}`;

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
}

beforeAll(async () => {
  await resetStorage();
  SERVER = (await makeServer({ plan: "network" })).serverId;
  // Raw: 10 s samples for 30 min, a 10 min gap (offline), then 20 min more.
  const raw = [];
  for (let s = 0; s < 3600; s += 10) {
    if (s >= 1800 && s < 2400) continue;
    raw.push({ serverId: SERVER, ts: new Date(T0 + s * 1000), mspt_p95: s / 10, cpu_temp_c: null, detail: {} });
  }
  await insertChunks(raw, (c) => handle.db.insert(metricSamples).values(c));

  // 1m rollups for 7 days.
  const minutes = [];
  for (let m = 0; m < 7 * 1440; m++) {
    minutes.push({ serverId: SERVER, bucket: new Date(T0 + m * 60_000), sampleCount: 6, mspt_p95_avg: m % 10, mspt_p95_min: 0, mspt_p95_max: 100 + (m % 7) });
  }
  await insertChunks(minutes, (c) => handle.db.insert(metricRollups1m).values(c));

  // 1h rollups for 30 days.
  const hours = [];
  for (let h = 0; h < 30 * 24; h++) hours.push({ serverId: SERVER, bucket: new Date(T0 + h * 3_600_000), sampleCount: 360, mspt_p95_avg: 5, mspt_p95_min: 1, mspt_p95_max: 50 });
  await insertChunks(hours, (c) => handle.db.insert(metricRollups1h).values(c));
});

describe("pickResolution", () => {
  it.each([
    [3_600_000, "raw", 10],
    [6 * 3_600_000, "raw", 20],
    [24 * 3_600_000, "1m", 60],
    [7 * 86_400_000, "1m", 360],
    [30 * 86_400_000, "1h", 3600],
    [400 * 86_400_000, "1h", 18000],
  ])("range %d ms → %s / %d s", (range, res, bucket) => {
    const r = pickResolution(0, range);
    expect(r).toEqual({ resolution: res, bucketSeconds: bucket });
    expect(Math.ceil(range / 1000 / r.bucketSeconds) + 1).toBeLessThanOrEqual(2000);
  });
});

describe("GET /api/servers/:id/metrics", () => {
  it("requires the dev admin token", async () => {
    expect((await get(url("mspt_p95", T0, T0 + 3_600_000), null)).status).toBe(401);
    const res = await get(url("mspt_p95", T0, T0 + 3_600_000), "b".repeat(64));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid admin token" } });
    const noToken = makeApp();
    expect((await noToken.request(url("mspt_p95", T0, T0 + 3_600_000), { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(401);
  });

  it("404 for an unknown or malformed server id", async () => {
    const res = await get(url("mspt_p95", T0, T0 + 3_600_000, "00000000-0000-4000-8000-000000000000"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
    expect((await get(url("mspt_p95", T0, T0 + 3_600_000, "not-a-uuid"))).status).toBe(404);
  });

  it("400 for a bad metric or range", async () => {
    expect((await get(url("nope", T0, T0 + 1000))).status).toBe(400);
    expect((await get(url("mspt_p95", T0 + 1000, T0))).status).toBe(400);
    const res = await get(url("mspt_p95", T0, T0 + 500 * 86_400_000));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("raw ≤ 6 h: one point per sample (avg = min = max), gaps omitted", async () => {
    const res = await get(url("mspt_p95", T0, T0 + 3_600_000));
    expect(res.status).toBe(200);
    const body = metricsResponse.parse(await res.json());
    expect(body).toMatchObject({ metric: "mspt_p95", resolution: "raw", bucketSeconds: 10, from: iso(T0), to: iso(T0 + 3_600_000) });
    expect(body.points).toHaveLength(180 + 120);
    expect(body.points[3]).toEqual([iso(T0 + 30_000), 3, 3, 3]);
    const inGap = body.points.filter(([ts]) => Date.parse(ts) >= T0 + 1_800_000 && Date.parse(ts) < T0 + 2_400_000);
    expect(inGap).toHaveLength(0);
  });

  it("raw: an unavailable metric comes back as null values", async () => {
    const body = metricsResponse.parse(await (await get(url("cpu_temp_c", T0, T0 + 600_000))).json());
    expect(body.points[0]).toEqual([iso(T0), null, null, null]);
  });

  it("raw 6 h is re-bucketed to stay ≤ 2000 points", async () => {
    const body = metricsResponse.parse(await (await get(url("mspt_p95", T0, T0 + 6 * 3_600_000))).json());
    expect(body.bucketSeconds).toBe(20);
    expect(body.points[0]).toEqual([iso(T0), 0.5, 0, 1]); // samples 0 and 1
  });

  it("1m ≤ 7 d: avg of avgs, min of mins, max of maxes, ≤ 2000 points", async () => {
    const day = await (await get(url("mspt_p95", T0, T0 + 86_400_000))).json();
    expect(day).toMatchObject({ resolution: "1m", bucketSeconds: 60 });
    expect(day.points).toHaveLength(1440);

    const week = metricsResponse.parse(await (await get(url("mspt_p95", T0, T0 + 7 * 86_400_000))).json());
    expect(week.resolution).toBe("1m");
    expect(week.bucketSeconds).toBe(360);
    expect(week.points.length).toBeLessThanOrEqual(2000);
    expect(week.points).toHaveLength(1680);
    // First 6-minute bucket: avgs 0..5 → 2.5, min 0, maxes 100..105 → 105.
    expect(week.points[0]).toEqual([iso(T0), 2.5, 0, 105]);
  });

  it("1h beyond 7 d", async () => {
    const body = metricsResponse.parse(await (await get(url("mspt_p95", T0, T0 + 30 * 86_400_000))).json());
    expect(body).toMatchObject({ resolution: "1h", bucketSeconds: 3600 });
    expect(body.points).toHaveLength(720);
    expect(body.points[0]).toEqual([iso(T0), 5, 1, 50]);
  });

  it("an empty range returns no points", async () => {
    const body = await (await get(url("players", T0 - 86_400_000, T0 - 3_600_000))).json();
    expect(body.points).toEqual([]);
  });

  it("re-bucketed rollups: avg weighted by sample_count (NULL avgs excluded)", async () => {
    const other = (await makeServer()).serverId;
    // 6-minute buckets over a week: minutes 0..5 of the first bucket.
    const rows = [
      { serverId: other, bucket: new Date(T0), sampleCount: 1, mspt_p95_avg: 100, mspt_p95_min: 100, mspt_p95_max: 100 },
      { serverId: other, bucket: new Date(T0 + 60_000), sampleCount: 5, mspt_p95_avg: 10, mspt_p95_min: 5, mspt_p95_max: 20 },
      { serverId: other, bucket: new Date(T0 + 120_000), sampleCount: 6, mspt_p95_avg: null, mspt_p95_min: null, mspt_p95_max: null }, // metric missing
    ];
    await handle.db.insert(metricRollups1m).values(rows);
    const body = metricsResponse.parse(await (await get(url("mspt_p95", T0, T0 + 7 * 86_400_000, other))).json());
    expect(body.bucketSeconds).toBe(360);
    expect(body.points[0]![1]).toBeCloseTo((100 * 1 + 10 * 5) / 6, 9); // 25, not the plain 55
    expect(body.points[0]!.slice(2)).toEqual([5, 100]);
  });
});
