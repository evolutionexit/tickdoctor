import { test, expect } from "@playwright/test";

// Phase 4: the Pi scenario windows (2026-11-09 UTC) stored in the dev DB read back as expected
// through the metrics endpoint. Skipped when the env or the Pi data is missing.
//   set -a; . ../.env; set +a; npx playwright test incident-windows
const { PI_SERVER_ID, DEV_ADMIN_TOKEN } = process.env;
test.skip(!PI_SERVER_ID || !DEV_ADMIN_TOKEN, "PI_SERVER_ID / DEV_ADMIN_TOKEN not set");
test.beforeEach(({}, ti) => { test.skip(ti.project.name !== "desktop", "API tests run once (desktop project)"); });

const headers = { Authorization: `Bearer ${DEV_ADMIN_TOKEN}` };
async function col(request: any, metric: string, from: string, to: string, idx: number): Promise<number[]> {
  const r = await request.get(`/api/servers/${PI_SERVER_ID}/metrics`, { headers, params: { metric, from, to } });
  expect(r.status()).toBe(200);
  const b = await r.json();
  test.skip(b.points.length === 0, "no Pi data in this DB");
  return b.points.map((p: any[]) => p[idx]).filter((v: any) => typeof v === "number");
}
const WINDOWS = {
  entities: ["2026-11-09T16:32:50Z", "2026-11-09T16:39:31Z"],
  chunkgen: ["2026-11-09T16:55:32Z", "2026-11-09T17:02:02Z"],
  idle: ["2026-11-09T15:10:00Z", "2026-11-09T16:25:00Z"],
  healthy4g: ["2026-11-09T18:50:00Z", "2026-11-09T19:10:00Z"],
};

test("entity spam window: MSPT p95 reaches the medium band", async ({ request }) => {
  const p95 = await col(request, "mspt_p95", ...WINDOWS.entities as [string, string], 3);
  expect(Math.max(...p95)).toBeGreaterThanOrEqual(50);
  expect(Math.max(...p95)).toBeLessThan(100);
});

test("chunk generation window: TPS drops to ~11.8 while p95 stays low", async ({ request }) => {
  const tps = await col(request, "tps_1m", ...WINDOWS.chunkgen as [string, string], 2);
  expect(Math.min(...tps)).toBeLessThan(15);
  expect(Math.min(...tps)).toBeGreaterThan(10);
  const p95 = await col(request, "mspt_p95", ...WINDOWS.chunkgen as [string, string], 3);
  expect(Math.max(...p95)).toBeLessThan(50);
});

test("idle healthy windows: TPS 20 and p95 well under 40 ms", async ({ request }) => {
  for (const w of [WINDOWS.idle, WINDOWS.healthy4g]) {
    const tps = await col(request, "tps_1m", w[0], w[1], 2);
    expect(Math.min(...tps)).toBeGreaterThanOrEqual(19);
    const p95 = await col(request, "mspt_p95", w[0], w[1], 3);
    expect(Math.max(...p95)).toBeLessThan(40);
  }
});

test("metrics endpoint rejects a missing admin token", async ({ request }) => {
  const r = await request.get(`/api/servers/${PI_SERVER_ID}/metrics`, { params: { metric: "tps_1m", from: WINDOWS.idle[0], to: WINDOWS.idle[1] } });
  expect([401, 403, 404]).toContain(r.status());
});
