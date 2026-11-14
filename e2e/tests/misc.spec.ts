import { expect, test } from "@playwright/test";

test("legal pages show DRAFT banner", async ({ page }) => {
  for (const p of ["/legal/privacy", "/legal/terms", "/legal/mentions-legales"]) {
    await page.goto(p);
    await expect(page.getByText(/draft/i).first(), p).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
  }
});

test("theme toggle switches, persists, and no flash before hydration", async ({ page, request }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Switch between dark and light mode" });
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await toggle.click();
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(["light", "dark"]).toContain(theme1);
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after).not.toBe(before);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme1);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(after);

  // Initial HTML carries the init script (before any hydration) in <head>, before the body.
  const html = await (await request.get("/")).text();
  const headEnd = html.indexOf("</head>");
  const scriptIdx = html.indexOf('localStorage.getItem("theme")');
  expect(scriptIdx).toBeGreaterThan(-1);
  expect(scriptIdx).toBeLessThan(headEnd);
});

test("theme set before load is applied with JS-blocked hydration (no flash)", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  await ctx.addInitScript(() => localStorage.setItem("theme", "light"));
  const page = await ctx.newPage();
  // Observe the attribute at DOMContentLoaded, before React hydrates on load.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as any).__themeAtDCL = document.documentElement.dataset.theme;
    });
  });
  await page.goto("/");
  expect(await page.evaluate(() => (window as any).__themeAtDCL)).toBe("light");
  await ctx.close();
});

test("skip link works", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.locator('a[href="#main"]');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await expect(page.locator("#main")).toBeAttached();
});

test("mobile menu opens and closes with keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "mobile only");
  await page.goto("/");
  const btn = page.getByRole("button", { name: "Open menu" });
  await btn.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator("#mobile-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Space");
  await expect(menu).toBeHidden();
});

test("desktop nav is visible, hamburger hidden", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
});

for (const p of ["/", "/pricing"]) {
  test(`SEO ${p}`, async ({ page, request }) => {
    await page.goto(p);
    await expect(page).toHaveTitle(/\S/);
    const content = async (sel: string) => {
      const l = page.locator(sel).first();
      return (await l.count()) ? l.getAttribute("content") : null;
    };
    expect(await content('meta[name="description"]')).toBeTruthy();
    expect(await content('meta[property="og:title"]')).toBeTruthy();
    const og = await content('meta[property="og:image"]');
    expect(og).toBeTruthy();
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBeTruthy();
    const url = new URL(og!, "http://localhost:3000");
    const res = await request.get(url.pathname + url.search);
    expect(res.status(), `og:image ${og}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
}

test("robots.txt and sitemap.xml", async ({ request }) => {
  const r = await request.get("/robots.txt");
  expect(r.status()).toBe(200);
  expect(await r.text()).toMatch(/sitemap/i);
  const s = await request.get("/sitemap.xml");
  expect(s.status()).toBe(200);
  const t = await s.text();
  expect(t).toContain("<urlset");
  expect(t).toContain("/pricing");
});
