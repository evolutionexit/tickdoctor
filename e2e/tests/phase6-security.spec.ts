import { expect, test } from "@playwright/test";
import { apiPost, contextFor, createServerApi, dropUser, seedUser, sql } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(60_000);

const HOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-OWNERSECRET";
const cfg = {
  enabled: false,
  events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
  minSeverity: "medium",
  offlineAfterMinutes: 5,
  cooldownMinutes: 30,
  quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
};

test("IDOR: user B gets 404 on A's incident, findings, alerts; A's data is untouched; anonymous gets 401", async ({ browser }) => {
  const a = seedUser();
  const b = seedUser();
  const ca = await contextFor(browser, a);
  const cb = await contextFor(browser, b);
  const pa = await ca.newPage();
  const pb = await cb.newPage();
  try {
    const { server } = await createServerApi(pa, "A's server");
    const w = seedIncidentWorld(server.id);
    const f = insertFindings(server.id, [{ key: "f1", title: "A's finding", severity: "high", incidentIds: [w.closedId] }]);
    const put = await apiPost(pa, `/api/servers/${server.id}/alerts`, { ...cfg, webhookUrl: HOOK }, "PUT");
    expect(put.status()).toBe(200);
    // sanity: A can read everything
    for (const p of [`/api/incidents/${w.closedId}`, `/api/findings/${f.f1}`, `/api/servers/${server.id}/alerts`, `/api/servers/${server.id}/alerts/deliveries`, `/api/servers/${server.id}/findings`, `/api/servers/${server.id}/incidents`])
      expect((await pa.request.get(p)).status(), p).toBe(200);

    const gets = [`/api/incidents/${w.closedId}`, `/api/findings/${f.f1}`, `/api/servers/${server.id}/alerts`, `/api/servers/${server.id}/alerts/deliveries`, `/api/servers/${server.id}/findings`, `/api/servers/${server.id}/incidents`, `/api/servers/${server.id}/incidents?status=open`];
    for (const p of gets) {
      const r = await pb.request.get(p);
      expect(r.status(), p).toBe(404);
      const t = await r.text();
      expect(t).not.toContain("A's");
      expect(t).not.toContain("OWNERSECRET");
    }
    const patch = await apiPost(pb, `/api/findings/${f.f1}`, { status: "marked_fixed" }, "PATCH");
    expect(patch.status()).toBe(404);
    expect(sql(`select status from findings where id='${f.f1}'`)).toBe("open");
    const putB = await apiPost(pb, `/api/servers/${server.id}/alerts`, { ...cfg, webhookUrl: "https://discord.com/api/webhooks/987654321098765432/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }, "PUT");
    expect(putB.status()).toBe(404);
    const putB2 = await apiPost(pb, `/api/servers/${server.id}/alerts`, { ...cfg, webhookUrl: null }, "PUT");
    expect(putB2.status()).toBe(404);
    expect(sql(`select webhook_masked from alert_configs where server_id='${server.id}'`)).toContain("1234");
    const test1 = await apiPost(pb, `/api/servers/${server.id}/alerts/test`, {});
    expect(test1.status()).toBe(404);
    expect(sql(`select count(*) from alert_deliveries where server_id='${server.id}'`)).toBe("0");
    // same shape of 404 as for a non-existent id (no existence oracle)
    const missing = await pb.request.get(`/api/incidents/00000000-0000-4000-8000-000000000000`);
    const real = await pb.request.get(`/api/incidents/${w.closedId}`);
    expect(missing.status()).toBe(real.status());
    expect(await missing.json()).toEqual(await real.json());

    // UI: B opens A's pages -> a not-found state, no leaked titles
    for (const path of [`/app/servers/${server.id}/incidents/${w.closedId}`, `/app/servers/${server.id}/incidents`, `/app/servers/${server.id}/findings`, `/app/servers/${server.id}/alerts`]) {
      await pb.goto(path);
      await pb.waitForTimeout(1500);
      const html = await pb.content();
      expect(html, path).not.toContain("A's finding");
      expect(html, path).not.toContain("OWNERSECRET");
      await expect(pb.getByText(/not found|doesn't exist|couldn't find|can't find/i).first(), path).toBeVisible();
    }

    // anonymous
    const anon = await browser.newContext({ baseURL: "http://localhost:3000" });
    for (const p of gets) expect((await anon.request.get(p)).status(), p).toBe(401);
    await anon.close();
  } finally {
    dropUser(a.email);
    dropUser(b.email);
    await ca.close();
    await cb.close();
  }
});
