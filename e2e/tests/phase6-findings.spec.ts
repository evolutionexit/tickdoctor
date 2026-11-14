import { expect, test } from "@playwright/test";
import { apiPost, contextFor, createServerApi, dropUser, seedUser, sql } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(60_000);

test("findings page: filters, mark fixed (incident 72 h / server 15 min) -> watching -> undo; confirmed_fixed immutable; tips only in Tips", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 Findings");
    const w = seedIncidentWorld(server.id);
    const ids = insertFindings(server.id, [
      { key: "crit", title: "Critical entity pile", severity: "critical", ruleId: "entity-explosion", incidentIds: [w.closedId] },
      { key: "high", title: "High memory pressure", severity: "high", ruleId: "gc-pressure", scope: "server" },
      { key: "med", title: "Medium plugin errors", severity: "medium", ruleId: "plugin-exceptions", incidentIds: [w.closedId] },
      { key: "mf", title: "Already marked fixed finding", severity: "low", ruleId: "swap-in-use", scope: "server", status: "marked_fixed" },
      { key: "cf", title: "Confirmed fixed finding", severity: "medium", ruleId: "view-distance-too-high", scope: "server", status: "confirmed_fixed" },
      { key: "tip", title: "Xms and Xmx differ tip", severity: "info", ruleId: "jvm-flags", scope: "server" },
    ]);
    await page.goto(`/app/servers/${server.id}/findings`);
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();

    const card = (t: string) => page.locator("li").filter({ hasText: t }).filter({ has: page.getByRole("button") }).first();
    // default = active: open + marked_fixed, no confirmed, tip only in the Tips section
    await expect(page.getByText("Critical entity pile").first()).toBeVisible();
    await expect(page.getByText("Already marked fixed finding").first()).toBeVisible();
    await expect(page.getByText("Confirmed fixed finding")).toHaveCount(0);
    const tipsSection = page.locator("section[aria-labelledby=tips-h]");
    await expect(tipsSection).toContainText("Xms and Xmx differ tip");
    const main = (await page.locator("main").innerText());
    const beforeTips = main.slice(0, main.indexOf("Tuning tips\n"));
    expect(beforeTips).not.toContain("Xms and Xmx differ tip");
    // impact order
    expect(beforeTips.indexOf("Critical entity pile")).toBeLessThan(beforeTips.indexOf("High memory pressure"));
    expect(beforeTips.indexOf("High memory pressure")).toBeLessThan(beforeTips.indexOf("Medium plugin errors"));

    // filters
    await page.getByLabel("Severity").selectOption("high");
    await expect(page.getByText("Medium plugin errors")).toHaveCount(0);
    await expect(page.getByText("High memory pressure").first()).toBeVisible();
    await expect(tipsSection).toContainText("Xms and Xmx differ tip"); // other filters ignored for tips
    await page.getByLabel("Severity").selectOption("");
    await page.getByLabel("Type").selectOption("plugin-exceptions");
    await expect(page.getByText("Critical entity pile")).toHaveCount(0);
    await expect(page.getByText("Medium plugin errors").first()).toBeVisible();
    await page.getByLabel("Type").selectOption("");
    await page.getByLabel("Status").selectOption("confirmed_fixed");
    await expect(page.getByText("Confirmed fixed finding").first()).toBeVisible();
    await expect(page.getByText("Critical entity pile")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark as fixed" })).toHaveCount(0); // confirmed: no actions
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await page.getByLabel("Status").selectOption("marked_fixed");
    await expect(page.getByText("Already marked fixed finding").first()).toBeVisible();
    await expect(page.getByText("Critical entity pile")).toHaveCount(0);
    await page.getByLabel("Status").selectOption("active");
    await page.getByLabel("Severity").selectOption("critical");
    await page.getByLabel("Type").selectOption("swap-in-use");
    await expect(page.getByText("No findings match these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Critical entity pile").first()).toBeVisible();

    // mark fixed: incident-scope -> 72 hours; cancel keeps it open
    const crit = card("Critical entity pile");
    await crit.getByRole("button", { name: "Mark as fixed" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("72 hours");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    expect(sql(`select status from findings where id='${ids.crit}'`)).toBe("open");
    await crit.getByRole("button", { name: "Mark as fixed" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Mark as fixed" }).click();
    await expect(dlg).toBeHidden();
    await expect(crit).toContainText("Marked fixed – watching");
    expect(sql(`select status, marked_fixed_at is not null from findings where id='${ids.crit}'`)).toBe("marked_fixed|t");
    await crit.getByRole("button", { name: "Undo" }).click();
    await expect(crit.getByRole("button", { name: "Mark as fixed" })).toBeVisible();
    await expect(crit).not.toContainText("Marked fixed – watching");
    expect(sql(`select status, marked_fixed_at is null from findings where id='${ids.crit}'`)).toBe("open|t");

    // server-scope -> 15 minutes
    const high = card("High memory pressure");
    await high.getByRole("button", { name: "Mark as fixed" }).click();
    await expect(page.getByRole("dialog")).toContainText("15 minutes");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // "seen in" incident link
    const medCard = card("Medium plugin errors");
    await expect(medCard).toContainText("Seen 1 time");
    await medCard.getByText("In 1 incident").click();
    await expect(medCard.getByRole("link", { name: /\w{3} \d+/ }).first()).toHaveAttribute("href", new RegExp(`/incidents/${w.closedId}`));

    // tips can be marked fixed too, from the tips section
    await tipsSection.getByRole("button", { name: "Mark as fixed" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark as fixed" }).click();
    await expect(tipsSection).toContainText("Marked fixed – watching");
    expect(sql(`select status from findings where id='${ids.tip}'`)).toBe("marked_fixed");

    // API: transitions
    const r1 = await apiPost(page, `/api/findings/${ids.cf}`, { status: "open" }, "PATCH");
    expect(r1.status()).toBe(409);
    const r2 = await apiPost(page, `/api/findings/${ids.cf}`, { status: "marked_fixed" }, "PATCH");
    expect(r2.status()).toBe(409);
    expect(sql(`select status from findings where id='${ids.cf}'`)).toBe("confirmed_fixed");
    const r3 = await apiPost(page, `/api/findings/${ids.med}`, { status: "open" }, "PATCH"); // undo from open
    expect(r3.status()).toBe(409);
    const r4 = await apiPost(page, `/api/findings/${ids.med}`, { status: "confirmed_fixed" }, "PATCH");
    expect(r4.status()).toBe(400);
    const r5 = await apiPost(page, `/api/findings/${ids.med}`, { status: "marked_fixed" }, "PATCH");
    expect(r5.status()).toBe(200);
    const r6 = await apiPost(page, `/api/findings/${ids.med}`, { status: "marked_fixed" }, "PATCH"); // again
    expect(r6.status()).toBe(409);

    // API: tips never in findings, only in tuningTips; incident endpoint never returns the tip
    const list = (await (await page.request.get(`/api/servers/${server.id}/findings?status=all`)).json()) as { findings: { id: string }[]; tuningTips: { id: string }[] };
    expect(list.findings.map((f) => f.id)).not.toContain(ids.tip);
    expect(list.tuningTips.map((f) => f.id)).toContain(ids.tip);
    const inc = (await (await page.request.get(`/api/incidents/${w.closedId}`)).json()) as { findings: { id: string }[] };
    expect(inc.findings.map((f) => f.id)).not.toContain(ids.tip);
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});

test("findings empty state and dashboard tuning tips section", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 Tips");
    seedIncidentWorld(server.id);
    insertFindings(server.id, [{ key: "tip", title: "Aikar flags missing tip", severity: "info", ruleId: "jvm-flags", scope: "server" }]);
    await page.goto(`/app/servers/${server.id}/findings`);
    await expect(page.getByText("Nothing needs attention")).toBeVisible();
    await expect(page.locator("section[aria-labelledby=tips-h]")).toContainText("Aikar flags missing tip");
    // dashboard: collapsed tips, not a lag cause / top finding
    await page.goto(`/app/servers/${server.id}`);
    await expect(page.getByText("Tuning tips (1)")).toBeVisible();
    await page.goto("/app");
    await expect(page.getByText("Aikar flags missing tip")).toHaveCount(0);
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});
