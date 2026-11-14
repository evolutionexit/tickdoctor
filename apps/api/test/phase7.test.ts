import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createdServerResponse, publicStatus, statusPageSettings } from "@tickdoctor/shared";
import { incidents, metricRollups1h, metricRollups1m, servers } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/middleware/rate-limit.js";
import { createLimiters } from "../src/app.js";
import { estimateIntervalSeconds } from "../src/status-pages/public.js";
import { Client, freshEmail, ingest, makeHarness, metricsPayload, verifiedUser, type Harness } from "./app-helpers.js";
import { WEB_ORIGIN, fixture, freshIp, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function newServer(client: Client, name = "Creeper Hollow") {
  const res = await client.post("/api/servers", { name });
  expect(res.status).toBe(201);
  return createdServerResponse.parse(await res.json());
}

const settingsBody = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  slug: `page-${Math.random().toString(36).slice(2, 10)}`,
  title: "My status",
  showPlayers: true,
  showUptime: true,
  showIncidents: true,
  theme: "dark",
  hideBranding: false,
  ...over,
});

const put = (client: Client, id: string, body: unknown) => client.req("PUT", `/api/servers/${id}/status-page`, body);
const setPlan = (id: string, plan: string) => handle.db.update(servers).set({ plan }).where(eq(servers.id, id));
/** Anonymous request: no cookies, a fresh IP. */
const anon = (h: Harness, path: string, headers: Record<string, string> = {}) =>
  h.app.request(path, { headers: { "x-forwarded-for": freshIp(), ...headers } });

describe("GET/PUT /api/servers/:id/status-page", () => {
  const h = makeHarness();

  it("defaults when never saved: suggested slug from the name, title = name, absolute URLs from WEB_PUBLIC_URL", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client, "Creeper Hollow SMP!");
    const res = await client.get(`/api/servers/${server.id}/status-page`);
    expect(res.status).toBe(200);
    const s = statusPageSettings.parse(await res.json());
    expect(s).toMatchObject({ enabled: false, title: "Creeper Hollow SMP!", showPlayers: true, showUptime: true, showIncidents: false, theme: "auto", hideBranding: false });
    expect(s.slug).toMatch(/^creeper-hollow-smp(-\d+)?$/);
    expect(s.publicUrl).toBe(`${WEB_ORIGIN}/s/${s.slug}`);
    expect(s.badgeUrl).toBe(`${WEB_ORIGIN}/badge/${s.slug}.svg`);
    // Nothing is saved by a GET.
    expect(await handle.db.execute(sql`select 1 from status_pages where server_id = ${server.id}`)).toHaveLength(0);
  });

  it("suggestion skips taken and reserved slugs and fixes short names", async () => {
    const a = await verifiedUser(h);
    const b = await verifiedUser(h);
    const sa = (await newServer(a.client, "Dup Name Test")).server;
    expect((await put(a.client, sa.id, settingsBody({ slug: "dup-name-test" }))).status).toBe(200);
    const sb = (await newServer(b.client, "Dup Name Test")).server;
    expect((await (await b.client.get(`/api/servers/${sb.id}/status-page`)).json()).slug).toBe("dup-name-test-2");
    const c = await verifiedUser(h);
    const admin = (await newServer(c.client, "Admin")).server;
    const s1 = (await (await c.client.get(`/api/servers/${admin.id}/status-page`)).json()).slug as string;
    expect(s1).toBe("admin-server");
    const d = await verifiedUser(h);
    const x = (await newServer(d.client, "X")).server;
    expect((await (await d.client.get(`/api/servers/${x.id}/status-page`)).json()).slug).toBe("x-server");
  });

  it("someone else's server is 404 (GET and PUT); not signed in is 401", async () => {
    const owner = await verifiedUser(h);
    const other = await verifiedUser(h);
    const { server } = await newServer(owner.client);
    expect((await other.client.get(`/api/servers/${server.id}/status-page`)).status).toBe(404);
    expect((await put(other.client, server.id, settingsBody())).status).toBe(404);
    expect((await other.client.get(`/api/servers/not-a-uuid/status-page`)).status).toBe(404);
    expect((await new Client(h.app).get(`/api/servers/${server.id}/status-page`)).status).toBe(401);
    expect(await handle.db.execute(sql`select 1 from status_pages where server_id = ${server.id}`)).toHaveLength(0);
  });

  it("PUT needs CSRF (missing header, wrong Origin)", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    expect((await client.req("PUT", `/api/servers/${server.id}/status-page`, settingsBody(), { csrf: false })).status).toBe(403);
    expect((await client.req("PUT", `/api/servers/${server.id}/status-page`, settingsBody(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await client.req("PUT", `/api/servers/${server.id}/status-page`, settingsBody(), { origin: null })).status).toBe(403);
  });

  it("slug rules: shape and reserved → 400 fields.slug; upper case is lower-cased", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    for (const slug of ["ab", "-abc", "abc-", "a--b", "has space", "ünïcode", "a".repeat(41), "under_score", "", "admin", "API", "tickdoctor", "minecraft"]) {
      const res = await put(client, server.id, settingsBody({ slug }));
      expect(res.status, slug).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.fields.slug, slug).toBeTruthy();
    }
    const ok = await put(client, server.id, settingsBody({ slug: "  My-Server-42 " }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).slug).toBe("my-server-42");
  });

  it("L6: brand words as the first or last slug part are reserved; in the middle they are fine", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    for (const slug of ["tickdoctor-status", "mojang-official", "minecraft-server", "my-minecraft", "status-tickdoctor", "official-mojang"]) {
      const res = await put(client, server.id, settingsBody({ slug }));
      expect(res.status, slug).toBe(400);
      expect((await res.json()).error.fields.slug, slug).toMatch(/reserved/);
    }
    expect((await put(client, server.id, settingsBody({ slug: "my-minecraft-world" }))).status).toBe(200);
    expect((await put(client, server.id, settingsBody({ slug: "minecrafty-smp" }))).status).toBe(200);
    // Suggestions avoid them too.
    const other = await verifiedUser(h);
    const s2 = (await newServer(other.client, "Minecraft")).server;
    const sug = (await (await other.client.get(`/api/servers/${s2.id}/status-page`)).json()).slug as string;
    expect(sug).toBe("my-minecraft-server");
  });

  it("L2: control and bidi characters are stripped from the title; nothing left → 400", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    const res = await put(client, server.id, settingsBody({ slug: "bidi-title", title: "Ev\u202Eil\u0007 SMP\u2066\u0000" }));
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Evil SMP");
    expect((await put(client, server.id, settingsBody({ slug: "bidi-title", title: "\u202E\u0007 " }))).status).toBe(400);
  });

  it("other validation: title, theme, missing fields → 400", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    expect((await put(client, server.id, settingsBody({ title: "   " }))).status).toBe(400);
    expect((await put(client, server.id, settingsBody({ title: "x".repeat(61) }))).status).toBe(400);
    expect((await put(client, server.id, settingsBody({ theme: "neon" }))).status).toBe(400);
    expect((await put(client, server.id, { enabled: true })).status).toBe(400);
  });

  it("taken slug (case-insensitive) → 409 fields.slug; changing the slug frees the old one", async () => {
    const a = await verifiedUser(h);
    const b = await verifiedUser(h);
    const sa = (await newServer(a.client)).server;
    const sb = (await newServer(b.client)).server;
    expect((await put(a.client, sa.id, settingsBody({ slug: "taken-slug" }))).status).toBe(200);
    const res = await put(b.client, sb.id, settingsBody({ slug: "TAKEN-slug" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("conflict");
    expect(body.error.fields.slug).toBeTruthy();
    // Re-saving your own slug is fine.
    expect((await put(a.client, sa.id, settingsBody({ slug: "taken-slug", title: "Renamed" }))).status).toBe(200);
    // Move away: old URL 404 at once, the other server can take it.
    expect((await put(a.client, sa.id, settingsBody({ slug: "new-slug-a" }))).status).toBe(200);
    expect((await anon(h, "/api/public/status/taken-slug")).status).toBe(404);
    expect((await put(b.client, sb.id, settingsBody({ slug: "taken-slug" }))).status).toBe(200);
    expect((await anon(h, "/api/public/status/taken-slug")).status).toBe(200);
  });

  it("hideBranding: forced false on Free (branded), kept on Pro/Network (custom); downgrade hides it again", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    await setPlan(server.id, "free");
    const free = await (await put(client, server.id, settingsBody({ slug: "brand-test", hideBranding: true }))).json();
    expect(free.hideBranding).toBe(false);
    expect((await (await anon(h, "/api/public/status/brand-test")).json()).branding).toBe(true);
    await setPlan(server.id, "pro");
    const pro = await (await put(client, server.id, settingsBody({ slug: "brand-test", hideBranding: true }))).json();
    expect(pro.hideBranding).toBe(true);
    expect((await (await anon(h, "/api/public/status/brand-test")).json()).branding).toBe(false);
    await setPlan(server.id, "network");
    expect((await (await client.get(`/api/servers/${server.id}/status-page`)).json()).hideBranding).toBe(true);
    await setPlan(server.id, "free");
    expect((await (await client.get(`/api/servers/${server.id}/status-page`)).json()).hideBranding).toBe(false);
    expect((await (await anon(h, "/api/public/status/brand-test")).json()).branding).toBe(true);
  });

  it("deleting the server deletes its page (cascade)", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client, "Gone Soon");
    expect((await put(client, server.id, settingsBody({ slug: "gone-soon" }))).status).toBe(200);
    expect((await client.req("DELETE", `/api/servers/${server.id}`, { confirmName: "Gone Soon" })).status).toBe(200);
    expect((await anon(h, "/api/public/status/gone-soon")).status).toBe(404);
  });
});

describe("GET /api/public/status/:slug", () => {
  const h = makeHarness();

  async function liveServer(slug: string, over: Record<string, unknown> = {}, name = "Secret Owner Name") {
    const { client } = await verifiedUser(h);
    const created = await newServer(client, name);
    const key = created.setup.apiKey;
    const hello = fixture("hello");
    hello.sentAt = new Date(h.clock.now).toISOString();
    expect((await ingest(h.app, key, "hello", hello)).status).toBe(200);
    expect((await ingest(h.app, key, "metrics", metricsPayload(h.clock.now, 3))).status).toBe(200);
    expect((await put(client, created.server.id, settingsBody({ slug, ...over }))).status).toBe(200);
    return { client, server: created.server, key };
  }

  it("unknown and disabled slugs give an identical 404 (status, body, headers)", async () => {
    const { client, server } = await liveServer("disabled-page", { enabled: false });
    const a = await anon(h, "/api/public/status/disabled-page");
    const b = await anon(h, "/api/public/status/no-such-page");
    const c = await anon(h, "/api/public/status/" + encodeURIComponent("<x>"));
    for (const r of [a, b, c]) {
      expect(r.status).toBe(404);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const [ta, tb, tc] = await Promise.all([a.text(), b.text(), c.text()]);
    expect(ta).toBe(tb);
    expect(tc).toBe(tb);
    const hdr = (r: Response) => JSON.stringify([...r.headers].filter(([k]) => k !== "date").sort());
    expect(hdr(a)).toBe(hdr(b));
    // Enabling makes it appear.
    expect((await put(client, server.id, settingsBody({ slug: "disabled-page" }))).status).toBe(200);
    expect((await anon(h, "/api/public/status/disabled-page")).status).toBe(200);
  });

  it("returns exactly the contract keys, cache header, no cookies (even with a session cookie sent)", async () => {
    const { client } = await liveServer("exact-keys");
    const res = await h.app.request("/api/public/status/EXACT-keys", {
      headers: { "x-forwarded-for": freshIp(), cookie: client.cookieHeader() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    const json = JSON.parse(text);
    expect(Object.keys(json).sort()).toEqual(["branding", "generatedAt", "incidents", "lastSeenAt", "players", "state", "theme", "title", "uptime"]);
    expect(Object.keys(json.players).sort()).toEqual(["max", "online"]);
    expect(Object.keys(json.uptime).sort()).toEqual(["d1", "d30", "d7"]);
    publicStatus.strict().parse(json);
    expect(json).toMatchObject({ title: "My status", state: "operational", theme: "dark", branding: true });
    expect(json.players.max).toBe(fixture("hello").payload.server.maxPlayers);
    // Nothing private: server name, ids, owner email, key, plugins, IPs.
    expect(text).not.toContain("Secret Owner Name");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toContain("@");
    expect(text).not.toContain("td_live_");
    for (const p of fixture("hello").payload.plugins as { name: string }[]) expect(text).not.toContain(p.name);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("each section only when enabled by the owner", async () => {
    await liveServer("all-off", { showPlayers: false, showUptime: false, showIncidents: false });
    const json = await (await anon(h, "/api/public/status/all-off")).json();
    expect(json.players).toBeNull();
    expect(json.uptime).toBeNull();
    expect(json.incidents).toBeNull();
  });

  it("state mapping follows the health function: lagging (open incident), offline (no data) with 0 players", async () => {
    const { server } = await liveServer("state-map");
    await handle.db.insert(incidents).values({ serverId: server.id, startedAt: new Date(h.clock.now - 5 * MIN), severity: "high", peakMsptP95: 120, trigger: "mspt", source: "raw" });
    expect((await (await anon(h, "/api/public/status/state-map")).json()).state).toBe("lagging");
    h.clock.now += 10 * MIN;
    try {
      const j = await (await anon(h, "/api/public/status/state-map")).json();
      expect(j.state).toBe("offline");
      expect(j.players.online).toBe(0);
    } finally {
      h.clock.now -= 10 * MIN;
    }
  });

  it("waiting (never sent data) is shown as offline", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    expect((await put(client, server.id, settingsBody({ slug: "never-sent" }))).status).toBe(200);
    const j = await (await anon(h, "/api/public/status/never-sent")).json();
    expect(j).toMatchObject({ state: "offline", lastSeenAt: null, uptime: { d1: null, d7: null, d30: null } });
  });

  it("incidents: last 30 days, newest first, max 10, only medium+; no ids or findings", async () => {
    const { server } = await liveServer("incidents-page");
    const now = h.clock.now;
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({ serverId: server.id, startedAt: new Date(now - (i + 1) * DAY), endedAt: new Date(now - (i + 1) * DAY + 10 * MIN), severity: "medium", peakMsptP95: 80, trigger: "mspt", source: "raw", endReason: "recovered" });
    }
    rows.push({ serverId: server.id, startedAt: new Date(now - 31 * DAY), endedAt: new Date(now - 31 * DAY + MIN), severity: "critical", peakMsptP95: 300, trigger: "mspt", source: "raw", endReason: "recovered" });
    await handle.db.insert(incidents).values(rows);
    const j = await (await anon(h, "/api/public/status/incidents-page")).json();
    expect(j.incidents).toHaveLength(10);
    expect(Object.keys(j.incidents[0]).sort()).toEqual(["durationSeconds", "endedAt", "severity", "startedAt"]);
    expect(j.incidents[0].durationSeconds).toBe(600);
    const starts = j.incidents.map((i: { startedAt: string }) => Date.parse(i.startedAt));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    expect(starts.every((s: number) => s >= now - 30 * DAY)).toBe(true);
  });

  it("rate limit: 60 per minute per IP → 429 with Retry-After", async () => {
    const h2 = makeHarness({ limiters: { ...createLimiters(), publicStatusPerIp: new FixedWindowLimiter(60, MIN) } });
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      const r = await h2.app.request("/api/public/status/whatever", { headers: { "x-forwarded-for": ip } });
      expect(r.status).toBe(404);
    }
    const r = await h2.app.request("/api/public/status/whatever", { headers: { "x-forwarded-for": ip } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await h2.app.request("/api/public/status/whatever", { headers: { "x-forwarded-for": freshIp() } })).status).toBe(404);
  });
});

describe("uptime from rollups", () => {
  const h = makeHarness();

  async function pageWithHistory(slug: string, firstSampleAgoMs: number, plan = "free") {
    const { client } = await verifiedUser(h, freshEmail("uptime"));
    const { server } = await newServer(client);
    await setPlan(server.id, plan);
    const now = h.clock.now;
    await handle.db.update(servers).set({ firstSampleAt: new Date(now - firstSampleAgoMs), lastSampleAt: new Date(now - 30_000) }).where(eq(servers.id, server.id));
    expect((await put(client, server.id, settingsBody({ slug }))).status).toBe(200);
    return server.id;
  }
  const minute = (ms: number) => Math.floor(ms / MIN) * MIN;
  const hour = (ms: number) => Math.floor(ms / HOUR) * HOUR;

  it("< 60 min of history → null; 3 h with half the minutes → 50 % in every window", async () => {
    const now = h.clock.now;
    const short = await pageWithHistory("uptime-short", 45 * MIN);
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 40 }, (_, i) => ({ serverId: short, bucket: new Date(minute(now) - (i + 1) * MIN), sampleCount: 6 })));
    expect((await (await anon(h, "/api/public/status/uptime-short")).json()).uptime).toEqual({ d1: null, d7: null, d30: null });

    const id = await pageWithHistory("uptime-half", 180 * MIN);
    // Every other minute of the last 180 has data (gaps = offline).
    const end = minute(now);
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 90 }, (_, i) => ({ serverId: id, bucket: new Date(end - (2 * i + 1) * MIN), sampleCount: 6 })));
    const u = (await (await anon(h, "/api/public/status/uptime-half")).json()).uptime;
    expect(u.d1).toBeCloseTo(50, 0);
    expect(u.d7).toBe(u.d1);
    expect(u.d30).toBe(u.d1);
  });

  it("older periods from 1-h rollups (sample_count / 6 per minute, capped at 60)", async () => {
    const now = h.clock.now;
    const id = await pageWithHistory("uptime-hourly", 10 * DAY, "pro");
    const end = minute(now);
    // Last 24 h fully up in 1-min rollups.
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 24 * 60 }, (_, i) => ({ serverId: id, bucket: new Date(end - (i + 1) * MIN), sampleCount: 6 })));
    // Days 2–10: only 1-h rollups, each hour half up (180 samples = 30 min); one hour over-counted (capped at 60).
    const hours = [];
    for (let hAgo = 25; hAgo < 10 * 24; hAgo++) hours.push({ serverId: id, bucket: new Date(hour(end) - hAgo * HOUR), sampleCount: hAgo === 30 ? 9999 : 180 });
    await handle.db.insert(metricRollups1h).values(hours);
    const u = (await (await anon(h, "/api/public/status/uptime-hourly")).json()).uptime;
    expect(u.d1).toBeGreaterThanOrEqual(99.9);
    // 7 d: 1 day up + ~6 days half up (+ one capped hour) → ≈ 57 %.
    expect(u.d7).toBeGreaterThan(55);
    expect(u.d7).toBeLessThan(60);
    // 30 d limited to the 10 days since the first sample: 1 day up + 9 days half → ≈ 55 %.
    expect(u.d30).toBeGreaterThan(53);
    expect(u.d30).toBeLessThan(57);
  });

  /**
   * An always-up server since `days` ago, written like the rollup job would: 1-min rows for the last 3 days (every
   * `everyNthMinute`-th minute, `perMinute` samples each) and 1-h rows whose sample_count covers only the part of
   * the hour after the first sample (so the first hour is partial, as in production).
   */
  async function alwaysUp(id: string, days: number, perMinute = 6, everyNthMinute = 1) {
    const end = minute(h.clock.now);
    const first = h.clock.now - days * DAY;
    const m = [];
    for (let i = 1; i <= 3 * 24 * 60; i++) {
      const b = end - i * MIN;
      if (i % everyNthMinute === 0 && b >= minute(first)) m.push({ serverId: id, bucket: new Date(b), sampleCount: perMinute });
    }
    for (let i = 0; i < m.length; i += 2000) await handle.db.insert(metricRollups1m).values(m.slice(i, i + 2000));
    const hrs = [];
    for (let b = hour(first); b <= hour(end); b += HOUR) {
      const minutes = (Math.min(b + HOUR, h.clock.now) - Math.max(b, first)) / MIN;
      hrs.push({ serverId: id, bucket: new Date(b), sampleCount: Math.max(1, Math.round((minutes * perMinute) / everyNthMinute)) });
    }
    await handle.db.insert(metricRollups1h).values(hrs);
  }

  // Time of day must not matter: run at 1, 30 and 59 minutes past the hour (injected clock).
  for (const past of [1, 30, 59]) {
    it(`H2: retention by plan — Free shows d30 as not available, Pro shows it; always-up reads ≥ 99.5 (clock at :${past})`, async () => {
      const saved = h.clock.now;
      h.clock.now = hour(saved) + past * MIN + 17_000;
      try {
        const tag = `${past}`;
        const free = await pageWithHistory(`uptime-free-${tag}`, 20 * DAY, "free");
        await alwaysUp(free, 20);
        const uf = (await (await anon(h, `/api/public/status/uptime-free-${tag}`)).json()).uptime;
        expect(uf.d1).toBeGreaterThanOrEqual(99.9);
        expect(uf.d7).toBeGreaterThanOrEqual(99.5);
        expect(uf.d30).toBeNull();
        const pro = await pageWithHistory(`uptime-pro-${tag}`, 20 * DAY, "pro");
        await alwaysUp(pro, 20);
        const up = (await (await anon(h, `/api/public/status/uptime-pro-${tag}`)).json()).uptime;
        expect(up.d1).toBeGreaterThanOrEqual(99.9);
        expect(up.d7).toBeGreaterThanOrEqual(99.5);
        expect(up.d30).toBeGreaterThanOrEqual(99.5);
        // A Free server younger than 7 days still gets d30 (its whole history is kept), including its partial first hour.
        const young = await pageWithHistory(`uptime-free-young-${tag}`, 5 * DAY, "free");
        await alwaysUp(young, 5);
        const uy = (await (await anon(h, `/api/public/status/uptime-free-young-${tag}`)).json()).uptime;
        expect(uy.d7).toBeGreaterThanOrEqual(99.5);
        expect(uy.d30).toBe(uy.d7);
      } finally {
        h.clock.now = saved;
      }
    });
  }

  it("H3: rollups older than first_sample_at (buffered/backfilled data) start the window", async () => {
    const id = await pageWithHistory("uptime-backfill", 30 * MIN, "pro");
    const end = minute(h.clock.now);
    const rowsM = [];
    for (let i = 1; i <= 60; i++) rowsM.push({ serverId: id, bucket: new Date(end - i * MIN), sampleCount: 6 });
    for (let i = 1; i <= 60; i++) rowsM.push({ serverId: id, bucket: new Date(end - 3 * DAY + i * MIN), sampleCount: 6 });
    await handle.db.insert(metricRollups1m).values(rowsM);
    const u = (await (await anon(h, "/api/public/status/uptime-backfill")).json()).uptime;
    // 120 minutes up out of ~3 days since the first rollup.
    expect(u.d7).toBeGreaterThan(2.5);
    expect(u.d7).toBeLessThan(3.1);
    expect(u.d1).toBeCloseTo((60 / (24 * 60)) * 100, 0);
  });

  it("M1: 30 s and 300 s agents read as fully up (interval inferred from the rollups)", async () => {
    const s30 = await pageWithHistory("uptime-30s", 10 * DAY, "pro");
    await alwaysUp(s30, 10, 2);
    expect(await estimateIntervalSeconds(handle.db, s30, h.clock.now)).toBe(30);
    const u30 = (await (await anon(h, "/api/public/status/uptime-30s")).json()).uptime;
    expect(u30.d1).toBeGreaterThanOrEqual(99.5);
    expect(u30.d7).toBeGreaterThanOrEqual(99.5);
    const s300 = await pageWithHistory("uptime-300s", 10 * DAY, "pro");
    await alwaysUp(s300, 10, 1, 5);
    expect(await estimateIntervalSeconds(handle.db, s300, h.clock.now)).toBe(300);
    const u300 = (await (await anon(h, "/api/public/status/uptime-300s")).json()).uptime;
    expect(u300.d1).toBeGreaterThanOrEqual(99.5);
    expect(u300.d7).toBeGreaterThanOrEqual(99.5);
  });

  it("M1: the interval comes from raw samples' windowSeconds when they exist", async () => {
    const { client } = await verifiedUser(h, freshEmail("interval"));
    const created = await newServer(client);
    await ingest(h.app, created.setup.apiKey, "metrics", metricsPayload(h.clock.now, 5, (smp) => (smp.windowSeconds = 30)));
    expect(await estimateIntervalSeconds(handle.db, created.server.id, h.clock.now)).toBe(30);
  });
});

describe("GET /badge/:slug.svg", () => {
  const h = makeHarness();

  it("unknown and disabled → identical grey 'unknown' 404 SVG; cache + content type", async () => {
    const { client } = await verifiedUser(h);
    const { server } = await newServer(client);
    expect((await put(client, server.id, settingsBody({ slug: "badge-off", enabled: false }))).status).toBe(200);
    const a = await anon(h, "/badge/badge-off.svg");
    const b = await anon(h, "/badge/nobody-here.svg");
    const c = await anon(h, "/badge/not-even-svg");
    for (const r of [a, b, c]) {
      expect(r.status).toBe(404);
      expect(r.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(r.headers.get("cache-control")).toBe("public, max-age=60");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const [ta, tb] = [await a.text(), await b.text()];
    expect(ta).toBe(tb);
    expect(ta).toContain(">unknown<");
  });

  it("L3: over the limit → the grey SVG with 429 and Retry-After (not JSON)", async () => {
    const h2 = makeHarness({ limiters: { ...createLimiters(), badgePerIp: new FixedWindowLimiter(2, MIN) } });
    const ip = freshIp();
    for (let i = 0; i < 2; i++) expect((await h2.app.request("/badge/x-y-z.svg", { headers: { "x-forwarded-for": ip } })).status).toBe(404);
    const r = await h2.app.request("/badge/x-y-z.svg", { headers: { "x-forwarded-for": ip } });
    expect(r.status).toBe(429);
    expect(r.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain(">unknown<");
  });

  it("enabled: state word + players, escaped title, no external references", async () => {
    const { client } = await verifiedUser(h);
    const created = await newServer(client);
    const hello = fixture("hello");
    hello.sentAt = new Date(h.clock.now).toISOString();
    await ingest(h.app, created.setup.apiKey, "hello", hello);
    await ingest(h.app, created.setup.apiKey, "metrics", metricsPayload(h.clock.now, 2, (s) => (s.players = { count: 3, pings: [] })));
    const evil = `<script>&"'</script>`;
    const r1 = await put(client, created.server.id, settingsBody({ slug: "badge-on", title: evil }));
    expect(r1.status).toBe(200);
    const res = await anon(h, "/badge/badge-on.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    const svg = await res.text();
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;&amp;&quot;&apos;&lt;/script&gt;");
    expect(svg).toMatch(/>online · \d+ players?</);
    expect(svg).toContain("minecraft");
    expect(svg).not.toMatch(/href|xlink|@import|url\((?!#)/);
    // Players hidden → just the state word.
    await put(client, created.server.id, settingsBody({ slug: "badge-on", showPlayers: false }));
    expect(await (await anon(h, "/badge/badge-on.svg")).text()).toMatch(/>online</);
  });

});
