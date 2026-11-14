import { expect, test } from "@playwright/test";
import { brand } from "../../packages/shared/src/brand";
import { expectNoHScroll, PAGES, watchErrors } from "./helpers";

test("landing: 9 sections in order, first form is the waitlist, footer disclaimer", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toContainText("Find out why your Minecraft server lags");

  // Order of the 9 sections by document position.
  const order = await page.evaluate(() => {
    const sel = ["h1", "#problem", "#how", "#example", "#features", "#compare", "#pricing-teaser", "#faq", "#cta-title"];
    return sel.map((s) => {
      const el = document.querySelector(s);
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    });
  });
  expect(order.every((y) => y !== null), `missing section: ${JSON.stringify(order)}`).toBe(true);
  expect([...order]).toEqual([...(order as number[])].sort((a, b) => a - b));

  // First form on the page is the hero waitlist form.
  const firstForm = page.locator("form").first();
  await expect(firstForm.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
  const inHero = await firstForm.evaluate((f) => !!f.closest("#hero-title")?.parentElement || !!document.querySelector("#waitlist")?.contains(f));
  expect(inHero).toBe(true);
  expect(await page.locator("form").count()).toBe(2);

  // Finding card
  await expect(page.locator("#example")).toContainText("Item entities are piling up in one chunk");
  await expect(page.locator("#example")).toContainText("2,340");

  // Comparison table
  const table = page.locator("#compare table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(4);

  // Footer disclaimer exact text
  await expect(page.locator("footer")).toContainText(brand.legalDisclaimer);

  await expectNoHScroll(page);
  expect(errors).toEqual([]);
});

test("landing: FAQ opens and closes by keyboard", async ({ page }) => {
  await page.goto("/");
  const first = page.locator("#faq details").first();
  const summary = first.locator("summary");
  await summary.focus();
  await expect(first).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(first).not.toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("open", "");
});

for (const p of PAGES) {
  test(`no horizontal scroll, no console/CSP errors: ${p}`, async ({ page }) => {
    const errors = watchErrors(page);
    const res = await page.goto(p);
    expect(res?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expectNoHScroll(page);
    expect(errors).toEqual([]);
  });
}

test("404 page returns 404 status, no horizontal scroll", async ({ page }) => {
  const res = await page.goto("/nope");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expectNoHScroll(page);
});
