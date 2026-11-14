import { expect, test } from "@playwright/test";
import { contextFor, dropUser, seedUser, pushData } from "./app-helpers";
import { a11ySmoke, cfg, noHScroll, serverWithStatus, slugOf } from "./phase7-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project only (own viewport below)"));
test.setTimeout(120_000);

test("phone 390x844: /s/<slug>, /demo, /docs/install, status page settings have no horizontal scroll; accessibility smoke on each", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const slug = slugOf("m");
  try {
    const s = await serverWithStatus(page, "Phone", cfg(slug, { title: "A very long status page title that has to wrap here", showIncidents: true }));
    await pushData(page.request, s.key, { players: 4 });

    const pages: [string, string, RegExp | null][] = [
      ["/s/" + slug, "public status", /Operational/],
      ["/demo", "demo dashboard", /Creeper Hollow SMP/],
      ["/demo/findings", "demo findings", null],
      ["/docs/install", "docs install", /Install the plugin/],
      ["/docs", "docs index", null],
      [`/app/servers/${s.id}/status-page`, "status page settings", /Make the status page public/],
    ];
    for (const [path, label, expectText] of pages) {
      await page.goto(path);
      if (expectText) await expect(page.getByText(expectText).first(), label).toBeVisible({ timeout: 15_000 });
      await noHScroll(page, label);
      const problems = await a11ySmoke(page);
      expect.soft(problems, `${label}: a11y smoke`).toEqual([]);
    }
    // status page settings: toggles and buttons are reachable touch targets (>= 24px)
    await page.goto(`/app/servers/${s.id}/status-page`);
    await expect(page.getByRole("switch", { name: "Show uptime" })).toBeVisible();
    for (const sw of await page.getByRole("switch").all()) {
      const b = await sw.boundingBox();
      expect.soft(b!.height, "switch height").toBeGreaterThanOrEqual(24);
    }
    // public page is keyboard reachable: skip link first
    await page.goto(`/s/${slug}`);
    await page.keyboard.press("Tab");
    expect.soft(await page.getByRole("link", { name: "Skip to main content" }).count(), "BUG: duplicate skip links on /s/<slug> (root layout + page)").toBe(1);
    await expect(page.getByRole("link", { name: "Skip to main content" }).first()).toBeFocused();
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("desktop a11y smoke: public status page and settings (labels, one h1, lang, title)", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const slug = slugOf("a");
  try {
    const s = await serverWithStatus(page, "A11y", cfg(slug, { showIncidents: true }));
    await pushData(page.request, s.key);
    await page.goto(`/s/${slug}`);
    await expect(page.getByText("Operational").first()).toBeVisible();
    expect.soft(await a11ySmoke(page), "public page").toEqual([]);
    await page.goto(`/app/servers/${s.id}/status-page`);
    await expect(page.getByLabel("Address")).toBeVisible();
    expect.soft(await a11ySmoke(page), "settings").toEqual([]);
    // invalid slug error is announced and tied to the input
    await page.getByLabel("Address").fill("ab");
    const inp = page.getByLabel("Address");
    const desc = await inp.getAttribute("aria-describedby");
    expect.soft(desc, "slug input has aria-describedby").toBeTruthy();
    expect.soft(await inp.getAttribute("aria-invalid"), "aria-invalid").toBe("true");
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});
