import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { BASE, contextFor, dropUser, pushData, repo, seedUser } from "./app-helpers";
import { cfg, serverWithStatus, slugOf } from "./phase7-helpers";

// Runs in the "ratelimit" Playwright project, which is the teardown of the desktop project: it exhausts this machine's per-IP public-status limit,
// which would make every other public-status spec flaky if it ran in parallel.
test.setTimeout(240_000);
const dcEnv = { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` };

test.beforeAll(async () => {
  for (let i = 0; i < 16; i++) {
    if ((await fetch(`${BASE}/api/public/status/zz-warmup`)).status !== 429) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
});

test("rate limit: 429 -> friendly 'Too many requests' page (not a 500) while another IP still works", async ({ page, request, browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const owner = await ctx.newPage();
  const sv = await serverWithStatus(owner, "RL", cfg(slugOf("rl"), { title: "RL" }));
  await pushData(owner.request, sv.key);
  const slug = (await (await owner.request.get(`/api/servers/${sv.id}/status-page`)).json() as { slug: string }).slug;
  await ctx.close();
  let limited = 0;
  for (let i = 0; i < 80 && !limited; i++) {
    const r = await request.get(`/api/public/status/${slug}`);
    if (r.status() === 429) limited = i + 1;
  }
  expect(limited, "429 reached within 80 requests").toBeGreaterThan(0);
  expect(limited).toBeLessThanOrEqual(61);
  // spoofing XFF from outside does not escape the limit (Caddy owns that header)
  const spoof = await request.get(`/api/public/status/${slug}`, { headers: { "X-Forwarded-For": "198.51.100.200" } });
  expect(spoof.status(), "client-supplied XFF must not bypass").toBe(429);
  const rl = await request.get(`/api/public/status/${slug}`);
  expect(rl.headers()["retry-after"]).toBeTruthy();

  const resp = await page.goto(`/s/${slug}`);
  expect(resp!.status(), "rate limited page is not a 500").toBeLessThan(500);
  await expect(page.getByRole("heading", { name: "Too many requests" })).toBeVisible();
  await expect(page.getByText(/Please try again in a minute/)).toBeVisible();

  // another IP (direct to the API container with a different X-Forwarded-For) is unaffected
  const js = `fetch('http://localhost:4000/api/public/status/${slug}',{headers:{'x-forwarded-for':'203.0.113.77'}}).then(async r=>console.log(r.status))`;
  const out = execFileSync("docker", ["compose", "exec", "-T", "api", "node", "-e", js], { cwd: repo, env: dcEnv, encoding: "utf8" }).trim();
  expect(out).toBe("200");
  const js2 = `fetch('http://localhost:4000/api/public/status/${slug}',{headers:{'x-forwarded-for':'203.0.113.77'}}).then(async r=>console.log(r.status))`;
  expect(execFileSync("docker", ["compose", "exec", "-T", "api", "node", "-e", js2], { cwd: repo, env: dcEnv, encoding: "utf8" }).trim()).toBe("200");

  // window clears
  await page.waitForTimeout(65_000);
  expect((await request.get(`/api/public/status/${slug}`)).status()).toBe(200);
  dropUser(u.email);
});
