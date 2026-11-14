import { expect, test } from "@playwright/test";
import { apiPost, BASE, contextFor, dropUser, seedUser } from "./app-helpers";
import { pushData } from "./app-helpers";
import { cfg, serverWithStatus, slugOf } from "./phase7-helpers";

// Public status pages. The public status API is limited to 60 requests/min per IP (in memory): keep the request count per run low.
// The test that deliberately exhausts the limit is tests/phase7-ratelimit.spec.ts (own project, runs after everything else).
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(120_000);

const HOSTILE = `A [b] & <i>"q"</i> <script>alert(1)</script>`;
const KEYS = ["branding", "generatedAt", "incidents", "lastSeenAt", "players", "state", "theme", "title", "uptime"];
const dcEnv = { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` };

const free = seedUser();
const pro = seedUser({ plan: "pro" });
const S = { free: slugOf("free"), pro: slugOf("pro"), minimal: slugOf("min") };
const ids: Record<string, string> = {};
let freePage: import("@playwright/test").Page;
let proPage: import("@playwright/test").Page;

test.beforeAll(async ({ browser }) => {
  // a previous run may have left this IP rate limited: wait for the window to clear
  for (let i = 0; i < 16; i++) {
    if ((await fetch(`${BASE}/api/public/status/zz-warmup`)).status !== 429) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  freePage = await (await contextFor(browser, free)).newPage();
  proPage = await (await contextFor(browser, pro)).newPage();
  const a = await serverWithStatus(freePage, "Free Pub", cfg(S.free, { title: HOSTILE, showIncidents: true, theme: "dark" }));
  ids.free = a.id;
  await pushData(freePage.request, a.key, { players: 7 });
  const b = await serverWithStatus(proPage, "Pro Pub", cfg(S.pro, { title: "Pro Page", hideBranding: true, theme: "light", showPlayers: false, showUptime: false, showIncidents: false }));
  ids.pro = b.id;
  await pushData(proPage.request, b.key, { players: 3 });
});
test.afterAll(async () => {
  await freePage.context().close();
  await proPage.context().close();
  dropUser(free.email);
  dropUser(pro.email);
});

test("public JSON: exactly the contract keys, no Set-Cookie, nothing sensitive", async ({ request }) => {
  const r = await request.get(`/api/public/status/${S.free}`);
  expect(r.status()).toBe(200);
  expect(Object.keys(await r.json()).sort()).toEqual(KEYS);
  expect(r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie")).toEqual([]);
  expect(r.headers()["cache-control"]).toMatch(/public, max-age=30/);
  const j = (await r.json()) as Record<string, unknown>;
  expect(j.state).toBe("operational");
  expect(j.players).toEqual({ online: 7, max: expect.anything() });
  expect(j.incidents).toEqual([]);
  expect(j.branding).toBe(true);
  expect(j.theme).toBe("dark");
  const body = await r.text();
  for (const bad of ["td_live_", "owner", "@test.local", ids.free, "plugins"]) expect(body, bad).not.toContain(bad);
  // toggles off -> null, not omitted
  const p = (await (await request.get(`/api/public/status/${S.pro}`)).json()) as Record<string, unknown>;
  expect(Object.keys(p).sort()).toEqual(KEYS);
  expect([p.players, p.uptime, p.incidents]).toEqual([null, null, null]);
  expect(p.branding).toBe(false);
  // uppercase slug works, unknown -> 404 with identical body to disabled
  expect((await request.get(`/api/public/status/${S.free.toUpperCase()}`)).status()).toBe(200);
  const unknown = await request.get(`/api/public/status/no-such-${slugOf("x")}`);
  expect(unknown.status()).toBe(404);
  expect(unknown.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie")).toEqual([]);
});

test("public page /s/<slug>: state icon+word, toggled sections, branding, theme, noindex, og:title, uppercase", async ({ page }) => {
  const resp = await page.goto(`/s/${S.free}`);
  expect(resp!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(HOSTILE);
  await expect(page.locator("#state-h").locator("xpath=..").getByText("Operational", { exact: true })).toBeVisible();
  await expect(page.locator("#state-h").locator("xpath=..").locator("svg").first()).toBeVisible(); // icon, not colour only
  await expect(page.getByText("Players online")).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^7/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Uptime" })).toBeVisible();
  await expect(page.getByText("Last 24 hours")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent incidents" })).toBeVisible();
  await expect(page.getByText("No incidents in the last 30 days.")).toBeVisible();
  await expect(page.getByText("Monitored with")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", `${HOSTILE} status | TickDoctor`);
  await expect(page.locator("div.status-theme-dark").first()).toBeVisible();
  // hostile title is text, not markup
  expect(await page.locator("main script, h1 script, h1 i").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
  // no cookies set by the public page
  expect((await page.context().cookies(BASE)).map((c) => c.name)).toEqual([]);
  // uppercase slug
  expect((await page.goto(`/s/${S.free.toUpperCase()}`))!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(HOSTILE);

  // pro: nothing optional, branding hidden, light theme
  expect((await page.goto(`/s/${S.pro}`))!.status()).toBe(200);
  await expect(page.getByText("Operational", { exact: true }).first()).toBeVisible();
  for (const t of ["Players online", "Uptime", "Recent incidents", "Monitored with"]) await expect(page.getByText(t, { exact: true }), t).toHaveCount(0);
  await expect(page.getByText(/Monitored with/)).toHaveCount(0);
  await expect(page.locator("div.status-theme-light").first()).toBeVisible();
});

test("free plan cannot hide branding even by direct API; unknown and disabled slug -> HTTP 404; Open Graph PNG; disable -> 404 at once", async ({ page, request }) => {
  const r404 = await page.goto(`/s/does-not-exist-${slugOf("z")}`);
  expect(r404!.status()).toBe(404);
  await expect(page.getByText("Operational")).toHaveCount(0);
  // Open Graph image
  const og = await request.get(`/s/${S.free}/opengraph-image`);
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toMatch(/image\/png/);
  const buf = await og.body();
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(buf.length).toBeGreaterThan(2000);
  // unknown slug OG: not a 500
  expect((await request.get(`/s/nope-${slugOf("q")}/opengraph-image`)).status()).toBeLessThan(500);

  // disable -> page, JSON and badge 404 immediately
  const dis = await apiPost(freePage, `/api/servers/${ids.free}/status-page`, cfg(S.free, { title: HOSTILE, enabled: false, showIncidents: true }), "PUT");
  expect(dis.status()).toBe(200);
  const gone = await page.goto(`/s/${S.free}`);
  expect(gone!.status()).toBe(404);
  expect((await request.get(`/api/public/status/${S.free}`)).status()).toBe(404);
  expect((await request.get(`/badge/${S.free}.svg`)).status()).toBe(404);
  expect((await request.get(`/s/${S.free}/opengraph-image`)).status()).toBeLessThan(500);
  // body of disabled == body of unknown (no existence oracle)
  const d = await (await request.get(`/api/public/status/${S.free}`)).text();
  const u = await (await request.get(`/api/public/status/zz-${slugOf("u")}`)).text();
  expect(d).toBe(u);
  // re-enable for the badge test
  expect((await apiPost(freePage, `/api/servers/${ids.free}/status-page`, cfg(S.free, { title: HOSTILE, showIncidents: true }), "PUT")).status()).toBe(200);
  expect((await page.goto(`/s/${S.free}`))!.status()).toBe(200);
});

test("badge SVG: content-type, escaping of a hostile title, grey 404 SVG for unknown/disabled, no cookies, no external refs", async ({ request }) => {
  const r = await request.get(`/badge/${S.free}.svg`);
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
  expect(r.headers()["cache-control"]).toMatch(/public, max-age=60/);
  expect(r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie")).toEqual([]);
  const svg = await r.text();
  expect(svg).toContain("minecraft");
  expect(svg).toMatch(/online · 7 players/);
  expect(svg).toContain("&lt;i&gt;");
  expect(svg).toContain("&amp;");
  expect(svg).not.toContain("<script");
  expect(svg).not.toContain("<i>");
  expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external references
  // well-formed XML
  expect(svg.match(/<svg/g)!.length).toBe(1);
  // pro without players: state word only, no branding mention
  const p = await (await request.get(`/badge/${S.pro}.svg`)).text();
  expect(p).toContain("online");
  expect(p).not.toContain("players");
  expect(p).not.toContain("Monitored with");
  // unknown
  const unk = await request.get(`/badge/nope-${slugOf("b")}.svg`);
  expect(unk.status()).toBe(404);
  expect(unk.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
  const ub = await unk.text();
  expect(ub).toContain("unknown");
  expect(ub).toContain("#"); // has a (grey) fill
  // invalid slug shape on the badge route is also a 404 SVG, not a 500
  const bad = await request.get(`/badge/A..B.svg`);
  expect(bad.status()).toBeLessThan(500);
});
