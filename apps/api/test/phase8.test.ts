import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { AUTH_LIMITS, SESSION_COOKIE, createdServerResponse, serverListResponse, sessionUser, statusPageSettings } from "@tickdoctor/shared";
import { AlertDispatcher } from "../src/alerts/dispatcher.js";
import { exportStream } from "../src/account/export.js";
import { main } from "../src/cli.js";
import { MemoryMailer } from "../src/auth/mailer.js";
import { loadEnv, parseBetaAllPro } from "../src/env.js";
import { runRetention } from "../src/jobs/retention.js";
import { configureLimits, effectivePlanId, planOf, planSource, retentionFor } from "../src/limits.js";
import { Client, PASSWORD, flush, freshEmail, ingest, makeHarness, metricsPayload, verifiedUser, type Harness } from "./app-helpers.js";
import { testDatabaseUrl } from "./db-url.js";
import { PEPPER, WEB_ORIGIN, freshFixture, freshIp, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);
afterEach(() => configureLimits({ betaAllPro: false }));

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY_B64 = randomBytes(32).toString("base64");
const TOKEN = "SeCrEtWeBhOoKtOkEn_abcdefghijklmnopqrstuvwxyz-0123456789";
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

const one = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>) => ((await handle.db.execute(q)) as unknown as T[])[0];
const count = async (q: ReturnType<typeof sql>) => Number((await one<{ n: number }>(q))!.n);

class MockDiscord {
  calls: string[] = [];
  fetch = async (url: string): Promise<Response> => {
    this.calls.push(url);
    return new Response(null, { status: 204 });
  };
}

interface H8 extends Harness {
  discord: MockDiscord;
  alerts: AlertDispatcher;
}

function harness(): H8 {
  const discord = new MockDiscord();
  const alerts = new AlertDispatcher({ db: handle.db, now: Date.now, webOrigin: WEB_ORIGIN, secretsKey: undefined, fetch: discord.fetch });
  const h = makeHarness({
    env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, SECRETS_KEY: KEY_B64 },
    alerts,
    fetch: discord.fetch,
  });
  return { ...h, discord, alerts };
}

async function newServer(client: Client, name = "Creeper Hollow") {
  const res = await client.post("/api/servers", { name });
  expect(res.status).toBe(201);
  return createdServerResponse.parse(await res.json());
}

const statusBody = (slug: string, over: Record<string, unknown> = {}) => ({
  enabled: true, slug, title: "My status", showPlayers: true, showUptime: true, showIncidents: true, theme: "dark", hideBranding: false, ...over,
});

const alertBody = {
  enabled: true,
  webhookUrl: HOOK,
  events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
  minSeverity: "medium",
  offlineAfterMinutes: 5,
  cooldownMinutes: 30,
  quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
};

/** A user with data in every table: server (+ ingest), incident, finding + link, event, snapshot, rollups, alerts, status page, Discord link, waitlist, pending Discord signup. */
async function seedRich(h: H8, tag = "rich") {
  const u = await verifiedUser(h, freshEmail(tag));
  const { server, setup } = await newServer(u.client, `${tag} server`);
  const now = Date.now();
  expect((await ingest(h.app, setup.apiKey, "hello", freshFixture("hello", now))).status).toBe(200);
  expect((await ingest(h.app, setup.apiKey, "metrics", metricsPayload(now, 3))).status).toBe(200);
  const sid = server.id;
  const [inc] = (await handle.db.execute(sql`
    insert into incidents (server_id, started_at, ended_at, end_reason, severity, peak_mspt_p95, trigger, source, baseline)
    values (${sid}, ${new Date(now - HOUR).toISOString()}::timestamptz, ${new Date(now - 30 * MIN).toISOString()}::timestamptz, 'recovered', 'high', 120, 'mspt', 'raw', '{"msptP95":20}'::jsonb)
    returning id`)) as unknown as { id: string }[];
  const [f] = (await handle.db.execute(sql`
    insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix, first_seen_at, last_seen_at)
    values (${sid}, 'entity-explosion', 'incident', ${tag}, 'high', 'Too many entities', 'e', '{"numbers":[]}'::jsonb, 'fix', now(), now())
    returning id`)) as unknown as { id: string }[];
  await handle.db.execute(sql`insert into finding_incidents (finding_id, incident_id) values (${f!.id}, ${inc!.id})`);
  await handle.db.execute(sql`insert into events (server_id, ts, type, data, event_hash) values (${sid}, now(), 'plugin_enabled', '{"plugin":"X"}'::jsonb, ${"h-" + tag + now})`);
  await handle.db.execute(sql`
    insert into incident_snapshots (server_id, incident_id, trigger, captured_at, mspt_p95_at_trigger, snapshot)
    values (${sid}, ${inc!.id}, 'incident', ${new Date(now - 50 * MIN).toISOString()}::timestamptz, 110, '{"worstChunks":[]}'::jsonb)`);
  for (const t of ["metric_rollups_1m", "metric_rollups_1h"]) {
    await handle.db.execute(sql`insert into ${sql.identifier(t)} (server_id, bucket, sample_count, mspt_p95_avg) values (${sid}, date_trunc('hour', now()) - interval '2 hours', 60, 12.5) on conflict do nothing`);
  }
  expect((await u.client.req("PUT", `/api/servers/${sid}/alerts`, alertBody)).status).toBe(200);
  await handle.db.execute(sql`insert into alert_deliveries (server_id, event, status) values (${sid}, 'test', 'sent')`);
  const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  expect((await u.client.req("PUT", `/api/servers/${sid}/status-page`, statusBody(slug))).status).toBe(200);
  const discordId = `9${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${discordId}, ${u.id})`);
  await handle.db.execute(sql`insert into waitlist (email, source) values (${u.email}, 'landing')`);
  await handle.db.execute(sql`
    insert into discord_pending_signups (token_hash, discord_user_id, email, expires_at)
    values (${"pending-" + randomBytes(8).toString("hex")}, ${"8" + discordId}, ${u.email}, now() + interval '10 minutes')`);
  return { ...u, serverId: sid, apiKey: setup.apiKey, slug, discordId, incidentId: inc!.id, findingId: f!.id };
}

// ---------------------------------------------------------------------------------------------------------
// 1. BETA_ALL_PRO
// ---------------------------------------------------------------------------------------------------------

describe("BETA_ALL_PRO: env + effective plan", () => {
  const base = { DATABASE_URL: "postgres://x:y@localhost/z", WEB_PUBLIC_URL: WEB_ORIGIN, API_KEY_PEPPER: PEPPER };
  it("env: default false; true/1 → true; the CLI parses it the same way", () => {
    expect(loadEnv(base).BETA_ALL_PRO).toBe(false);
    expect(loadEnv({ ...base, BETA_ALL_PRO: "true" }).BETA_ALL_PRO).toBe(true);
    expect(loadEnv({ ...base, BETA_ALL_PRO: "1" }).BETA_ALL_PRO).toBe(true);
    expect(loadEnv({ ...base, BETA_ALL_PRO: "" }).BETA_ALL_PRO).toBe(false);
    expect(() => loadEnv({ ...base, BETA_ALL_PRO: "yes" })).toThrow(/BETA_ALL_PRO/);
    expect(parseBetaAllPro({})).toBe(false);
    expect(parseBetaAllPro({ BETA_ALL_PRO: "true" })).toBe(true);
    expect(() => parseBetaAllPro({ BETA_ALL_PRO: "maybe" })).toThrow(/BETA_ALL_PRO/);
  });

  it("limits module: free → pro only while on; network stays network; unknown → free", () => {
    expect(effectivePlanId("free")).toBe("free");
    expect(retentionFor("free").rollup1h).toBe(7);
    configureLimits({ betaAllPro: true });
    expect(effectivePlanId("free")).toBe("pro");
    expect(planSource("free")).toBe("beta");
    expect(planSource("pro")).toBe("stored");
    expect(effectivePlanId("network")).toBe("network");
    expect(planOf("network").servers).toBe(10);
    expect(effectivePlanId("bogus")).toBe("pro");
    expect(retentionFor("free")).toEqual(retentionFor("pro"));
    expect(planOf("free").statusPage).toBe("custom");
  });

  it("nothing outside limits.ts reads plans[...] / plans.<id> from shared", () => {
    const root = new URL("../src", import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("/limits.ts")) {
          const src = readFileSync(p, "utf8");
          if (/\bplans\s*(\[|\.(free|pro|network)\b)/.test(src) || /import\s*\{[^}]*\bplans\b[^}]*\}\s*from\s*"@tickdoctor\/shared"/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("BETA_ALL_PRO: a stored-free user", () => {
  const h = harness();

  it("on: Pro limits everywhere (2 servers, branding hideable, sessionUser + list say beta); off: back to Free", async () => {
    configureLimits({ betaAllPro: true });
    const { client, id } = await verifiedUser(h);
    expect((await one<{ plan: string }>(sql`select plan from users where id = ${id}`))!.plan).toBe("free");

    const me = sessionUser.parse((await (await client.get("/api/account")).json()).user);
    expect(me).toMatchObject({ plan: "free", effectivePlan: "pro", planSource: "beta" });
    const s1 = (await newServer(client, "One")).server;
    const s2 = (await newServer(client, "Two")).server; // Pro limit: 2
    expect((await client.post("/api/servers", { name: "Three" })).status).toBe(402);
    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list.limits).toEqual({ plan: "pro", planSource: "beta", maxServers: 2, used: 2 });
    // Stored plans unchanged.
    expect(await count(sql`select count(*)::int as n from servers where owner_id = ${id} and plan = 'free'`)).toBe(2);

    // Status page: branding can be hidden.
    const slug = `beta-${Math.random().toString(36).slice(2, 8)}`;
    const put = await client.req("PUT", `/api/servers/${s1.id}/status-page`, statusBody(slug, { hideBranding: true }));
    expect(put.status).toBe(200);
    expect(statusPageSettings.parse(await put.json()).hideBranding).toBe(true);
    const pub = await h.app.request(`/api/public/status/${slug}`, { headers: { "x-forwarded-for": freshIp() } });
    expect((await pub.json()).branding).toBe(false);

    // Retention: an 30-day-old 1-h rollup and a 2-day-old raw sample survive (Pro: 90 d / 3 d).
    const now = Date.now();
    await handle.db.execute(sql`insert into metric_rollups_1h (server_id, bucket, sample_count) values (${s2.id}, ${new Date(Math.floor((now - 30 * DAY) / HOUR) * HOUR).toISOString()}::timestamptz, 60)`);
    await handle.db.execute(sql`insert into metric_samples (server_id, ts, detail) values (${s2.id}, ${new Date(now - 2 * DAY).toISOString()}::timestamptz, '{}'::jsonb)`);
    await runRetention(handle.db, { now });
    expect(await count(sql`select count(*)::int as n from metric_rollups_1h where server_id = ${s2.id}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from metric_samples where server_id = ${s2.id}`)).toBe(1);

    // Switch off → the same user is on Free again.
    configureLimits({ betaAllPro: false });
    const me2 = sessionUser.parse((await (await client.get("/api/account")).json()).user);
    expect(me2).toMatchObject({ plan: "free", effectivePlan: "free", planSource: "stored" });
    const list2 = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list2.limits).toEqual({ plan: "free", planSource: "stored", maxServers: 1, used: 2 });
    expect((await client.post("/api/servers", { name: "Three" })).status).toBe(402);
    const pub2 = await h.app.request(`/api/public/status/${slug}`, { headers: { "x-forwarded-for": freshIp() } });
    expect((await pub2.json()).branding).toBe(true);
    const get = await client.get(`/api/servers/${s1.id}/status-page`);
    expect(statusPageSettings.parse(await get.json()).hideBranding).toBe(false);
    // The normal retention job trims to Free (7 d rollups, 1 d raw).
    await runRetention(handle.db, { now });
    expect(await count(sql`select count(*)::int as n from metric_rollups_1h where server_id = ${s2.id}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from metric_samples where server_id = ${s2.id}`)).toBe(0);
  });

  it("off: a fresh free user gets exactly one server", async () => {
    const { client } = await verifiedUser(h);
    await newServer(client, "Only");
    expect((await client.post("/api/servers", { name: "Second" })).status).toBe(402);
  });

  it("network stays network (planSource stored, 10 servers) with the switch on", async () => {
    configureLimits({ betaAllPro: true });
    const { client, id } = await verifiedUser(h);
    await handle.db.execute(sql`update users set plan = 'network' where id = ${id}`);
    const me = sessionUser.parse((await (await client.get("/api/account")).json()).user);
    expect(me).toMatchObject({ plan: "network", effectivePlan: "network", planSource: "stored" });
    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list.limits).toMatchObject({ plan: "network", planSource: "stored", maxServers: 10 });
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. Export
// ---------------------------------------------------------------------------------------------------------

describe("GET /api/account/export", () => {
  const h = harness();

  it("streams everything we hold, as an attachment, without any secret", async () => {
    const r = await seedRich(h, "exp");
    const other = await seedRich(h, "other");
    const res = await r.client.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="tickdoctor-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const doc = JSON.parse(text);

    expect(doc.schemaVersion).toBe(1);
    expect(typeof doc.exportedAt).toBe("string");
    expect(doc.account).toMatchObject({
      email: r.email, plan: "free", effectivePlan: "free", hasPassword: true,
      discord: { linked: true, discordUserId: r.discordId },
    });
    expect(doc.account.consentAt).toBeTruthy();
    expect(doc.account.lastSignupAt).toBeTruthy();
    expect(doc.discordPendingSignups).toEqual([
      { email: r.email, discordUserId: `8${r.discordId}`, createdAt: expect.any(String), expiresAt: expect.any(String), usedAt: null },
    ]);
    const pending = await one<{ token_hash: string }>(sql`select token_hash from discord_pending_signups where email = ${r.email}`);
    expect(text).not.toContain(pending!.token_hash);
    expect(doc.account.sessions.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(doc.account.sessions[0]).sort()).toEqual(["createdAt", "expiresAt", "lastUsedAt"]);
    expect(doc.waitlist).toEqual([expect.objectContaining({ email: r.email, source: "landing" })]);
    expect(doc.servers).toHaveLength(1);
    const s = doc.servers[0];
    expect(s).toMatchObject({ id: r.serverId, name: "exp server", plan: "free" });
    expect(s.apiKeys).toHaveLength(1);
    expect(Object.keys(s.apiKeys[0]).sort()).toEqual(["createdAt", "prefix", "revokedAt"]);
    expect(s.infoHistory.length).toBe(1);
    expect(s.pluginInventory.length).toBeGreaterThan(0);
    expect(s.statusPage).toMatchObject({ slug: r.slug, enabled: true });
    expect(s.alertConfig).toMatchObject({ enabled: true, webhook_masked: expect.stringContaining("discord.com/api/webhooks/") });
    expect(s.alertConfig).not.toHaveProperty("webhook_enc");
    expect(s.alertDeliveries.length).toBeGreaterThanOrEqual(1);
    expect(s.incidents).toEqual([expect.objectContaining({ id: r.incidentId, baseline: { msptP95: 20 } })]);
    expect(s.findings).toEqual([expect.objectContaining({ id: r.findingId, incidentIds: [r.incidentId] })]);
    expect(s.events.length).toBeGreaterThanOrEqual(1);
    expect(s.snapshots.length).toBe(1);
    expect(s.rollups1h.length).toBeGreaterThanOrEqual(1);
    expect(s.rollups1m.length).toBeGreaterThanOrEqual(1);
    expect(s.samples.length).toBe(3);
    expect(s.samples[0]).not.toHaveProperty("server_id");

    // Never secrets, never other users.
    const secrets = await one<{ pw: string; key: string; enc: string }>(sql`
      select u.password_hash as pw, (select key_hash from api_keys where server_id = ${r.serverId} limit 1) as key,
             (select webhook_enc from alert_configs where server_id = ${r.serverId}) as enc
        from users u where u.id = ${r.id}`);
    const sessionHashes = (await handle.db.execute(sql`select id_hash from sessions where user_id = ${r.id}`)) as unknown as { id_hash: string }[];
    const tokenHashes = (await handle.db.execute(sql`select token_hash from email_tokens where user_id = ${r.id}`)) as unknown as { token_hash: string }[];
    for (const secret of [secrets!.pw, secrets!.key, secrets!.enc, r.apiKey, HOOK, TOKEN, ...sessionHashes.map((x) => x.id_hash), ...tokenHashes.map((x) => x.token_hash)]) {
      expect(secret).toBeTruthy();
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("key_hash");
    expect(text).not.toContain(other.email);
    expect(text).not.toContain(other.serverId);
  });

  it("needs a session and is limited to 3 per hour per user", async () => {
    expect((await new Client(h.app).get("/api/account/export")).status).toBe(401);
    const { client } = await verifiedUser(h);
    for (let i = 0; i < 3; i++) {
      const res = await client.get("/api/account/export");
      expect(res.status).toBe(200);
      JSON.parse(await res.text());
    }
    const limited = await client.get("/api/account/export");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("is produced batch by batch as it is read (never buffered) and releases its connection on cancel", async () => {
    const { client, id } = await verifiedUser(h);
    const { server } = await newServer(client, "Big");
    const N = 20_000;
    const now = Date.now();
    await handle.db.execute(sql`
      insert into metric_samples (server_id, ts, mspt_p95, players, detail)
      select ${server.id}, ${new Date(now).toISOString()}::timestamptz - (g * interval '1 second'), 10 + (g % 7), g % 20,
             jsonb_build_object('worlds', jsonb_build_array(jsonb_build_object('name', 'world', 'entities', g % 300)))
        from generate_series(1, ${N}) g`);

    // Full read: many chunks, valid JSON with every sample.
    const fetched: number[] = [];
    const full = exportStream(handle.db, id, { now, onBatch: (t, n) => t === "metric_samples" && fetched.push(n) });
    const reader = full.getReader();
    let chunks = 0;
    let bytes = 0;
    let maxChunk = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks++;
      bytes += value.length;
      maxChunk = Math.max(maxChunk, value.length);
      parts.push(value);
    }
    const doc = JSON.parse(Buffer.concat(parts).toString("utf8"));
    expect(doc.servers[0].samples).toHaveLength(N);
    expect(fetched.reduce((a, b) => a + b, 0)).toBe(N);
    expect(Math.max(...fetched)).toBeLessThanOrEqual(500);
    expect(chunks).toBeGreaterThan(N / 500);
    expect(maxChunk).toBeLessThan(bytes / 20); // no single piece holds a big part of the file

    // Partial read: only what is read gets fetched (backpressure), then cancel.
    const seen: number[] = [];
    const partial = exportStream(handle.db, id, { now, onBatch: (t, n) => t === "metric_samples" && seen.push(n) });
    const r2 = partial.getReader();
    let text = "";
    while (!text.includes('"samples":[')) {
      const { value, done } = await r2.read();
      if (done) throw new Error("ended early");
      text += Buffer.from(value).toString("utf8");
    }
    await r2.read(); // one batch of samples
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * 500);
    await r2.cancel();
    await new Promise((r) => setTimeout(r, 50));
    // The export's transaction is gone and the pool (max 2) still serves two concurrent queries.
    expect(await count(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`)).toBe(0);
    await Promise.all([handle.db.execute(sql`select 1`), handle.db.execute(sql`select pg_sleep(0.05)`)]);
  });
});

describe("GET /api/account/export: concurrency cap, timeouts, client abort", () => {
  const h = harness();
  const idleInTx = () =>
    count(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`);

  /** Reads until the export has its transaction open and sent the first data. */
  async function readStart(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    return Buffer.from(value!).toString("utf8");
  }

  it("caps concurrent exports at 2 across all users (429 above); a cancelled one frees its slot", async () => {
    const users = await Promise.all([1, 2, 3, 4].map(() => verifiedUser(h)));
    const a = await users[0]!.client.get("/api/account/export");
    const b = await users[1]!.client.get("/api/account/export");
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await users[2]!.client.get("/api/account/export");
    expect(c.status).toBe(429);
    expect((await c.json()).error.code).toBe("rate_limited");
    expect(c.headers.get("retry-after")).toBeTruthy();
    await a.body!.cancel();
    await flush();
    const d = await users[3]!.client.get("/api/account/export");
    expect(d.status).toBe(200);
    JSON.parse(await d.text()); // finishing frees the slot too
    JSON.parse(await b.text());
    // The refused user's hourly budget was not spent: 3 more work, one after another.
    for (let i = 0; i < 3; i++) {
      const res = await users[2]!.client.get("/api/account/export");
      expect(res.status).toBe(200);
      JSON.parse(await res.text());
    }
  });

  it("HEAD answers with the headers only: no slot taken, no hourly budget spent", async () => {
    const [u, x, y] = await Promise.all([1, 2, 3].map(() => verifiedUser(h)));
    for (let i = 0; i < 5; i++) {
      const res = await u!.client.req("HEAD", "/api/account/export");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="tickdoctor-export-/);
    }
    // Both slots are still free and u's 3/hour budget is untouched.
    const [a, b] = [await x!.client.get("/api/account/export"), await y!.client.get("/api/account/export")];
    expect([a.status, b.status]).toEqual([200, 200]);
    JSON.parse(await a.text());
    JSON.parse(await b.text());
    for (let i = 0; i < 3; i++) {
      const res = await u!.client.get("/api/account/export");
      expect(res.status).toBe(200);
      JSON.parse(await res.text());
    }
  });

  it("one running export per user: a second one at the same time → 429 (the other slot stays for someone else)", async () => {
    const [u, other] = await Promise.all([1, 2].map(() => verifiedUser(h)));
    const first = await u!.client.get("/api/account/export");
    expect(first.status).toBe(200);
    const second = await u!.client.get("/api/account/export");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    const o = await other!.client.get("/api/account/export");
    expect(o.status).toBe(200);
    JSON.parse(await o.text());
    JSON.parse(await first.text());
    const again = await u!.client.get("/api/account/export"); // finished → allowed again (budget: 2 of 3 used)
    expect(again.status).toBe(200);
    JSON.parse(await again.text());
  });

  it("a client abort stops the export, rolls back and releases the connection and the slot", async () => {
    const users = await Promise.all([1, 2, 3].map(() => verifiedUser(h)));
    const ac = new AbortController();
    const res = await users[0]!.client.req("GET", "/api/account/export", undefined, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(await readStart(reader)).toContain('"exportedAt"');
    expect(await idleInTx()).toBe(1); // the export's open snapshot, waiting for the reader
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
    await flush();
    expect(await idleInTx()).toBe(0);
    // Both slots are free again.
    const [x, y] = [await users[1]!.client.get("/api/account/export"), await users[2]!.client.get("/api/account/export")];
    expect([x.status, y.status]).toEqual([200, 200]);
    JSON.parse(await x.text());
    JSON.parse(await y.text());
  });

  it("is aborted after the maximum duration (5 min by default) even if the reader stalls", async () => {
    const { id } = await verifiedUser(h);
    let closed = 0;
    const stream = exportStream(handle.db, id, { now: Date.now(), maxDurationMs: 300, onClose: () => closed++ });
    const reader = stream.getReader();
    await readStart(reader);
    expect(await idleInTx()).toBe(1);
    await new Promise((r) => setTimeout(r, 450));
    await expect(reader.read()).rejects.toThrow(/took too long/);
    await flush();
    expect(closed).toBe(1);
    expect(await idleInTx()).toBe(0);
    await Promise.all([handle.db.execute(sql`select 1`), handle.db.execute(sql`select 1`)]);
  });

  it("sets statement / idle-in-transaction timeouts on the export connection: a stalled reader is cut off by Postgres", async () => {
    const { id } = await verifiedUser(h);
    let closed = 0;
    const stream = exportStream(handle.db, id, { now: Date.now(), idleInTxTimeoutMs: 200, onClose: () => closed++ });
    const reader = stream.getReader();
    await readStart(reader);
    const [settings] = (await handle.db.execute(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and state like 'idle in transaction%'`)) as unknown as { n: number }[];
    expect(settings!.n).toBe(1);
    await new Promise((r) => setTimeout(r, 700));
    expect(await idleInTx()).toBe(0); // Postgres ended the idle session itself
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) break;
      })(),
    ).rejects.toThrow();
    await flush();
    expect(closed).toBe(1);
    // The pool recovers (a new connection replaces the terminated one).
    await Promise.all([handle.db.execute(sql`select 1`), handle.db.execute(sql`select 1`)]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Deletion
// ---------------------------------------------------------------------------------------------------------

/** Every (table, column) that could hold the user's id, a server id or the email — from the live schema. */
async function scanForLeftovers(userId: string, serverIds: string[], email: string) {
  const cols = (await handle.db.execute(sql`
    select table_name, column_name, data_type from information_schema.columns c
     where table_schema = 'public'
       and exists (select 1 from information_schema.tables t where t.table_schema = 'public' and t.table_name = c.table_name and t.table_type = 'BASE TABLE')
       and (data_type = 'uuid' or column_name in ('user_id', 'server_id', 'owner_id') or column_name = 'email' or column_name like '%\\_email')`)) as unknown as {
    table_name: string; column_name: string; data_type: string;
  }[];
  const hits: string[] = [];
  const ids = [userId, ...serverIds];
  for (const c of cols) {
    const ref = sql`${sql.identifier(c.table_name)}.${sql.identifier(c.column_name)}`;
    const isEmail = c.column_name === "email" || c.column_name.endsWith("_email");
    const where = isEmail ? sql`lower(${ref}::text) = ${email.toLowerCase()}` : sql`${ref}::text = any(${`{${ids.join(",")}}`}::text[])`;
    const n = await count(sql`select count(*)::int as n from ${sql.identifier(c.table_name)} where ${where}`);
    if (n > 0) hits.push(`${c.table_name}.${c.column_name}=${n}`);
  }
  return { hits, tables: new Set(cols.map((c) => c.table_name)), columns: cols.map((c) => `${c.table_name}.${c.column_name}`) };
}

describe("DELETE /api/account", () => {
  const h = harness();

  it("checks confirmEmail (case-insensitive) and the password, rate-limited", async () => {
    const { client, email } = await verifiedUser(h);
    const bad = await client.req("DELETE", "/api/account", { confirmEmail: "someone@else.test", password: PASSWORD });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.fields).toHaveProperty("confirmEmail");
    const noPw = await client.req("DELETE", "/api/account", { confirmEmail: email.toUpperCase() });
    expect(noPw.status).toBe(400);
    expect((await noPw.json()).error.fields).toHaveProperty("password");
    for (let i = 1; i < AUTH_LIMITS.loginPerEmailPer15Min; i++) {
      expect((await client.req("DELETE", "/api/account", { confirmEmail: email, password: "wrong password!" })).status).toBe(400);
    }
    const limited = await client.req("DELETE", "/api/account", { confirmEmail: email, password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(await count(sql`select count(*)::int as n from users where email = ${email}`)).toBe(1);
  });

  it("needs CSRF and a session", async () => {
    const { client, email } = await verifiedUser(h);
    expect((await client.req("DELETE", "/api/account", { confirmEmail: email, password: PASSWORD }, { csrf: false })).status).toBe(403);
    const anon = await new Client(h.app).init();
    expect((await anon.req("DELETE", "/api/account", { confirmEmail: email })).status).toBe(401);
  });

  it("removes everything (schema-driven scan), closes streams, clears cookies, emails, frees slugs, stops alerts; others untouched", async () => {
    const victim = await seedRich(h, "victim");
    const bystander = await seedRich(h, "bystander");
    const sessionCookie = victim.client.cookies.get(SESSION_COOKIE)!;
    // A live stream that must be closed.
    const ac = new AbortController();
    const live = await victim.client.req("GET", `/api/servers/${victim.serverId}/live`, undefined, { signal: ac.signal });
    expect(live.status).toBe(200);
    await flush();
    expect(h.hub.subscriberCount(victim.serverId)).toBe(1);
    const before = await scanForLeftovers(victim.id, [victim.serverId], victim.email);
    const bystanderBefore = await scanForLeftovers(bystander.id, [bystander.serverId], bystander.email);
    expect(before.hits.length).toBeGreaterThan(10);
    for (const t of ["waitlist", "discord_pending_signups", "oauth_accounts", "sessions", "metric_samples", "status_pages", "alert_configs", "finding_incidents"]) {
      expect(before.tables.has(t)).toBe(true);
    }

    const res = await victim.client.req("DELETE", "/api/account", { confirmEmail: victim.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cleared = res.headers.getSetCookie().join("\n");
    expect(cleared).toMatch(new RegExp(`${SESSION_COOKIE}=;[^\\n]*Max-Age=0`, "i"));
    expect(cleared).toMatch(/td_csrf=;[^\n]*Max-Age=0/i);
    expect(h.hub.subscriberCount(victim.serverId)).toBe(0);
    ac.abort();

    const after = await scanForLeftovers(victim.id, [victim.serverId], victim.email);
    expect(after.hits).toEqual([]);
    // The bystander keeps every row.
    const other = await scanForLeftovers(bystander.id, [bystander.serverId], bystander.email);
    expect(other.hits.sort()).toEqual(bystanderBefore.hits.sort());
    expect(await count(sql`select count(*)::int as n from metric_samples where server_id = ${bystander.serverId}`)).toBe(3);
    expect(await count(sql`select count(*)::int as n from waitlist where email = ${bystander.email}`)).toBe(1);

    // The old session is dead.
    const old = await h.app.request("/api/account", { headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}`, "x-forwarded-for": freshIp() } });
    expect(old.status).toBe(401);

    // Email: sent, no links.
    await flush();
    const mail = h.mailer.last(victim.email)!;
    expect(mail.subject).toMatch(/deleted/i);
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toMatch(/href=/i);

    // Slug free for someone else; public page gone.
    expect((await h.app.request(`/api/public/status/${victim.slug}`, { headers: { "x-forwarded-for": freshIp() } })).status).toBe(404);
    expect((await bystander.client.req("PUT", `/api/servers/${bystander.serverId}/status-page`, statusBody(victim.slug))).status).toBe(200);

    // Alerts: no config left to tick, a kick sends nothing.
    const calls = h.discord.calls.length;
    await h.alerts.kick(victim.serverId);
    await h.alerts.idle();
    expect(h.discord.calls.length).toBe(calls);
    expect(await count(sql`select count(*)::int as n from alert_configs where server_id = ${victim.serverId}`)).toBe(0);
  });

  it("a Discord-only account (no password) deletes with confirmEmail alone", async () => {
    const { client, email, id } = await verifiedUser(h);
    await handle.db.execute(sql`update users set password_hash = null where id = ${id}`);
    const res = await client.req("DELETE", "/api/account", { confirmEmail: email });
    expect(res.status).toBe(200);
    expect(await count(sql`select count(*)::int as n from users where id = ${id}`)).toBe(0);
  });
});

describe("DELETE /api/servers/:id frees the slug and stops alerts", () => {
  const h = harness();
  it("slug reusable, alert config gone, kick sends nothing", async () => {
    const r = await seedRich(h, "srvdel");
    const res = await r.client.req("DELETE", `/api/servers/${r.serverId}`, { confirmName: "srvdel server" });
    expect(res.status).toBe(200);
    expect(await count(sql`select count(*)::int as n from status_pages where server_id = ${r.serverId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from alert_configs where server_id = ${r.serverId}`)).toBe(0);
    const scan = await scanForLeftovers("00000000-0000-0000-0000-000000000000", [r.serverId], "nobody@nowhere.test");
    expect(scan.hits).toEqual([]);
    const calls = h.discord.calls.length;
    await h.alerts.kick(r.serverId);
    await h.alerts.idle();
    expect(h.discord.calls.length).toBe(calls);
    const { server } = await newServer(r.client, "Next");
    expect((await r.client.req("PUT", `/api/servers/${server.id}/status-page`, statusBody(r.slug))).status).toBe(200);
  });
});

describe("cli user:delete", () => {
  const h = harness();
  const saved = { db: process.env.DATABASE_URL, pepper: process.env.API_KEY_PEPPER };
  beforeAll(() => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.API_KEY_PEPPER = PEPPER;
  });
  afterAll(() => {
    process.env.DATABASE_URL = saved.db;
    process.env.API_KEY_PEPPER = saved.pepper;
  });

  it("refuses without --yes, deletes with it (same erasure), mails, unknown → error", async () => {
    const r = await seedRich(h, "clidel");
    const lines: string[] = [];
    const mailer = new MemoryMailer();
    await expect(main(["user:delete", r.email], (l) => lines.push(l), { mailer })).rejects.toThrow(/--yes/);
    expect(await count(sql`select count(*)::int as n from users where id = ${r.id}`)).toBe(1);
    expect(await main(["user:delete", r.email.toUpperCase(), "--yes"], (l) => lines.push(l), { mailer })).toBe(0);
    expect(lines).toContain("deleted=1");
    expect(lines).toContain("servers_deleted=1");
    expect(mailer.last(r.email)?.subject).toMatch(/deleted/i);
    expect((await scanForLeftovers(r.id, [r.serverId], r.email)).hits).toEqual([]);
    await expect(main(["user:delete", r.email, "--yes"], () => {}, { mailer })).rejects.toThrow(/not found/);
  });
});
