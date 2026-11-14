import { expect, test } from "@playwright/test";
import { contextFor, createServerApi, dropUser, seedUser } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(60_000);

test("incidents list, incident page, copy /tp, dashboard band link", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3000" });
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 Incidents");
    const w = seedIncidentWorld(server.id, { open: true });
    const f = insertFindings(server.id, [
      { key: "low-cause", title: "Low cause finding", severity: "low", incidentIds: [w.closedId] },
      { key: "crit-cause", title: "Critical cause finding", severity: "critical", incidentIds: [w.closedId] },
      { key: "med-cause", title: "Medium cause finding", severity: "medium", incidentIds: [w.closedId] },
      { key: "tip", title: "Xms and Xmx differ TIP", severity: "info", ruleId: "jvm-flags", scope: "server", incidentIds: [w.closedId] },
    ]);
    expect(f.tip).toBeTruthy();

    // ---- list
    await page.goto(`/app/servers/${server.id}/incidents`);
    await expect(page.getByRole("heading", { name: "Incidents", exact: true })).toBeVisible();
    const items = page.locator("li:has(a[href*=\"/incidents/\"])").filter({ has: page.locator("dl") });
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("Happening now"); // open first
    await expect(items.nth(1)).toContainText("Over");
    await expect(items.nth(1)).toContainText("Critical cause finding");
    for (const col of ["Lasted", "Slowest ticks", "Lowest TPS", "Findings"]) await expect(items.nth(1).getByText(col)).toBeVisible();
    await expect(items.nth(1)).toContainText("300 ms");
    await expect(items.nth(1)).toContainText("3"); // findings: tip not counted
    await page.getByRole("button", { name: "Over", exact: true }).click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Critical cause finding");
    await page.getByRole("button", { name: "Still happening" }).click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("so far");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(items).toHaveCount(2);

    // ---- incident page
    await items.nth(1).getByRole("link").click();
    await page.waitForURL(new RegExp(`/incidents/${w.closedId}`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Lag on");
    await expect(page.getByText("The server recovered at")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tick time (MSPT)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "TPS", exact: true })).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();

    // what changed
    const wc = page.getByRole("heading", { name: "What changed?" }).locator("xpath=ancestor::*[self::div or self::section][1]");
    await expect(wc.getByText("Notable").first()).toBeVisible();
    await expect(wc.getByRole("row", { name: /Essentials/ })).toContainText("Updated 2.20 → 2.21");
    await expect(wc.getByRole("row", { name: /Lagger/ })).toContainText("Installed");
    await expect(wc.getByRole("row", { name: /Lowest|TPS/ }).first()).toBeVisible();
    await wc.getByRole("button", { name: "Show everything" }).click();
    await expect(wc.getByRole("button", { name: "Only notable changes" })).toBeVisible();

    // findings ranked, tips excluded
    const found = page.locator("#findings-h").locator("xpath=..");
    const text = await found.innerText();
    expect(text.indexOf("Critical cause finding")).toBeGreaterThan(-1);
    expect(text.indexOf("Critical cause finding")).toBeLessThan(text.indexOf("Medium cause finding"));
    expect(text.indexOf("Medium cause finding")).toBeLessThan(text.indexOf("Low cause finding"));
    expect(text).not.toContain("Xms and Xmx differ TIP");
    await expect(page.getByText("Tuning tip", { exact: false })).toHaveCount(0);

    // worst chunks + copy /tp
    const chunks = page.getByRole("heading", { name: "Worst chunks" }).locator("xpath=..");
    await expect(chunks.getByRole("row")).toHaveCount(4); // header + 3
    const overworld = chunks.getByRole("row", { name: /world\s+3, -7/ });
    await expect(overworld).toContainText("1500");
    await overworld.getByRole("button", { name: "Copy /tp" }).click();
    await expect(overworld.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/execute in minecraft:overworld run tp @s 56 ~ -104");
    const custom = chunks.getByRole("row", { name: /survival_creative/ });
    await custom.getByRole("button", { name: "Copy /tp" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/tp @s 24 ~ 40");
    await expect(custom).toContainText('Go to the world "survival_creative" first');
    await expect(overworld).not.toContainText("Go to the world");

    // timeline incl crash
    const tl = page.getByRole("heading", { name: "Timeline" }).locator("xpath=..");
    const entries = await tl.locator("li").allInnerTexts();
    expect(entries.some((e) => /crash/i.test(e))).toBe(true);
    expect(entries.some((e) => /Essentials updated 2\.20/.test(e))).toBe(true);
    expect(entries.some((e) => /opened|Lag started|started/i.test(e))).toBe(true);
    expect(entries.some((e) => /Back to normal/.test(e))).toBe(true);

    // ---- dashboard band: list link + chart band click
    await page.goto(`/app/servers/${server.id}`);
    await page.locator('button[aria-pressed]:text-is("1h")').click();
    const link = page.getByRole("heading", { name: "Incidents in this range" }).locator("xpath=..").getByRole("link").nth(1);
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await page.waitForURL(/\/incidents\/[0-9a-f-]{36}/);
    expect(page.url()).toContain(w.closedId);
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});

test("dashboard chart: clicking the incident band opens the incident", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 Band");
    const w = seedIncidentWorld(server.id);
    await page.goto(`/app/servers/${server.id}`);
    await page.locator('button[aria-pressed]:text-is("1h")').click();
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    const box = (await canvas.boundingBox())!;
    // range is the last hour by default: the band sits from -40 to -30 min (of 60)
    const frac = (60 - 35) / 60;
    await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
    await page.waitForURL(new RegExp(`/incidents/${w.closedId}`), { timeout: 5000 });
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});
