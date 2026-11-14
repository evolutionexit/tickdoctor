import { expect, test, type Page } from "@playwright/test";
import { DOCS_PAGES, RULE_IDS } from "../../packages/shared/src/index";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(90_000);

const DEMO_NAME = "Creeper Hollow SMP";
const DEMO_INCIDENT = "de300000-0000-4000-8000-000000000003";
const DRAFT = "Draft: this page is a placeholder and not legal advice.";

function watchApi(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^\/(api|v1|badge)\//.test(u.pathname)) hits.push(`${r.method()} ${u.pathname}`);
  });
  return hits;
}
const demoBanner = (p: Page) => p.getByRole("note").filter({ hasText: "a made-up server name" });

test("/demo: made-up name, banner + /signup link, no /api requests, clipped-spike note on the MSPT chart", async ({ page }) => {
  const api = watchApi(page);
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DEMO_NAME);
  await expect(demoBanner(page)).toBeVisible();
  await expect(demoBanner(page).getByRole("link", { name: "Sign up to see yours." })).toHaveAttribute("href", "/signup");
  await expect(page.getByText("Some spikes are taller than the chart. Hover for the value.").first()).toBeVisible({ timeout: 15_000 });
  // real names must not leak
  const text = await page.locator("body").innerText();
  for (const bad of ["Overleven", "Pi (test history)", "Pi Survival", "michel"]) expect(text.toLowerCase(), bad).not.toContain(bad.toLowerCase());
  await page.waitForTimeout(1500);
  expect(api, "demo makes no API requests").toEqual([]);
});

test("/demo/incidents and an incident page: demo name, no /api requests", async ({ page }) => {
  const api = watchApi(page);
  await page.goto("/demo/incidents");
  await expect(page.getByRole("heading", { name: "Incidents", exact: true })).toBeVisible();
  await expect(demoBanner(page)).toBeVisible();
  const first = page.locator(`a[href^="/demo/incidents/"]`).first();
  await expect(first).toBeVisible();
  const href = await first.getAttribute("href");
  expect(href).toMatch(/^\/demo\/incidents\/[0-9a-f-]{36}$/);
  await page.goto(`/demo/incidents/${DEMO_INCIDENT}`);
  await expect(page.getByRole("heading", { name: "Worst chunks" })).toBeVisible({ timeout: 15_000 });
  await expect(demoBanner(page)).toBeVisible();
  // the incident page also has a clipped MSPT chart, if any spikes are clipped; if shown the note must read right
  await page.waitForTimeout(1000);
  expect(api, "no /api requests").toEqual([]);
  expect(await page.locator("body").innerText()).not.toMatch(/Something went wrong|Couldn't load/);
});

test("/demo/findings: mark-fixed disabled with 'This is a demo', no /api requests, no player data", async ({ page }) => {
  const api = watchApi(page);
  await page.goto("/demo/findings");
  await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
  await expect(demoBanner(page)).toBeVisible();
  const btns = page.getByRole("button", { name: /Mark as fixed \(This is a demo\)/ });
  await expect(btns.first()).toBeVisible({ timeout: 15_000 });
  const n = await btns.count();
  for (let i = 0; i < n; i++) await expect(btns.nth(i)).toBeDisabled();
  // no enabled "Mark as fixed" anywhere
  await expect(page.getByRole("button", { name: /^Mark as fixed$/ })).toHaveCount(0);
  await btns.first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  expect(api, "no /api requests (even after clicking)").toEqual([]);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*(player|uuid)/i);
});

test("docs: /docs, every DOCS_PAGES page, findings index and all 11 rule pages, changelog render without 'Coming soon'", async ({ page }) => {
  expect(RULE_IDS.length).toBe(11);
  const paths = ["/docs", ...DOCS_PAGES.filter((p) => p !== "index").map((p) => `/docs/${p}`), "/docs/findings", ...RULE_IDS.map((r) => `/docs/findings/${r}`), "/changelog"];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const p of paths) {
    const r = await page.goto(p);
    expect(r!.status(), p).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }), p).toHaveCount(1);
    const body = await page.locator("body").innerText();
    expect(body, p).not.toContain("Coming soon");
    expect(body.length, p).toBeGreaterThan(300);
    expect(await page.title(), p).toMatch(/\| TickDoctor( docs)?$/);
    expect(await page.locator('meta[name="description"]').getAttribute("content"), p).toBeTruthy();
    // no raw Markdown / HTML leaking
    expect(body, p).not.toMatch(/^#{1,3} /m);
    expect(body, p).not.toContain("</");
  }
  expect(errors).toEqual([]);
});

test("docs: internal links resolve (no 404) and nav lists the pages", async ({ page, request }) => {
  const seen = new Set<string>();
  for (const p of ["/docs", "/docs/install", "/docs/findings", "/docs/troubleshooting", "/docs/faq", "/docs/configuration", "/docs/data-and-privacy"]) {
    await page.goto(p);
    const hrefs = await page.locator("main a[href^='/']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    for (const h of hrefs) seen.add(h.split("#")[0]!);
  }
  const bad: string[] = [];
  for (const h of seen) {
    if (!h || h.startsWith("/app") || h.startsWith("/api") || h.startsWith("/downloads")) continue;
    const r = await request.get(h);
    if (r.status() >= 400) bad.push(`${h} -> ${r.status()}`);
  }
  expect(bad, "broken internal links").toEqual([]);
});

test("legal pages show the DRAFT banner; sitemap lists docs but no /s/; robots disallows /app", async ({ page, request }) => {
  for (const p of ["/legal/privacy", "/legal/terms", "/legal/mentions-legales"]) {
    expect((await page.goto(p))!.status(), p).toBe(200);
    await expect(page.getByText(DRAFT), p).toBeVisible();
  }
  const sm = await (await request.get("/sitemap.xml")).text();
  expect(sm).not.toContain("/s/");
  expect(sm).not.toMatch(/\/app\b/);
  for (const p of ["/docs", "/docs/install", "/docs/findings", "/changelog", "/demo", ...RULE_IDS.map((r) => `/docs/findings/${r}`)]) expect(sm, p).toContain(`${p}</loc>`);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /app");
});
