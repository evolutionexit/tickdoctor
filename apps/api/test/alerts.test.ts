import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { alertConfig, alertDeliveriesResponse, alertTestResponse, createdServerResponse, type AlertConfig } from "@tickdoctor/shared";
import { decryptSecret, encryptSecret, parseSecretsKey } from "../src/alerts/crypto.js";
import { inQuietHours, localMinute } from "../src/alerts/config.js";
import { AlertDispatcher, attemptState } from "../src/alerts/dispatcher.js";
import { buildMessage, plain } from "../src/alerts/messages.js";
import { maskWebhook, sendWebhook } from "../src/alerts/webhook.js";
import { main } from "../src/cli.js";
import { events, findingIncidents, findings, incidents } from "../src/db/schema.js";
import { loadEnv } from "../src/env.js";
import { runRetention } from "../src/jobs/retention.js";
import { Client, ingest, makeHarness, metricsPayload, verifiedUser, type Harness } from "./app-helpers.js";
import { testDatabaseUrl } from "./db-url.js";
import { PEPPER, WEB_ORIGIN, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);

const MIN = 60_000;
const KEY_B64 = randomBytes(32).toString("base64");
const KEY = parseSecretsKey(KEY_B64);
const TOKEN = "SeCrEtToKeN_abcdefghijklmnopqrstuvwxyz-0123456789";
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const HOOK2 = `https://discord.com/api/webhooks/987654321098765432/${TOKEN}-second`;

type Reply = number | { status: number; body?: unknown; headers?: Record<string, string> } | "throw" | "timeout" | Promise<Response>;

/** Mock Discord: replies from a queue (default 204), records every call. */
class MockDiscord {
  calls: { url: string; body: Record<string, unknown> }[] = [];
  queue: Reply[] = [];
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const r = this.queue.shift() ?? 204;
    if (r === "throw") throw new TypeError(`fetch failed for ${url}`);
    if (r === "timeout") throw Object.assign(new Error(`The operation was aborted due to timeout (${url})`), { name: "TimeoutError" });
    if (r instanceof Promise) return r;
    const o = typeof r === "number" ? { status: r } : r;
    return new Response(o.status === 204 ? null : JSON.stringify(o.body ?? {}), { status: o.status, headers: { "content-type": "application/json", ...o.headers } });
  };
  last() {
    return this.calls[this.calls.length - 1]?.body as { embeds: { title: string; description: string; url: string; color: number }[]; allowed_mentions: unknown };
  }
}

interface AlertHarness extends Harness {
  discord: MockDiscord;
  alerts: AlertDispatcher;
  clock: { now: number };
  sleeps: number[];
  logs: string[];
}

function alertHarness(opts: { secrets?: boolean; startMs?: number } = {}): AlertHarness {
  const clock = { now: opts.startMs ?? Date.now() };
  const discord = new MockDiscord();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const alerts = new AlertDispatcher({
    db: handle.db,
    now: () => clock.now,
    webOrigin: WEB_ORIGIN,
    secretsKey: opts.secrets === false ? undefined : KEY,
    fetch: discord.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (l) => logs.push(l),
  });
  const h = makeHarness({
    env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, ...(opts.secrets === false ? {} : { SECRETS_KEY: KEY_B64 }) },
    alerts,
    now: () => clock.now,
    log: (l) => logs.push(l),
  });
  return { ...h, clock, discord, alerts, sleeps, logs };
}

const baseConfig = (over: Partial<AlertConfig> & { webhookUrl?: string | null } = {}) => ({
  enabled: true,
  events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
  minSeverity: "medium",
  offlineAfterMinutes: 5,
  cooldownMinutes: 30,
  quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
  ...over,
});

async function setup(h: AlertHarness, config: Record<string, unknown> = { webhookUrl: HOOK }, name = "Pi Survival") {
  const user = await verifiedUser(h);
  const res = await user.client.post("/api/servers", { name });
  const { server, setup: s } = createdServerResponse.parse(await res.json());
  const put = await user.client.req("PUT", `/api/servers/${server.id}/alerts`, baseConfig(config as Partial<AlertConfig>));
  expect(put.status).toBe(200);
  return { ...user, serverId: server.id, apiKey: s.apiKey };
}

/** An open incident that started just now on the harness clock (after the alert config was saved). */
async function openIncident(h: AlertHarness, serverId: string, severity: "medium" | "high" | "critical" = "high", over: Partial<typeof incidents.$inferInsert> = {}) {
  const [i] = await handle.db
    .insert(incidents)
    .values({ serverId, startedAt: new Date(h.clock.now + 1), severity, initialSeverity: severity, peakMsptP95: 180, minTps1m: 12.4, trigger: "mspt", source: "raw", ...over })
    .returning({ id: incidents.id });
  return i!.id;
}

async function deliveries(serverId: string) {
  return (await handle.db.execute(sql`select event, status, http_status, error, incident_id from alert_deliveries where server_id = ${serverId} order by created_at, id`)) as unknown as {
    event: string; status: string; http_status: number | null; error: string | null; incident_id: string | null;
  }[];
}

const check = async (h: AlertHarness, serverId: string) => {
  await h.alerts.kick(serverId);
  await h.alerts.idle();
};

// ---------------------------------------------------------------------------------------------------------

describe("secrets: AES-256-GCM + SECRETS_KEY", () => {
  it("round trip; random IV; wrong key and tampering fail without echoing anything", () => {
    const a = encryptSecret(KEY, HOOK);
    const b = encryptSecret(KEY, HOOK);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain(TOKEN);
    expect(decryptSecret(KEY, a)).toBe(HOOK);
    const other = randomBytes(32);
    expect(() => decryptSecret(other, a)).toThrow(/wrong SECRETS_KEY/);
    try {
      decryptSecret(other, a);
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN);
    }
    const buf = Buffer.from(a.slice(3), "base64");
    buf.writeUInt8(buf.readUInt8(buf.length - 1) ^ 1, buf.length - 1);
    expect(() => decryptSecret(KEY, `v1:${buf.toString("base64")}`)).toThrow();
    expect(() => decryptSecret(KEY, "plain")).toThrow();
  });

  it("parseSecretsKey / env: 32 bytes base64 only", () => {
    expect(() => parseSecretsKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseSecretsKey("not base64 at all!!")).toThrow();
    const base = { DATABASE_URL: "postgres://u:p@h:5432/d", WEB_PUBLIC_URL: "http://localhost:3000", API_KEY_PEPPER: "p".repeat(16) };
    expect(loadEnv({ ...base, SECRETS_KEY: KEY_B64 }).SECRETS_KEY).toBe(KEY_B64);
    expect(loadEnv({ ...base, SECRETS_KEY: "" }).SECRETS_KEY).toBeUndefined();
    expect(() => loadEnv({ ...base, SECRETS_KEY: "short" })).toThrow(/SECRETS_KEY/);
  });

  it("mask shows the host + id prefix only", () => {
    expect(maskWebhook(HOOK)).toBe("https://discord.com/api/webhooks/1234…/••••");
  });
});

describe("quiet hours (IANA time zones)", () => {
  const at = (iso: string) => Date.parse(iso);
  const q = (start: string, end: string, timeZone: string, enabled = true) => ({ enabled, start, end, timeZone });
  it("same-day window, midnight span, time zones, disabled, start == end", () => {
    expect(inQuietHours(at("2026-11-10T13:00:00Z"), q("12:00", "14:00", "UTC"))).toBe(true);
    expect(inQuietHours(at("2026-11-10T14:00:00Z"), q("12:00", "14:00", "UTC"))).toBe(false); // end exclusive
    // 22:00–08:00 Zurich (UTC+1 in November): 23:30 local = 22:30Z, 07:59 local = 06:59Z, 08:00 local = 07:00Z
    const z = q("22:00", "08:00", "Europe/Zurich");
    expect(localMinute(at("2026-11-10T22:30:00Z"), "Europe/Zurich")).toBe(23 * 60 + 30);
    expect(inQuietHours(at("2026-11-10T22:30:00Z"), z)).toBe(true);
    expect(inQuietHours(at("2026-11-11T06:59:00Z"), z)).toBe(true);
    expect(inQuietHours(at("2026-11-11T07:00:00Z"), z)).toBe(false);
    expect(inQuietHours(at("2026-11-10T20:59:00Z"), z)).toBe(false);
    expect(inQuietHours(at("2026-11-10T21:00:00Z"), z)).toBe(true); // 22:00 local
    // Same instant, other zone: 22:30Z is 17:30 in New York.
    expect(inQuietHours(at("2026-11-10T22:30:00Z"), q("22:00", "08:00", "America/New_York"))).toBe(false);
    expect(inQuietHours(at("2026-11-10T22:30:00Z"), { ...z, enabled: false })).toBe(false);
    expect(inQuietHours(at("2026-11-10T22:30:00Z"), q("10:00", "10:00", "UTC"))).toBe(false);
  });
});

describe("webhook delivery (mock Discord)", () => {
  it("retries 5xx / 429 at most twice, honours retry_after (capped at 30 s); mentions disabled", async () => {
    const d = new MockDiscord();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    d.queue = [500, { status: 429, body: { retry_after: 45.5 } }, 204];
    const body = buildMessage({ event: "test", serverName: "@everyone <@123>", link: `${WEB_ORIGIN}/app/servers/x` });
    const r = await sendWebhook(HOOK, body, { fetch: d.fetch, sleep });
    expect(r).toEqual({ ok: true, httpStatus: 204, error: null, invalid: false });
    expect(d.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 30_000]);
    expect(d.calls[0]!.url).toBe(`${HOOK}?wait=true`);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(d.calls[0]!.body)).not.toMatch(/@everyone/); // escaped with a zero-width space

    d.calls = [];
    sleeps.length = 0;
    d.queue = [503, 502, 500, 204];
    const r2 = await sendWebhook(HOOK, body, { fetch: d.fetch, sleep });
    expect(r2).toMatchObject({ ok: false, httpStatus: 500, invalid: false });
    expect(d.calls).toHaveLength(3);
    d.queue = [{ status: 429, body: {}, headers: { "retry-after": "2" } }, 204];
    sleeps.length = 0;
    expect((await sendWebhook(HOOK, body, { fetch: d.fetch, sleep })).ok).toBe(true);
    expect(sleeps).toEqual([2000]);
  });

  it("401/404 → invalid without retry; 400 not retried; network errors and timeouts in plain words without the URL", async () => {
    const d = new MockDiscord();
    for (const s of [401, 404]) {
      d.calls = [];
      d.queue = [s];
      const r = await sendWebhook(HOOK, {}, { fetch: d.fetch, sleep: async () => {} });
      expect(r).toMatchObject({ ok: false, httpStatus: s, invalid: true });
      expect(r.error).toContain("doesn't exist any more");
      expect(d.calls).toHaveLength(1);
    }
    d.queue = [400];
    expect(await sendWebhook(HOOK, {}, { fetch: d.fetch })).toMatchObject({ ok: false, httpStatus: 400, invalid: false });
    d.calls = [];
    d.queue = ["throw", "throw"];
    const n = await sendWebhook(HOOK, {}, { fetch: d.fetch, sleep: async () => {} });
    expect(n).toMatchObject({ ok: false, httpStatus: null, error: "Couldn't reach Discord." });
    expect(d.calls).toHaveLength(2); // a network error is retried once
    d.queue = ["throw", 204];
    expect((await sendWebhook(HOOK, {}, { fetch: d.fetch, sleep: async () => {} })).ok).toBe(true);
    d.calls = [];
    d.queue = ["timeout"];
    expect((await sendWebhook(HOOK, {}, { fetch: d.fetch })).error).toBe("Discord didn't answer within 5 seconds.");
    expect(d.calls).toHaveLength(1); // a timeout is not retried
  });

  it("SSRF: never fetches a non-Discord URL", async () => {
    const d = new MockDiscord();
    for (const u of ["http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://evil.example/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://discord.com.evil.example/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://169.254.169.254/latest"]) {
      expect((await sendWebhook(u, {}, { fetch: d.fetch })).ok).toBe(false);
    }
    expect(d.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("alerts API: GET / PUT / test / deliveries", () => {
  const h = alertHarness();

  it("defaults; PUT validates the URL (Discord only), time zone, enabled without webhook; masked URL; keep / remove", async () => {
    const user = await verifiedUser(h);
    const { server } = createdServerResponse.parse(await (await user.client.post("/api/servers", { name: "Box" })).json());
    const url = `/api/servers/${server.id}/alerts`;
    const def = alertConfig.parse(await (await user.client.get(url)).json());
    expect(def).toMatchObject({ enabled: false, webhookUrlMasked: null, webhookStatus: "none", minSeverity: "medium", offlineAfterMinutes: 5, cooldownMinutes: 30 });
    expect(def.events).toEqual({ incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true });

    for (const bad of [
      "http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com.evil.example/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
      "https://evil.example/?u=https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com/api/webhooks/123/short",
      "https://127.0.0.1/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
    ]) {
      const r = await user.client.req("PUT", url, baseConfig({ webhookUrl: bad }));
      expect(r.status).toBe(400);
      expect((await r.json()).error.fields.webhookUrl).toBeTruthy();
    }
    const noHook = await user.client.req("PUT", url, baseConfig({ enabled: true }));
    expect(noHook.status).toBe(400);
    expect((await noHook.json()).error.fields.webhookUrl).toBeTruthy();
    const tz = await user.client.req("PUT", url, baseConfig({ webhookUrl: HOOK, quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "Mars/Olympus" } }));
    expect((await tz.json()).error.fields.quietHours).toBeTruthy();
    const badRange = await user.client.req("PUT", url, { ...baseConfig({ webhookUrl: HOOK }), cooldownMinutes: 2 });
    expect(badRange.status).toBe(400);

    const ok = await user.client.req("PUT", url, baseConfig({ webhookUrl: `  ${HOOK}  `, minSeverity: "high" }));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(TOKEN);
    expect(alertConfig.parse(JSON.parse(text))).toMatchObject({ enabled: true, webhookUrlMasked: "https://discord.com/api/webhooks/1234…/••••", webhookStatus: "untested", minSeverity: "high" });
    const [row] = (await handle.db.execute(sql`select * from alert_configs where server_id = ${server.id}`)) as unknown as Record<string, unknown>[];
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(decryptSecret(KEY, String(row!.webhook_enc), server.id)).toBe(HOOK);
    expect(() => decryptSecret(KEY, String(row!.webhook_enc), "another-server")).toThrow(); // bound to this server

    // Omitted = keep; null = remove (needs enabled false).
    const keep = alertConfig.parse(await (await user.client.req("PUT", url, baseConfig({ cooldownMinutes: 60 }))).json());
    expect(keep).toMatchObject({ webhookUrlMasked: "https://discord.com/api/webhooks/1234…/••••", cooldownMinutes: 60, webhookStatus: "untested" });
    expect((await user.client.req("PUT", url, baseConfig({ webhookUrl: null }))).status).toBe(400); // enabled without webhook
    const removed = alertConfig.parse(await (await user.client.req("PUT", url, baseConfig({ enabled: false, webhookUrl: null }))).json());
    expect(removed).toMatchObject({ enabled: false, webhookUrlMasked: null, webhookStatus: "none" });
  });

  it("test: needs a webhook; 200 + status ok; Discord 404 → 502 + invalid; logged as 'test'; 5 per 10 min", async () => {
    const user = await verifiedUser(h);
    const { server } = createdServerResponse.parse(await (await user.client.post("/api/servers", { name: "Tester" })).json());
    const base = `/api/servers/${server.id}/alerts`;
    const none = await user.client.post(`${base}/test`, {});
    expect(none.status).toBe(400);
    expect((await none.json()).error.fields.webhookUrl).toBeTruthy();

    await user.client.req("PUT", base, baseConfig({ enabled: false, webhookUrl: HOOK }));
    h.discord.queue = [204];
    const ok = await user.client.post(`${base}/test`, {});
    expect(ok.status).toBe(200);
    expect(alertTestResponse.parse(await ok.json())).toEqual({ ok: true, httpStatus: 204 });
    const msg = h.discord.last();
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.embeds[0]!.title).toBe("TickDoctor test message");
    expect(msg.embeds[0]!.description).toContain("This channel is connected to Tester.");
    expect(alertConfig.parse(await (await user.client.get(base)).json()).webhookStatus).toBe("ok");

    h.clock.now += 1000;
    h.discord.queue = [404];
    const gone = await user.client.post(`${base}/test`, {});
    expect(gone.status).toBe(502);
    const gb = await gone.text();
    expect(JSON.parse(gb).error).toMatchObject({ code: "webhook_failed", message: "Discord says this webhook doesn't exist any more. Paste a new webhook URL." });
    expect(gb).not.toContain(TOKEN);
    expect(alertConfig.parse(await (await user.client.get(base)).json()).webhookStatus).toBe("invalid");

    const dl = alertDeliveriesResponse.parse(await (await user.client.get(`${base}/deliveries`)).json());
    expect(dl.deliveries.map((x) => [x.event, x.status, x.httpStatus])).toEqual([["test", "failed", 404], ["test", "sent", 204]]);
    expect(JSON.stringify(dl)).not.toContain(TOKEN);
    expect(alertDeliveriesResponse.parse(await (await user.client.get(`${base}/deliveries?limit=1`)).json()).deliveries).toHaveLength(1);
    expect((await user.client.get(`${base}/deliveries?limit=101`)).status).toBe(400);

    // 3 used (the refused one without a webhook counts too); 2 more allowed, then 429.
    for (let i = 0; i < 2; i++) expect((await user.client.post(`${base}/test`, {})).status).not.toBe(429);
    const limited = await user.client.post(`${base}/test`, {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("without SECRETS_KEY a webhook can't be saved (503); settings without one still can", async () => {
    const n = alertHarness({ secrets: false });
    const user = await verifiedUser(n);
    const { server } = createdServerResponse.parse(await (await user.client.post("/api/servers", { name: "NoKey" })).json());
    const r = await user.client.req("PUT", `/api/servers/${server.id}/alerts`, baseConfig({ webhookUrl: HOOK }));
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("provider_not_configured");
    expect((await user.client.req("PUT", `/api/servers/${server.id}/alerts`, baseConfig({ enabled: false }))).status).toBe(200);
  });

  it("IDOR: another user's alerts → 404 on every route; CSRF needed for PUT and test; anonymous 401", async () => {
    const a = await setup(h);
    const b = await verifiedUser(h);
    const base = `/api/servers/${a.serverId}/alerts`;
    expect((await b.client.get(base)).status).toBe(404);
    expect((await b.client.req("PUT", base, baseConfig({ webhookUrl: HOOK2 }))).status).toBe(404);
    expect((await b.client.post(`${base}/test`, {})).status).toBe(404);
    expect((await b.client.get(`${base}/deliveries`)).status).toBe(404);
    expect((await a.client.req("PUT", base, baseConfig({ webhookUrl: HOOK2 }), { csrf: false })).status).toBe(403);
    expect((await a.client.req("POST", `${base}/test`, {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await (await new Client(h.app).init()).get(base)).status).toBe(401);
    const cfg = alertConfig.parse(await (await a.client.get(base)).json());
    expect(cfg.webhookUrlMasked).toBe("https://discord.com/api/webhooks/1234…/••••"); // unchanged
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("alert dispatcher", () => {
  it("Free server (findings gated): the alert carries title + severity only, never explanation, evidence, fix or chunk coordinates", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h); // a free server (beta off in tests)
    const id = await openIncident(h, serverId, "high");
    const [f] = await handle.db
      .insert(findings)
      .values({
        serverId, ruleId: "entity-explosion", scope: "incident", dedupKey: "world:item", severity: "high", title: "Too many item entities",
        explanation: "LOCKED-EXPLANATION", evidence: { numbers: [{ label: "LOCKED-EVIDENCE", value: 1 }], chunks: [{ world: "world", x: 777, z: 888 }] },
        suggestedFix: "LOCKED-FIX", firstSeenAt: new Date(), lastSeenAt: new Date(),
      })
      .returning({ id: findings.id });
    await handle.db.insert(findingIncidents).values({ findingId: f!.id, incidentId: id });
    await check(h, serverId);
    const body = JSON.stringify(h.discord.last());
    expect(body).toContain("Too many item entities");
    expect(body).toContain("high");
    expect(body).not.toMatch(/LOCKED-|777|888/);
  });

  it("incident_opened: once, with severity, numbers, up to 2 non-tip findings (never tips) and the incident link", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    const id = await openIncident(h, serverId, "high");
    const ins = await handle.db
      .insert(findings)
      .values(
        [["info", "Tip: Xms and Xmx differ"], ["medium", "Medium cause"], ["critical", "Critical cause"], ["high", "High cause"]].map(([severity, title], k) => ({
          serverId, ruleId: "entity-explosion", scope: "incident", dedupKey: `k${k}`, severity: severity!, title: title!, explanation: "e",
          evidence: { numbers: [] }, suggestedFix: "f", firstSeenAt: new Date(), lastSeenAt: new Date(),
        })),
      )
      .returning({ id: findings.id });
    await handle.db.insert(findingIncidents).values(ins.map((f) => ({ findingId: f.id, incidentId: id })));
    await check(h, serverId);
    await check(h, serverId);
    expect(h.discord.calls).toHaveLength(1);
    const e = h.discord.last().embeds[0]!;
    expect(e.title).toBe("Pi Survival is lagging (high)");
    expect(e.url).toBe(`${WEB_ORIGIN}/app/servers/${serverId}/incidents/${id}`);
    expect(e.description).toContain("Slowest ticks reached 180 ms and TPS dropped to 12.4.");
    expect(e.description).toContain("Likely cause: Critical cause; High cause");
    expect(e.description).not.toContain("Tip");
    expect(e.description).toContain(`[Open in TickDoctor](${WEB_ORIGIN}/app/servers/${serverId}/incidents/${id})`);
    expect(h.discord.last().allowed_mentions).toEqual({ parse: [] });
    expect(await deliveries(serverId)).toEqual([{ event: "incident_opened", status: "sent", http_status: 204, error: null, incident_id: id }]);
  });

  it("minSeverity: below → nothing; a later rise → 'got worse' (once); resolved after a sent opener", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h, { webhookUrl: HOOK, minSeverity: "high" });
    const id = await openIncident(h, serverId, "medium");
    await check(h, serverId);
    expect(await deliveries(serverId)).toEqual([]);
    await handle.db.execute(sql`update incidents set severity = 'critical', peak_mspt_p95 = 320 where id = ${id}`);
    await check(h, serverId);
    expect(h.discord.last().embeds[0]!.title).toBe("Pi Survival got worse (critical)");
    expect(h.discord.last().embeds[0]!.description).toContain("The lag that started earlier is now critical. Slowest ticks: 320 ms, lowest TPS 12.4.");
    h.clock.now += 1000;
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now(), started_at = now() - interval '12 minutes' where id = ${id}`);
    await check(h, serverId);
    await check(h, serverId);
    const e = h.discord.last().embeds[0]!;
    expect(e.title).toBe("Pi Survival is back to normal");
    expect(e.description).toContain("The lag lasted 12 min. Worst moment: slowest ticks 320 ms, lowest TPS 12.4. We didn't find a clear cause.");
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["incident_opened", "sent"], ["incident_resolved", "sent"]]);
  });

  it("cooldown per event: a second incident within cooldownMinutes is suppressed (and never gets a resolved); later ones go out", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h, { webhookUrl: HOOK, cooldownMinutes: 30 });
    const a = await openIncident(h, serverId);
    await check(h, serverId);
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now() where id = ${a}`);
    await check(h, serverId); // resolved for A (never suppressed by cooldown)
    h.clock.now += 10 * MIN;
    const b = await openIncident(h, serverId);
    await check(h, serverId);
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now() where id = ${b}`);
    await check(h, serverId); // no resolved for B: its opener wasn't sent
    h.clock.now += 31 * MIN;
    await openIncident(h, serverId);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([
      ["incident_opened", "sent"],
      ["incident_resolved", "sent"],
      ["incident_opened", "suppressed_cooldown"],
      ["incident_opened", "sent"],
    ]);
    expect(h.discord.calls).toHaveLength(3);
  });

  it("quiet hours (midnight span, time zone): suppressed and not sent later; critical incident_opened still goes out", async () => {
    // 23:30 in Zurich.
    const h = alertHarness({ startMs: Date.parse("2026-11-10T22:30:00Z") });
    const { serverId } = await setup(h, { webhookUrl: HOOK, quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "Europe/Zurich" } });
    await openIncident(h, serverId, "high");
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["suppressed_quiet"]);
    expect(h.discord.calls).toHaveLength(0);
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now() where server_id = ${serverId}`);
    await openIncident(h, serverId, "critical");
    await check(h, serverId);
    expect(h.discord.calls).toHaveLength(1);
    expect(h.discord.last().embeds[0]!.title).toBe("Pi Survival is lagging (critical)");
    h.clock.now = Date.parse("2026-11-11T07:30:00Z"); // 08:30 local: the suppressed one is not sent late
    await check(h, serverId);
    expect(h.discord.calls).toHaveLength(1);
  });

  it("disabled config or event toggle off → suppressed_disabled (logged, not sent)", async () => {
    const h = alertHarness();
    const { serverId, client } = await setup(h, { webhookUrl: HOOK, enabled: false });
    await openIncident(h, serverId);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["suppressed_disabled"]);
    await client.req("PUT", `/api/servers/${serverId}/alerts`, baseConfig({ events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: false } }));
    h.clock.now += 2 * MIN; // crash events count from when alerts were configured
    await handle.db.insert(events).values({ serverId, ts: new Date(h.clock.now - MIN), type: "crash", data: {}, eventHash: `c-${serverId}` });
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["incident_opened", "suppressed_disabled"], ["crash", "suppressed_disabled"]]);
    expect(h.discord.calls).toHaveLength(0);
  });

  it("server_offline once per outage after offlineAfterMinutes; server_back on the next sample; none before any data", async () => {
    const h = alertHarness();
    const { serverId, apiKey } = await setup(h, { webhookUrl: HOOK, offlineAfterMinutes: 5 });
    await check(h, serverId);
    expect(await deliveries(serverId)).toEqual([]); // never sent data: not "offline"
    expect((await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1))).status).toBe(200);
    await h.alerts.idle();
    h.clock.now += 4 * MIN;
    await check(h, serverId);
    expect(await deliveries(serverId)).toEqual([]);
    h.clock.now += 2 * MIN;
    await check(h, serverId);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["server_offline", "sent"]]);
    expect(h.discord.last().embeds[0]!).toMatchObject({ title: "Pi Survival is offline", url: `${WEB_ORIGIN}/app/servers/${serverId}` });
    expect(h.discord.last().embeds[0]!.description).toContain("We haven't heard from the server for 6 minutes.");
    h.clock.now += MIN;
    expect((await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1))).status).toBe(200);
    await h.alerts.idle(); // ingest kicked the check
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["server_offline", "sent"], ["server_back", "sent"]]);
    expect(h.discord.last().embeds[0]!.title).toBe("Pi Survival is back online");
    expect(h.discord.last().embeds[0]!.description).toMatch(/The server is sending data again\. It was offline for \d+ (s|min)\./);
    await check(h, serverId);
    expect(h.discord.calls).toHaveLength(2);
  });

  it("server_back only after a SENT offline (quiet-suppressed outage → no back message)", async () => {
    const h = alertHarness({ startMs: Date.parse("2026-11-10T23:00:00Z") });
    const { serverId, apiKey } = await setup(h, { webhookUrl: HOOK, quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" } });
    await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1));
    h.clock.now += 10 * MIN;
    await check(h, serverId);
    await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1));
    await h.alerts.idle();
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["server_offline", "suppressed_quiet"]]);
  });

  it("crash: agent crash or unclean server_start → alert (cooldown folds the pair); clean starts and old events ignored", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    h.clock.now += 5 * MIN; // crash events count from when alerts were configured
    const t = h.clock.now;
    await handle.db.insert(events).values([
      { serverId, ts: new Date(t - 2 * 3_600_000), type: "crash", data: {}, eventHash: `old-${serverId}` },
      { serverId, ts: new Date(t - 30_000), type: "server_start", data: { uncleanPreviousShutdown: false }, eventHash: `clean-${serverId}` },
      { serverId, ts: new Date(t - 20_000), type: "crash", data: { detail: "java.lang.OutOfMemoryError" }, eventHash: `crash-${serverId}` },
      { serverId, ts: new Date(t - 10_000), type: "server_start", data: { uncleanPreviousShutdown: true }, eventHash: `unclean-${serverId}` },
    ]);
    await check(h, serverId);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["crash", "sent"], ["crash", "suppressed_cooldown"]]);
    const e = h.discord.last().embeds[0]!;
    expect(e.title).toBe("Pi Survival crashed");
    expect(e.description).toContain(`(at <t:${Math.floor((t - 20_000) / 1000)}:f>)`);
    expect(e.description).not.toContain("OutOfMemoryError");
  });

  it("retries through the dispatcher; 401/404 → failed + webhookStatus invalid, later events failed without calling Discord until replaced", async () => {
    const h = alertHarness();
    const { serverId, client } = await setup(h);
    h.discord.queue = [502, 204];
    await openIncident(h, serverId);
    await check(h, serverId);
    expect(h.sleeps).toEqual([1000]);
    expect((await deliveries(serverId)).at(-1)).toMatchObject({ status: "sent", http_status: 204 });
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now() where server_id = ${serverId}`);
    h.discord.queue = [404];
    h.clock.now += 1000;
    await check(h, serverId);
    expect((await deliveries(serverId)).at(-1)).toMatchObject({ event: "incident_resolved", status: "failed", http_status: 404 });
    expect(alertConfig.parse(await (await client.get(`/api/servers/${serverId}/alerts`)).json()).webhookStatus).toBe("invalid");
    const calls = h.discord.calls.length;
    h.clock.now += 1000;
    await handle.db.insert(events).values({ serverId, ts: new Date(h.clock.now - 1000), type: "crash", data: {}, eventHash: `x-${serverId}` });
    await check(h, serverId);
    expect(h.discord.calls.length).toBe(calls);
    expect((await deliveries(serverId)).at(-1)).toMatchObject({ event: "crash", status: "failed", http_status: null });
    expect((await deliveries(serverId)).at(-1)!.error).toContain("no longer works");
    // New URL → untested → sends again.
    await client.req("PUT", `/api/servers/${serverId}/alerts`, baseConfig({ webhookUrl: HOOK2 }));
    await handle.db.insert(events).values({ serverId, ts: new Date(h.clock.now - 500), type: "crash", data: {}, eventHash: `y-${serverId}` });
    h.clock.now += 31 * MIN;
    await check(h, serverId);
    // With a working webhook again, the failed resolved + crash alerts are retried (backoff over); crash "y" is then
    // folded by the crash cooldown.
    expect(h.discord.calls.length).toBe(calls + 2);
    expect((await deliveries(serverId)).filter((d) => d.status === "sent").map((d) => d.event).sort()).toEqual(["crash", "incident_opened", "incident_resolved"]);
    expect(h.discord.calls.at(-1)!.url).toBe(`${HOOK2}?wait=true`);
  });

  it("the webhook URL never reaches logs, delivery errors or API responses (even when fetch errors quote it)", async () => {
    const h = alertHarness();
    const { serverId, client } = await setup(h);
    h.discord.queue = ["throw", "throw"]; // network errors are retried once
    await openIncident(h, serverId);
    await check(h, serverId);
    const d = (await deliveries(serverId)).at(-1)!;
    expect(d).toMatchObject({ status: "failed", error: "Couldn't reach Discord." });
    const everything = [
      ...h.logs,
      JSON.stringify(await deliveries(serverId)),
      await (await client.get(`/api/servers/${serverId}/alerts`)).text(),
      await (await client.get(`/api/servers/${serverId}/alerts/deliveries`)).text(),
    ].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("123456789012345678");
  });

  it("unreadable webhook (key rotated, old unbound dev row, another server's value): failed once, webhookStatus invalid, Discord not called", async () => {
    for (const enc of [(id: string) => encryptSecret(randomBytes(32), HOOK, id), () => encryptSecret(KEY, HOOK), () => encryptSecret(KEY, HOOK, "other-server-id")]) {
      const h = alertHarness();
      const { serverId, client } = await setup(h);
      await handle.db.execute(sql`update alert_configs set webhook_enc = ${enc(serverId)} where server_id = ${serverId}`);
      await openIncident(h, serverId);
      await check(h, serverId);
      h.clock.now += 20 * MIN;
      await check(h, serverId); // invalid → no retries
      expect(h.discord.calls).toHaveLength(0);
      const d = await deliveries(serverId);
      expect(d).toHaveLength(1);
      expect(d[0]!.error).toContain("Paste the webhook URL again");
      expect(alertConfig.parse(await (await client.get(`/api/servers/${serverId}/alerts`)).json()).webhookStatus).toBe("invalid");
    }
  });

  it("never blocks ingest: a hanging Discord doesn't delay the metrics response; tick() covers every configured server", async () => {
    const h = alertHarness();
    const { serverId, apiKey } = await setup(h);
    await openIncident(h, serverId);
    let release!: (r: Response) => void;
    h.discord.queue = [new Promise<Response>((r) => (release = r))];
    const t0 = Date.now();
    const res = await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1));
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.discord.calls).toHaveLength(1); // the check started in the background
    release(new Response(null, { status: 204 }));
    await h.alerts.idle();
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["sent"]);
    expect(await h.alerts.tick()).toBeGreaterThanOrEqual(1);
    await h.alerts.idle();
    expect(h.discord.calls).toHaveLength(1);
  });

  it("deliveries are purged after 30 days by the retention job", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    await handle.db.execute(sql`insert into alert_deliveries (server_id, event, status, created_at) values
      (${serverId}, 'test', 'sent', now() - interval '31 days'), (${serverId}, 'test', 'sent', now() - interval '29 days')`);
    const r = await runRetention(handle.db);
    expect(r.deleted.alert_deliveries).toBeGreaterThanOrEqual(1);
    expect(await deliveries(serverId)).toHaveLength(1);
  });
});

describe("review fixes (Phase 6)", () => {
  it("attemptState: due / wait (backoff) / done (final status, 3 attempts, invalid webhook)", () => {
    const f = (min: number) => ({ status: "failed", created_at: new Date(min * MIN) });
    expect(attemptState([], 0, false)).toBe("due");
    expect(attemptState([{ status: "sent", created_at: new Date(0) }], 0, false)).toBe("done");
    expect(attemptState([f(0), { status: "suppressed_quiet", created_at: new Date(MIN) }], 99 * MIN, false)).toBe("done");
    expect(attemptState([f(0)], 1 * MIN, false)).toBe("wait");
    expect(attemptState([f(0)], 2 * MIN, false)).toBe("due");
    expect(attemptState([f(0), f(2)], 9 * MIN, false)).toBe("wait");
    expect(attemptState([f(0), f(2)], 10 * MIN, false)).toBe("due");
    expect(attemptState([f(0), f(2), f(10)], 999 * MIN, false)).toBe("done");
    expect(attemptState([f(0)], 99 * MIN, true)).toBe("done");
  });

  it("H1: after an API restart no server counts as offline until offlineAfterMinutes after process start", async () => {
    const h = alertHarness();
    const { serverId, apiKey } = await setup(h, { webhookUrl: HOOK, offlineAfterMinutes: 5 });
    await ingest(h.app, apiKey, "metrics", metricsPayload(h.clock.now, 1));
    await h.alerts.idle();
    h.clock.now += 60 * MIN; // the API was down for an hour; a new process starts now
    const restarted = new AlertDispatcher({ db: handle.db, now: () => h.clock.now, webOrigin: WEB_ORIGIN, secretsKey: KEY, fetch: h.discord.fetch, sleep: async () => {}, startedAt: h.clock.now });
    await restarted.kick(serverId);
    expect(await deliveries(serverId)).toEqual([]);
    h.clock.now += 4 * MIN;
    await restarted.kick(serverId);
    expect(await deliveries(serverId)).toEqual([]);
    h.clock.now += MIN; // still silent 5 min after start → really offline
    await restarted.kick(serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["server_offline", "sent"]]);
    expect(h.discord.last().embeds[0]!.description).toContain("for 65 minutes");
  });

  it("M1: a failed incident_opened is retried with backoff (3 attempts max), then resolved still follows", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    h.discord.queue = [500, 500, 500, 500, 500, 500];
    const id = await openIncident(h, serverId);
    await check(h, serverId);
    h.clock.now += MIN;
    await check(h, serverId); // in backoff
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["failed"]);
    h.clock.now += MIN;
    h.discord.queue = [204];
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["failed", "sent"]);
    h.clock.now += MIN;
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'recovered', closed_at = now() where id = ${id}`);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => [d.event, d.status])).toEqual([["incident_opened", "failed"], ["incident_opened", "sent"], ["incident_resolved", "sent"]]);

    // Out of attempts: three failures, then nothing more.
    const h2 = alertHarness();
    const s2 = await setup(h2);
    h2.discord.queue = Array(9).fill(503);
    await openIncident(h2, s2.serverId);
    for (let k = 0; k < 6; k++) {
      await check(h2, s2.serverId);
      h2.clock.now += 9 * MIN;
    }
    expect((await deliveries(s2.serverId)).map((d) => d.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("M2: an opener suppressed by quiet hours is delivered once when the incident becomes critical", async () => {
    const h = alertHarness({ startMs: Date.parse("2026-11-10T23:00:00Z") });
    const { serverId } = await setup(h, { webhookUrl: HOOK, quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" } });
    const id = await openIncident(h, serverId, "high");
    await check(h, serverId);
    h.clock.now += MIN;
    await handle.db.execute(sql`update incidents set severity = 'critical' where id = ${id}`);
    await check(h, serverId);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => d.status)).toEqual(["suppressed_quiet", "sent"]);
    expect(h.discord.calls).toHaveLength(1);
    expect(h.discord.last().embeds[0]!.title).toBe("Pi Survival is lagging (critical)");
  });

  it("M3: an incident that ended because the server went offline gets no 'back to normal'", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    const id = await openIncident(h, serverId);
    await check(h, serverId);
    h.clock.now += MIN;
    await handle.db.execute(sql`update incidents set ended_at = now(), end_reason = 'offline', closed_at = now() where id = ${id}`);
    await check(h, serverId);
    expect((await deliveries(serverId)).map((d) => d.event)).toEqual(["incident_opened"]);
  });

  it("L5: incidents and outages that started before alerts were configured are ignored", async () => {
    const h = alertHarness();
    const user = await verifiedUser(h);
    const { server, setup: s } = createdServerResponse.parse(await (await user.client.post("/api/servers", { name: "Old" })).json());
    await ingest(h.app, s.apiKey, "metrics", metricsPayload(h.clock.now, 1));
    await openIncident(h, server.id, "critical");
    h.clock.now += 3 * 86_400_000; // days later, the owner sets up alerts
    await user.client.req("PUT", `/api/servers/${server.id}/alerts`, baseConfig({ webhookUrl: HOOK }));
    await check(h, server.id);
    h.clock.now += 10 * MIN;
    await check(h, server.id);
    expect(await deliveries(server.id)).toEqual([]);
  });

  it("L4: server names can't format, ping, link or render timestamps; truncation happens before escaping", () => {
    expect(plain("<@123> <t:1:f> https://evil.example :smile: **x**")).toBe("\\<@\u200b123\\> \\<t\\:1\\:f\\> https\\://evil.example \\:smile\\: \\*\\*x\\*\\*");
    const long = "*".repeat(150);
    expect(plain(long)).toBe("\\*".repeat(100));
    const m = buildMessage({ event: "server_offline", serverName: "@everyone <@&1>", link: "x", minutes: 6 });
    expect(m.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(m)).not.toMatch(/@everyone|<@&/);
  });

  it("L11: the test endpoint doesn't retry (fast answer)", async () => {
    const h = alertHarness();
    const { serverId, client } = await setup(h);
    h.discord.queue = [500, 204];
    const r = await client.post(`/api/servers/${serverId}/alerts/test`, {});
    expect(r.status).toBe(502);
    expect(h.discord.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("L3: a WEB_PUBLIC_URL with a trailing slash gives clean links (no //app)", async () => {
    const discord = new MockDiscord();
    const h = makeHarness({ env: { WEB_PUBLIC_URL: `${WEB_ORIGIN}/`, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, SECRETS_KEY: KEY_B64 }, fetch: discord.fetch });
    const user = await verifiedUser(h);
    const { server } = createdServerResponse.parse(await (await user.client.post("/api/servers", { name: "Slash" })).json());
    await user.client.req("PUT", `/api/servers/${server.id}/alerts`, baseConfig({ webhookUrl: HOOK }));
    expect((await user.client.post(`/api/servers/${server.id}/alerts/test`, {})).status).toBe(200);
    expect(discord.last().embeds[0]!.url).toBe(`${WEB_ORIGIN}/app/servers/${server.id}`);
  });
});

describe("cli alerts:test", () => {
  it("sends a test alert and prints the result without the URL", async () => {
    const h = alertHarness();
    const { serverId } = await setup(h);
    const saved = { db: process.env.DATABASE_URL, key: process.env.SECRETS_KEY };
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.SECRETS_KEY = KEY_B64;
    try {
      const d = new MockDiscord();
      const lines: string[] = [];
      expect(await main(["alerts:test", serverId], (l) => lines.push(l), { fetch: d.fetch, sleep: async () => {} })).toBe(0);
      expect(lines).toEqual(["test alert sent (HTTP 204)"]);
      expect(d.calls).toHaveLength(1);
      d.queue = [404];
      const out2: string[] = [];
      expect(await main(["alerts:test", serverId], (l) => out2.push(l), { fetch: d.fetch })).toBe(1);
      expect(out2.join("\n")).toContain("HTTP 404");
      expect([...lines, ...out2].join("\n")).not.toContain(TOKEN);
      await expect(main(["alerts:test", "00000000-0000-4000-8000-000000000000"], () => {})).rejects.toThrow(/server not found/);
    } finally {
      for (const [k, v] of [["DATABASE_URL", saved.db], ["SECRETS_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
