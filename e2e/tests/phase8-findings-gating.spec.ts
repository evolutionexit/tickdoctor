import { expect, test, type Page } from "@playwright/test";
import { contextFor, createServerApi, dropUser, seedUser } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";
import { expectNoHScroll } from "./helpers";

// F-04 teaser: Free sees title/severity/time; why, evidence, fix, what changed and chunk coordinates are locked and NOT in the
// API responses. Tuning tips stay full. With BETA_ALL_PRO (the default dev stack) a stored-free user is Pro-effective: all visible.
test.setTimeout(90_000);

/** Records every /api response body so the JSON can be checked for locked text. */
function captureApi(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/")) return;
    try {
      bodies.push(await res.text());
    } catch {
      /* redirects / aborted */
    }
  });
  return bodies;
}

// World names in the incident snapshot summary (names + counts, no coordinates) are not locked content; chunk coordinates, explanations, evidence and fixes are.
const LOCKED_TEXT = ["Explanation for Critical entity pile", "Fix for Critical entity pile", "Explanation for High memory pressure", "Lagger", "armor_stand"];

test("free plan: findings and incident show the locked panel, tips stay full, responses carry no locked text @free", async ({ browser }) => {
  const u = seedUser({ plan: "free" });
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const bodies = captureApi(page);
  try {
    const { server } = await createServerApi(page, "Gate SMP");
    const w = seedIncidentWorld(server.id);
    insertFindings(server.id, [
      { key: "crit", title: "Critical entity pile", severity: "critical", ruleId: "entity-explosion", incidentIds: [w.closedId] },
      { key: "high", title: "High memory pressure", severity: "high", ruleId: "gc-pressure", scope: "server", incidentIds: [w.closedId] },
      { key: "tip", title: "Xms and Xmx differ tip", severity: "info", ruleId: "jvm-flags", scope: "server" },
    ]);

    await page.goto(`/app/servers/${server.id}/findings`);
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
    await expect(page.getByText("Critical entity pile").first()).toBeVisible();
    await expect(page.getByText("High memory pressure").first()).toBeVisible();
    const panels = page.getByTestId("locked-panel");
    await expect(panels).toHaveCount(2);
    await expect(panels.first()).toContainText("Locked on the Free plan");
    await expect(panels.first()).toContainText("Upgrade to Pro to see why, the evidence and the fix.");
    await expect(panels.first().getByRole("link", { name: /Pro includes/ })).toHaveAttribute("href", "/pricing");
    await expect(page.getByText("Explanation for Critical entity pile")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy /tp command" })).toHaveCount(0);
    // tuning tip: fully visible (explanation + fix), not locked
    const tips = page.locator("section[aria-labelledby=tips-h]");
    await expect(tips).toContainText("Xms and Xmx differ tip");
    await expect(tips).toContainText("Explanation for Xms and Xmx differ tip");
    await expect(tips.getByTestId("locked-panel")).toHaveCount(0);

    // mark as fixed still works on Free
    const card = page.locator("li").filter({ hasText: "High memory pressure" }).filter({ has: page.getByRole("button") }).first();
    await card.getByRole("button", { name: "Mark as fixed" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark as fixed" }).click();
    await expect(card).toContainText("Marked fixed");

    // incident page
    await page.goto(`/app/servers/${server.id}/incidents/${w.closedId}`);
    await expect(page.getByRole("heading", { name: "What changed?" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Worst chunks" })).toBeVisible();
    await expect(page.getByTestId("locked-panel")).toHaveCount(4); // 2 findings + what changed + worst chunks
    await expect(page.getByText("Critical entity pile").first()).toBeVisible();
    await expect(page.getByText("Lagger")).toHaveCount(0);
    await expect(page.getByText("survival_creative")).toHaveCount(0);
    // the timeline stays but without plugin/config changes
    await expect(page.getByText("Lag started")).toBeVisible();

    const all = bodies.join("\n");
    expect(all.length).toBeGreaterThan(100);
    for (const t of LOCKED_TEXT) expect(all, `network responses must not contain "${t}"`).not.toContain(t);
    expect(all).not.toContain('"whatChanged"');
    expect(all).not.toContain('"worstChunks"');
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("beta (Pro-effective): a stored-free user sees the whole finding, what changed and chunk coordinates, nothing locked", async ({ browser }, info) => {
  const u = seedUser({ plan: "free" });
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const bodies = captureApi(page);
  try {
    const { server } = await createServerApi(page, "Beta SMP");
    const w = seedIncidentWorld(server.id);
    insertFindings(server.id, [{ key: "crit", title: "Critical entity pile", severity: "critical", ruleId: "entity-explosion", incidentIds: [w.closedId] }]);
    await page.goto(`/app/servers/${server.id}/incidents/${w.closedId}`);
    await expect(page.getByText("Explanation for Critical entity pile")).toBeVisible();
    await expect(page.getByText("Fix for Critical entity pile")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What changed?" })).toBeVisible();
    await expect(page.getByText("Lagger").first()).toBeVisible();
    await expect(page.getByText("survival_creative").first()).toBeVisible();
    await expect(page.getByTestId("locked-panel")).toHaveCount(0);
    if (info.project.name === "mobile") await expectNoHScroll(page);

    await page.goto(`/app/servers/${server.id}/findings`);
    await expect(page.getByText("Explanation for Critical entity pile")).toBeVisible();
    await expect(page.getByTestId("locked-panel")).toHaveCount(0);
    const all = bodies.join("\n");
    expect(all).toContain("Explanation for Critical entity pile");
    expect(all).not.toContain('"locked":true');
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});
