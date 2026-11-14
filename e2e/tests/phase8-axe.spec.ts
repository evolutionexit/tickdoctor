import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apiPost, contextFor, dropUser, pushData, seedUser, sql, uid } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";
import { cfg, serverWithStatus, slugOf } from "./phase7-helpers";

// Phase 8: automated WCAG 2.0/2.1 A + AA scan (axe-core). serious/critical fail the test; minor/moderate are printed as MINOR lines.
test.setTimeout(240_000);

const TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
type Theme = "dark" | "light";

async function scan(page: Page, path: string, theme: Theme, ready?: RegExp) {
  await page.goto(path);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await expect(page.locator("main, h1").first()).toBeVisible({ timeout: 15_000 });
  if (ready) await expect(page.getByText(ready).first()).toBeVisible({ timeout: 15_000 });
  await analyze(page, `${path} [${theme}]`);
}

/** Scans whatever is on screen now (open dialog, expanded menu, changed state) without navigating. */
async function analyze(page: Page, label: string) {
  await page.waitForTimeout(700);
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of res.violations.filter((x) => x.impact !== "serious" && x.impact !== "critical")) {
    console.log(`MINOR ${label} ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
  }
  const bad = res.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
  expect.soft(
    bad.map((v) => `${v.id} (${v.impact}): ${v.help} :: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} -- ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`),
    label,
  ).toEqual([]);
}

const PUBLIC: [string, RegExp?][] = [
  ["/"], ["/pricing"], ["/demo"], ["/docs"], ["/docs/install"], ["/docs/findings"], ["/docs/findings/gc-pressure"], ["/changelog"],
  ["/signup"], ["/login"], ["/forgot-password"], ["/legal/privacy"], ["/legal/terms"], ["/legal/mentions-legales"],
];

test("axe: public pages", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await ctx.newPage();
  try {
    for (const theme of ["dark", "light"] as Theme[]) for (const [p, r] of PUBLIC) await scan(page, p, theme, r);
  } finally { await ctx.close(); }
});

test("axe: public status page and signed-in app", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const slug = slugOf("ax");
  try {
    await scan(page, "/app/onboarding", "dark");
    const s = await serverWithStatus(page, "Axe Server", cfg(slug, { showIncidents: true }));
    await pushData(page.request, s.key, { players: 4 });
    const w = seedIncidentWorld(s.id);
    insertFindings(s.id, [
      { key: "crit", title: "Critical entity pile", severity: "critical", incidentIds: [w.closedId] },
      { key: "med", title: "Medium plugin errors", severity: "medium", incidentIds: [w.closedId] },
      { key: "tip", title: "Xms and Xmx differ TIP", severity: "info", ruleId: "jvm-flags", scope: "server", incidentIds: [w.closedId] },
    ]);
    const paths = [
      `/s/${slug}`, "/app", `/app/servers/${s.id}`, `/app/servers/${s.id}/incidents`, `/app/servers/${s.id}/incidents/${w.closedId}`,
      `/app/servers/${s.id}/findings`, `/app/servers/${s.id}/alerts`, `/app/servers/${s.id}/status-page`, `/app/servers/${s.id}/settings`, "/app/account",
    ];
    for (const theme of ["dark", "light"] as Theme[]) for (const p of paths) await scan(page, p, theme);
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

const setTheme = (page: Page, t: Theme) => page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t);
const HOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-SECRETTOKEN";
const ALERT_CFG = {
  enabled: true,
  events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
  minSeverity: "medium", offlineAfterMinutes: 5, cooldownMinutes: 30,
  quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" },
  webhookUrl: HOOK,
};

test("axe: public + signed-in menus, dialogs and open states", async ({ browser }, info) => {
  const u = seedUser({ plan: "pro" }); // room for the extra wizard servers
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const mobile = info.project.name === "mobile";
  try {
    // public mobile menu (expanded) -- only visible below md
    if (mobile) {
      const pub = await browser.newContext({ baseURL: "http://localhost:3000", ...info.project.use });
      const pp = await pub.newPage();
      for (const theme of ["dark", "light"] as Theme[]) {
        await pp.goto("/");
        await setTheme(pp, theme);
        await pp.getByRole("button", { name: "Open menu" }).click();
        await expect(pp.getByRole("navigation", { name: "Mobile" })).toBeVisible();
        await analyze(pp, `/ mobile menu open [${theme}]`);
      }
      await pub.close();
    }
    const s = await serverWithStatus(page, "Axe Dialogs", cfg(slugOf("axd")));
    for (const theme of ["dark", "light"] as Theme[]) {
      // app header nav (wraps into the mobile bar), server switcher focused, theme toggle used
      await page.goto("/app");
      await setTheme(page, theme);
      await expect(page.getByRole("navigation", { name: "App" })).toBeVisible();
      await page.getByRole("navigation", { name: "App" }).locator("select").first().focus().catch(() => undefined);
      await page.getByRole("button", { name: "Switch between dark and light mode" }).click();
      await setTheme(page, theme);
      await analyze(page, `/app nav + switcher focus [${theme}]`);

      // onboarding after create: key reveal panel
      await page.goto("/app/onboarding");
      await setTheme(page, theme);
      await page.getByLabel("Server name").fill(`Axe Wizard ${theme}`);
      await page.getByRole("button", { name: "Create server" }).click();
      await expect(page.getByText("Copy your API key now")).toBeVisible({ timeout: 15_000 });
      await analyze(page, `/app/onboarding key reveal [${theme}]`);
      sql(`delete from servers where owner_id='${u.id}' and name like 'Axe Wizard%'`); // stay under the plan's server limit

      // rotate dialog + rotated-key reveal
      await page.goto(`/app/servers/${s.id}/settings`);
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Make a new key…" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await analyze(page, `settings rotate dialog [${theme}]`);
      await page.getByRole("dialog").getByRole("button", { name: "Make a new key" }).click();
      await expect(page.getByText("New key created")).toBeVisible({ timeout: 15_000 });
      await analyze(page, `settings after rotate (new key shown) [${theme}]`);

      // delete-server confirmation with the name typed (button enabled; not clicked)
      await page.getByLabel(/Type .* to confirm/).fill("Axe Dialogs");
      await analyze(page, `settings delete-server armed [${theme}]`);
      await page.getByLabel(/Type .* to confirm/).fill("wrong");
      await page.getByRole("button", { name: "Delete server" }).click({ force: true }).catch(() => undefined);
      await analyze(page, `settings delete-server mismatch [${theme}]`);

      // account: export, delete dialog (empty, validation errors), never confirmed
      await page.goto("/app/account");
      await setTheme(page, theme);
      await expect(page.getByRole("heading", { name: "Delete my account" })).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Delete my account" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await analyze(page, `account delete dialog [${theme}]`);
      await page.getByRole("dialog").getByRole("button", { name: /^Delete/ }).click();
      await analyze(page, `account delete dialog with errors [${theme}]`);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Export my data" }).click();
      await analyze(page, `account after export click [${theme}]`);
    }
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("axe: owner variants (status page on/off, own /s page, alerts webhook, discord-linked)", async ({ browser }) => {
  const u = seedUser({ displayName: "Axe Owner" });
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const slug = slugOf("axo");
  try {
    const s = await serverWithStatus(page, "Axe Owner", cfg(slug, { showIncidents: true }));
    await pushData(page.request, s.key, { players: 3 });
    sql(`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord','${Date.now()}${uid()}','${u.id}')`);
    const put = await apiPost(page, `/api/servers/${s.id}/alerts`, ALERT_CFG, "PUT");
    expect(put.status(), await put.text()).toBe(200);
    for (const theme of ["dark", "light"] as Theme[]) {
      const re = await apiPost(page, `/api/servers/${s.id}/alerts`, ALERT_CFG, "PUT");
      expect(re.status()).toBe(200);
      // status settings: enabled
      await scan(page, `/app/servers/${s.id}/status-page`, theme, /Anyone with the link/);
      await page.getByRole("switch").first().click();
      await analyze(page, `status settings toggled off (unsaved) [${theme}]`);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved.").first()).toBeVisible({ timeout: 10_000 });
      await analyze(page, `status settings saved disabled [${theme}]`);
      // owner views own page while disabled, then re-enabled
      await page.goto(`/s/${slug}`);
      await setTheme(page, theme);
      await analyze(page, `/s/${slug} owner, page disabled [${theme}]`);
      await page.goto(`/app/servers/${s.id}/status-page`);
      await page.getByRole("switch").first().click();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved.").first()).toBeVisible({ timeout: 10_000 });
      await scan(page, `/s/${slug}`, theme);

      // alerts with masked webhook, test-delivery states
      await scan(page, `/app/servers/${s.id}/alerts`, theme, /discord\.com\/api\/webhooks/);
      await page.locator("details summary").first().click();
      await analyze(page, `alerts webhook masked, help open [${theme}]`);
      await page.getByRole("button", { name: "Send test alert" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Test alert failed" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("table", { name: "Recent alert deliveries" })).toBeVisible({ timeout: 10_000 });
      await analyze(page, `alerts after failed test + deliveries table [${theme}]`);
      await page.getByRole("button", { name: "Remove webhook" }).click();
      await analyze(page, `alerts webhook removal pending [${theme}]`);

      // account, discord-linked
      await scan(page, "/app/account", theme, /Linked\. You can use it/);
    }
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

// Self-check of the reporting path: a page with a known moderate violation must print a MINOR line and must not fail the test.
test("axe: reporting self-check (prints MINOR, only serious/critical fail)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.setContent('<!doctype html><html lang="en" xml:lang="fr"><head><title>probe</title></head><body><main><h1>probe</h1></main></body></html>');
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); orig(...a); };
    try { await analyze(page, "probe [dark]"); } finally { console.log = orig; }
    expect(lines.some((l) => l.startsWith("MINOR probe [dark] html-xml-lang-mismatch"))).toBe(true);
  } finally { await ctx.close(); }
});
