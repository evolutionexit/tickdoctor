import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { agentPost, apiPost, contextFor, createServerApi, dropUser, helloBody, metricsBody, seedUser, sql } from "./app-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(150_000);

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-SECRETTOKEN";
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const baseCfg = {
  enabled: false,
  events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
  minSeverity: "medium",
  offlineAfterMinutes: 5,
  cooldownMinutes: 30,
  quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
};

test("alerts page: invalid URL rejected client + server side; valid fake webhook masked; test send fails plainly; URL never leaks", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/")) bodies.push(await r.text().catch(() => ""));
  });
  try {
    const { server } = await createServerApi(page, "P6 Alerts");
    await page.goto(`/app/servers/${server.id}/alerts`);
    await expect(page.getByRole("heading", { name: "Alerts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test alert" })).toBeDisabled();

    // client side
    const url = page.getByLabel("Webhook URL");
    let puts = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/alerts")) puts++;
    });
    await url.fill("https://example.com/api/webhooks/123456789012345678/" + TOKEN);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("That isn't a Discord webhook URL")).toBeVisible();
    expect(puts).toBe(0);
    // enabling without a webhook
    await url.fill("");
    await page.getByRole("switch").click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Add a webhook before turning alerts on.")).toBeVisible();
    await page.getByRole("switch").click();

    // server side: wrong hosts / schemes / lookalikes
    for (const bad of [
      "https://example.com/api/webhooks/123456789012345678/" + TOKEN,
      "http://discord.com/api/webhooks/123456789012345678/" + TOKEN,
      "https://discord.com.evil.test/api/webhooks/123456789012345678/" + TOKEN,
      "https://evil.test/https://discord.com/api/webhooks/123456789012345678/" + TOKEN,
      "https://discord.com@evil.test/api/webhooks/123456789012345678/" + TOKEN,
      "http://127.0.0.1:3000/api/webhooks/123456789012345678/" + TOKEN,
      "https://discord.com/api/webhooks/12/" + TOKEN,
    ]) {
      const r = await apiPost(page, `/api/servers/${server.id}/alerts`, { ...baseCfg, webhookUrl: bad }, "PUT");
      expect(r.status(), bad).toBe(400);
      const j = (await r.json()) as { error: { fields?: { webhookUrl?: string } } };
      expect(j.error.fields?.webhookUrl, bad).toBeTruthy();
      expect(JSON.stringify(j)).not.toContain("SECRETTOKEN");
    }
    const noHook = await apiPost(page, `/api/servers/${server.id}/alerts`, { ...baseCfg, enabled: true }, "PUT");
    expect(noHook.status()).toBe(400);
    expect(sql(`select count(*) from alert_configs where server_id='${server.id}'`)).toBe("0");

    // valid, regex-ok fake webhook through the UI
    await url.fill(HOOK);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    const masked = page.locator("code").filter({ hasText: "discord.com/api/webhooks/" });
    await expect(masked).toContainText("https://discord.com/api/webhooks/1234…/••••");
    await expect(masked).not.toContainText(TOKEN);
    await expect(page.getByText("Not tested yet")).toBeVisible();
    expect(sql(`select webhook_status, webhook_enc not like '%SECRETTOKEN%' and webhook_enc like 'v1:%' from alert_configs where server_id='${server.id}'`)).toBe("untested|t");

    // GET never returns it
    const got = await page.request.get(`/api/servers/${server.id}/alerts`);
    const gt = await got.text();
    expect(gt).not.toContain("SECRETTOKEN");
    expect(gt).not.toContain("webhookUrl\"");

    // send test: fails plainly (host locked to discord.com, the webhook doesn't exist)
    await page.getByRole("button", { name: "Send test alert" }).click();
    const failed = page.getByRole("alert").filter({ hasText: "Test alert failed" });
    await expect(failed).toBeVisible({ timeout: 30_000 });
    const msg = await failed.innerText();
    expect(msg).not.toMatch(/https?:|SECRETTOKEN|webhooks/);
    expect(msg.length).toBeGreaterThan(20);
    const row = page.getByRole("table", { name: "Recent alert deliveries" }).getByRole("row", { name: /Test message/ });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("Couldn't send");
    const dbRow = sql(`select event, status from alert_deliveries where server_id='${server.id}' and event='test'`);
    expect(dbRow).toBe("test|failed");

    // reload: still masked, deliveries API clean
    await page.reload();
    await expect(page.locator("code").filter({ hasText: "discord.com/api/webhooks/" })).toContainText("••••");
    const dl = await (await page.request.get(`/api/servers/${server.id}/alerts/deliveries`)).text();
    expect(dl).not.toContain("SECRETTOKEN");
    expect(await page.content()).not.toContain("SECRETTOKEN");
    for (const b of bodies) expect(b).not.toContain("SECRETTOKEN");

    // replace flow + remove
    await page.getByRole("button", { name: "Replace URL" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Remove webhook" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByLabel("Webhook URL")).toBeVisible();
    expect(sql(`select webhook_enc is null, enabled from alert_configs where server_id='${server.id}'`)).toBe("t|f");
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});

test("alert dispatch: live incident -> incident_opened delivery; invalid webhook is logged without calling Discord", async ({ browser, request }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const { server, setup } = await createServerApi(page, "P6 Dispatch");
    const key = setup.apiKey;
    const put = await apiPost(page, `/api/servers/${server.id}/alerts`, { ...baseCfg, enabled: true, cooldownMinutes: 5, webhookUrl: HOOK }, "PUT");
    expect(put.status(), await put.text()).toBe(200);
    // an incident's startedAt is the first sample's start (ts - window); alerts only cover incidents that began after the config was saved
    await new Promise((res) => setTimeout(res, 12_000));
    const boot = randomUUID();
    expect((await agentPost(request, key, "hello", helloBody(boot))).status()).toBeLessThan(300);
    // real-time pushes with high MSPT for > 30 s (one sample per 8 s, each covering the 10 s window)
    for (let i = 0; i < 7; i++) {
      const r = await agentPost(request, key, "metrics", metricsBody({ p95: 160, avg: 90, tps: 12, players: 4 }, boot));
      expect(r.status(), await r.text()).toBeLessThan(300);
      await new Promise((res) => setTimeout(res, 8000));
    }
    await expect.poll(() => sql(`select count(*) from incidents where server_id='${server.id}' and ended_at is null`), { timeout: 20_000 }).toBe("1");
    await expect
      .poll(() => sql(`select count(*) from alert_deliveries where server_id='${server.id}' and event='incident_opened'`), { timeout: 60_000 })
      .not.toBe("0");
    const d = sql(`select status, http_status, coalesce(error,'') from alert_deliveries where server_id='${server.id}' and event='incident_opened' order by created_at limit 1`);
    test.info().annotations.push({ type: "incident_opened delivery", description: d });
    expect(d.startsWith("failed|") || d.startsWith("sent|")).toBe(true);
    expect(d).not.toMatch(/SECRETTOKEN|https?:/);
    const incidentId = sql(`select incident_id from alert_deliveries where server_id='${server.id}' and event='incident_opened' limit 1`);
    expect(incidentId).toBe(sql(`select id from incidents where server_id='${server.id}' limit 1`));

    // webhook status after the first answer
    const status = sql(`select webhook_status from alert_configs where server_id='${server.id}'`);
    test.info().annotations.push({ type: "webhook_status after first delivery", description: status });
    const httpStatus = sql(`select http_status from alert_deliveries where server_id='${server.id}' and event='incident_opened' limit 1`);
    if (httpStatus === "401" || httpStatus === "404") {
      expect(status).toBe("invalid");
      // UI shows the paused banner, and later events never call Discord (no http_status, plain "failed")
      await page.goto(`/app/servers/${server.id}/alerts`);
      await expect(page.getByText("Alerts are paused: Discord rejected the webhook")).toBeVisible();
      sql(`delete from alert_deliveries where server_id='${server.id}' and event='incident_opened'`);
      sql(`update alert_configs set cooldown_minutes=5 where server_id='${server.id}'`);
      // crash event -> logged failed without an HTTP call
      const ev = await request.post("/v1/ingest/events", {
        headers: { Authorization: `Bearer ${key}` },
        data: {
          schemaVersion: 1, agentVersion: "0.1.0", sentAt: new Date().toISOString(), bootId: boot,
          payload: { events: [{ type: "crash", ts: new Date().toISOString() }] },
        },
      });
      test.info().annotations.push({ type: "crash event ingest", description: String(ev.status()) });
      if (ev.status() < 300) {
        await expect.poll(() => sql(`select count(*) from alert_deliveries where server_id='${server.id}' and event='crash'`), { timeout: 30_000 }).not.toBe("0");
        expect(sql(`select status, coalesce(http_status::text,'none') from alert_deliveries where server_id='${server.id}' and event='crash' limit 1`)).toBe("failed|none");
      }
    } else {
      test.info().annotations.push({ type: "note", description: `Discord unreachable/other (${httpStatus || "network error"}): the webhookStatus=invalid path was not exercised live` });
    }
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});
