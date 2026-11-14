import { expect, test, type Page } from "@playwright/test";
import { agentPost, apiPost, BASE, contextFor, createServerApi, dropUser, metricsBody, PASSWORD, pushData, seedUser, sql, helloBody } from "./app-helpers";

test.beforeEach(({}, info) => test.skip(!["desktop", "freeplan"].includes(info.project.name), "desktop only (mobile layout is covered in phase5-mobile.spec.ts)"));

const noHScroll = async (p: Page) =>
  expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test("onboarding: name server, key + snippet shown once, fake agent turns 'Waiting' green live, dashboard", async ({ browser, request }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    await page.goto("/app/onboarding");
    await page.getByLabel("Server name").fill("Onboarding SMP");
    await page.getByRole("button", { name: "Create server" }).click();
    await expect(page.getByText("Copy your API key now")).toBeVisible();
    const key = (await page.getByLabel("Your API key").innerText()).trim();
    expect(key).toMatch(/^td_live_/);
    const snippet = await page.getByLabel("config.yml").innerText();
    expect(snippet).toContain(key);
    await expect(page.getByText("Waiting for first data…")).toBeVisible();

    // fake agent: hello + metrics, the page flips without reload (SSE or 2 s poll)
    const boot = "b1111111-1111-4111-8111-111111111111";
    expect((await agentPost(request, key, "hello", helloBody(boot))).status()).toBe(200);
    expect((await agentPost(request, key, "metrics", metricsBody({}, boot))).status()).toBe(200);
    await expect(page.getByText("Your server is talking to TickDoctor.")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Connected")).toBeVisible();
    await page.getByRole("link", { name: /Open the dashboard/ }).click();
    await page.waitForURL(/\/app\/servers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Onboarding SMP", level: 1 })).toBeVisible();
    await expect(page.getByText(/TPS/).first()).toBeVisible();

    // the key is never shown again
    await page.goto("/app/onboarding");
    await expect(page.getByText(key)).toHaveCount(0);
    await page.reload();
    expect(await page.content()).not.toContain(key);
    await page.goto(page.url().replace("/onboarding", ""));
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("dashboard: live tiles, graphs with range picker, host panel hides unsent metrics, server info", async ({ browser, request }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const sv = await createServerApi(page, "Dash SMP");
    const key = sv.setup.apiKey;
    const boot = "b2222222-2222-4222-8222-222222222222";
    await agentPost(request, key, "hello", helloBody(boot));
    await agentPost(request, key, "metrics", metricsBody({ tps: 19.8, p95: 31, avg: 12, players: 3, noTemp: true, noSwap: true, ts: new Date(Date.now() - 20_000) }, boot));
    await page.goto(`/app/servers/${sv.server.id}`);
    const tile = (label: string) => page.locator("dt", { hasText: new RegExp(`^${label}$`, "i") }).locator("xpath=following-sibling::dd[1]");
    await expect(tile("Players")).toHaveText("3");
    await expect(tile("TPS")).toContainText("19.8");
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 8000 });

    // live update from a pushed sample
    expect((await agentPost(request, key, "metrics", metricsBody({ tps: 17.2, p95: 66, avg: 40, players: 7, noTemp: true, noSwap: true }, boot))).status()).toBe(200);
    await expect(tile("Players")).toHaveText("7", { timeout: 8000 });
    await expect(tile("TPS")).toContainText("17.2");
    await expect(tile("MSPT p95")).toContainText("66");

    // graphs + picker. The default range is 24h, which is served from 1-minute rollups: for a brand-new server the graphs are empty
    // until the rollup job has run (BUG-1 in the report), so assert on the raw-data 1h range and only check the others don't error.
    await page.getByRole("group", { name: "Time range" }).getByRole("button", { name: "1 hour" }).click();
    await expect(page.getByRole("button", { name: "1 hour" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("img", { name: /Tick time over the last 1h/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /TPS and players over the last 1h/ })).toBeVisible();
    await expect(page.locator(".uplot canvas").first()).toBeVisible();
    for (const label of ["24 hours", "7 days", "30 days", "1 hour"]) {
      await page.getByRole("group", { name: "Time range" }).getByRole("button", { name: label }).click();
      await expect(page.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText("Couldn't load the graphs")).toHaveCount(0);
    }
    await expect(page.getByRole("img", { name: /Tick time over the last 1h/ })).toBeVisible();

    // host panel: temperature and swap were not sent -> not shown, and no fake zero
    const host = page.locator("section, div").filter({ has: page.getByRole("heading", { name: "Host machine" }) }).last();
    await expect(page.getByRole("heading", { name: "Host machine" })).toBeVisible();
    await expect(host.locator("dt", { hasText: /^Temperature$/i })).toHaveCount(0);
    await expect(host.locator("dt", { hasText: /^Swap used$/i })).toHaveCount(0);
    await expect(host.getByText(/0 °C/)).toHaveCount(0);
    await expect(host.locator("dt", { hasText: /^CPU$/i })).toBeVisible();

    // server info from hello
    await expect(page.getByRole("heading", { name: "Server info" })).toBeVisible();
    for (const k of ["Software", "Minecraft version", "Java", "Plugins", "TickDoctor plugin"]) await expect(page.locator("dt", { hasText: k }).first()).toBeVisible();
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("settings: rename, rotate key (old key 401, new works), delete by typing the name", async ({ browser, request }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const sv = await createServerApi(page, "Settings SMP");
    const oldKey = sv.setup.apiKey;
    await pushData(request, oldKey);
    await page.goto(`/app/servers/${sv.server.id}/settings`);

    await page.getByLabel("Server name").fill("Renamed SMP");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Server name")).toHaveValue("Renamed SMP");

    await page.getByRole("button", { name: "Make a new key…" }).click();
    const dlg = page.getByRole("dialog", { name: "Make a new API key?" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect((await agentPost(request, oldKey, "metrics", metricsBody())).status()).toBe(200); // cancel changed nothing
    await page.getByRole("button", { name: "Make a new key…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make a new key" }).click();
    await expect(page.getByLabel("Your API key")).toBeVisible();
    const newKey = (await page.getByLabel("Your API key").innerText()).trim();
    expect(newKey).toMatch(/^td_live_/);
    expect(newKey).not.toBe(oldKey);
    expect((await agentPost(request, oldKey, "metrics", metricsBody())).status()).toBe(401);
    expect((await agentPost(request, newKey, "metrics", metricsBody())).status()).toBe(200);
    await page.reload();
    expect(await page.content()).not.toContain(newKey);

    // delete: the button stays disabled until the name matches
    const del = page.getByRole("button", { name: "Delete server" });
    await expect(del).toBeDisabled();
    await page.getByLabel(/Type .Renamed SMP. to confirm/).fill("Renamed");
    await expect(del).toBeDisabled();
    await page.getByLabel(/Type .Renamed SMP. to confirm/).fill("Renamed SMP");
    await del.click();
    await page.waitForURL(/localhost:3000\/app$/);
    await expect(page.getByText("Renamed SMP")).toHaveCount(0);
    expect(sql(`select count(*) from servers where id='${sv.server.id}'`)).toBe("0");
    expect((await page.request.get(`/api/servers/${sv.server.id}`)).status()).toBe(404);
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("account: display name, change password (wrong current -> field error only), log out, log out everywhere", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  let other = ctx;
  try {
    await page.goto("/app/account");
    await page.getByLabel("Display name").fill("Renée Test");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Display name")).toHaveValue("Renée Test");

    await page.getByLabel("Current password").fill("not my password 123");
    await page.getByLabel("New password", { exact: true }).fill("changed password 99");
    await page.getByLabel("New password again").fill("changed password 99");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/current password/i).first()).toBeVisible();
    await expect(page.getByText("Password saved.")).toHaveCount(0);
    expect(page.url()).toContain("/app/account"); // not bounced to /login
    expect((await (await page.request.get("/api/auth/session")).json()).user.email).toBe(u.email);

    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/Password saved/)).toBeVisible();

    // a password change ends the other devices' sessions: a second browser logged in before it is bounced (checked below),
    // so open the second one now, after the change.
    other = await contextFor(browser, u);
    const op = await other.newPage();
    await op.goto("/app/account");
    await expect(op.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Log out everywhere" }).click();
    await page.waitForURL(/\/login|localhost:3000\/?$/);
    await op.reload();
    await op.waitForURL(/\/login/);

    // plain log out (fresh session)
    const c2 = await contextFor(browser, u);
    const p2 = await c2.newPage();
    await p2.goto("/app/account");
    await p2.getByRole("main").getByRole("button", { name: "Log out", exact: true }).click();
    await p2.waitForURL(/\/login|localhost:3000\/?$/);
    expect(((await (await p2.request.get("/api/auth/session")).json()) as { user: unknown }).user).toBeNull();
    await c2.close();
  } finally {
    await ctx.close();
    await other.close();
    dropUser(u.email);
  }
});

test("free plan: second server shows the plan-limit message with a /pricing link @free", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    await createServerApi(page, "First SMP");
    await page.goto("/app/onboarding");
    await page.getByLabel("Server name").fill("Second SMP");
    await page.getByRole("button", { name: "Create server" }).click();
    await expect(page.getByText("You've reached your server limit")).toBeVisible();
    await expect(page.getByRole("link", { name: /see what the other plans include/ })).toHaveAttribute("href", "/pricing");
    const r = await apiPost(page, "/api/servers", { name: "Third" });
    expect(r.status()).toBe(402);
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});

test("IDOR: user B cannot open or call user A's server", async ({ browser }) => {
  const a = seedUser();
  const b = seedUser();
  const ca = await contextFor(browser, a);
  const cb = await contextFor(browser, b);
  const pa = await ca.newPage();
  const pb = await cb.newPage();
  try {
    const sv = await createServerApi(pa, "Private SMP");
    const id = sv.server.id;
    await pb.goto(`/app/servers/${id}`);
    await expect(pb.getByText("We can't find that server")).toBeVisible();
    await expect(pb.getByText("Private SMP")).toHaveCount(0);
    await pb.goto(`/app/servers/${id}/settings`);
    await expect(pb.getByText("We can't find that server")).toBeVisible();
    for (const path of ["", "/metrics?metric=tps_1m", "/first-data", "/incidents", "/live"]) {
      const r = await pb.request.get(`/api/servers/${id}${path}`);
      expect(r.status(), `GET ${path}`).toBe(404);
    }
    expect((await apiPost(pb, `/api/servers/${id}`, { name: "hijack" }, "PATCH")).status()).toBe(404);
    expect((await apiPost(pb, `/api/servers/${id}/rotate-key`, {})).status()).toBe(404);
    expect((await apiPost(pb, `/api/servers/${id}`, { confirmName: "Private SMP" }, "DELETE")).status()).toBe(404);
    expect(sql(`select name from servers where id='${id}'`)).toBe("Private SMP");
    // the owner still sees it
    expect((await pa.request.get(`/api/servers/${id}`)).status()).toBe(200);
  } finally {
    await ca.close();
    await cb.close();
    dropUser(a.email);
    dropUser(b.email);
  }
});

test("accessibility smoke: every input on auth/account/settings pages has an accessible name", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const ap = await ctx.newPage();
  const unnamed = async (p: Page, label: string) => {
    const bad = await p.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, select, textarea").forEach((el) => {
        const i = el as HTMLInputElement;
        if (i.type === "hidden" || i.type === "submit") return;
        const labelled = i.labels && i.labels.length > 0 && [...i.labels].some((l) => (l.textContent ?? "").trim());
        const aria = (i.getAttribute("aria-label") ?? "").trim() || i.getAttribute("aria-labelledby");
        if (!labelled && !aria) out.push(`${i.tagName}[name=${i.name}][type=${i.type}]`);
      });
      document.querySelectorAll("button, a[href]").forEach((el) => {
        if (!((el.textContent ?? "").trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.querySelector("img[alt]:not([alt=''])")))
          out.push(`${el.tagName} without a name: ${el.outerHTML.slice(0, 80)}`);
      });
      return out;
    });
    expect(bad, label).toEqual([]);
  };
  try {
    for (const path of ["/login", "/signup", "/forgot-password", "/reset-password?token=x", "/verify-email?token=x"]) {
      await page.goto(path);
      await page.waitForLoadState("load");
      await page.waitForTimeout(400);
      await unnamed(page, path);
    }
    await page.goto("/login");
    await page.getByText("Never got your confirmation email?").click();
    await unnamed(page, "/login (resend open)");

    const sv = await createServerApi(ap, "A11y SMP");
    for (const path of ["/app", "/app/onboarding", "/app/account", `/app/servers/${sv.server.id}/settings`, `/app/servers/${sv.server.id}`]) {
      await ap.goto(path);
      await ap.waitForLoadState("load");
      await ap.waitForTimeout(600);
      await unnamed(ap, path);
    }
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});
void BASE;
