import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createdServerResponse,
  firstDataResponse,
  incidentListItem,
  metricsResponse,
  serverDetail,
  serverListResponse,
} from "@tickdoctor/shared";
import { findings, incidents } from "../src/db/schema.js";
import { computeHealth, type HealthInput } from "../src/health.js";
import { KEY_PATTERN } from "../src/keys.js";
import { findLatestAgentJar } from "../src/routes/downloads.js";
import { softwareLabel } from "../src/routes/servers.js";
import { createServerForUser, ensureUser } from "../src/servers.js";
import { Client, PASSWORD, flush, freshEmail, ingest, makeHarness, metricsPayload, sseReader, verifiedUser, type Harness } from "./app-helpers.js";
import { ADMIN_TOKEN, PEPPER, WEB_ORIGIN, fixture, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);

const jarDir = mkdtempSync(join(tmpdir(), "td-jars-"));
for (const v of ["0.1.2", "0.1.10", "0.1.9"]) writeFileSync(join(jarDir, `tickdoctor-agent-${v}.jar`), `jar ${v}`);
writeFileSync(join(jarDir, "tickdoctor-agent-9.9.9-SNAPSHOT.jar"), "nope");
writeFileSync(join(jarDir, "other.jar"), "nope");

const ENV = { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, AGENT_JAR_DIR: jarDir, DEV_ADMIN_TOKEN: ADMIN_TOKEN };

async function newServer(h: Harness, client: Client, name = "Pi Survival") {
  const res = await client.post("/api/servers", { name });
  expect(res.status).toBe(201);
  return createdServerResponse.parse(await res.json());
}

function helloBody() {
  return fixture("hello");
}

describe("health function (table)", () => {
  const NOW = 1_800_000_000_000;
  const base: HealthInput = { firstSampleAt: NOW - 3600_000, lastSampleAt: NOW - 5_000, incidentOpen: false, medianMsptP95: 12, medianTps1m: 20, nowMs: NOW };
  it.each<[string, Partial<HealthInput>, string]>([
    ["never sent data", { firstSampleAt: null, lastSampleAt: null }, "waiting"],
    ["sample 90 s ago (boundary)", { lastSampleAt: NOW - 90_000 }, "healthy"],
    ["sample 91 s ago", { lastSampleAt: NOW - 91_000 }, "offline"],
    ["offline beats an open incident", { lastSampleAt: NOW - 120_000, incidentOpen: true }, "offline"],
    ["rollup-only history (seed), no live sample", { lastSampleAt: null }, "offline"],
    ["open incident", { incidentOpen: true }, "lagging"],
    ["lagging beats degraded", { incidentOpen: true, medianMsptP95: 80 }, "lagging"],
    ["median p95 = 40", { medianMsptP95: 40 }, "degraded"],
    ["median p95 39.9", { medianMsptP95: 39.9 }, "healthy"],
    ["median tps 18.9", { medianTps1m: 18.9 }, "degraded"],
    ["median tps 19", { medianTps1m: 19 }, "healthy"],
    ["no recent samples for medians", { medianMsptP95: null, medianTps1m: null }, "healthy"],
  ])("%s → %s", (_n, patch, expected) => {
    expect(computeHealth({ ...base, ...patch })).toBe(expected);
  });
});

describe("helpers", () => {
  it("software label", () => {
    expect(softwareLabel("Paper", "26.2-83-main@f9fb80b")).toBe("Paper 26.2 (build 83)");
    expect(softwareLabel("Purpur", "1.21.4")).toBe("Purpur 1.21.4");
  });
  it("newest agent jar by semver", async () => {
    expect(await findLatestAgentJar(jarDir)).toMatchObject({ version: "0.1.10", fileName: "tickdoctor-agent-0.1.10.jar" });
    expect(await findLatestAgentJar(undefined)).toBeNull();
    expect(await findLatestAgentJar(join(jarDir, "missing"))).toBeNull();
  });
});

describe("GET /downloads/agent/latest.jar", () => {
  it("serves the newest jar with version header; 404 when none", async () => {
    const h = makeHarness({ env: ENV });
    const r = await h.app.request("/downloads/agent/latest.jar");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-agent-version")).toBe("0.1.10");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="tickdoctor-agent-0.1.10.jar"');
    expect(await r.text()).toBe("jar 0.1.10");
    const empty = mkdtempSync(join(tmpdir(), "td-empty-"));
    mkdirSync(join(empty, "x"));
    const h2 = makeHarness({ env: { ...ENV, AGENT_JAR_DIR: empty } });
    const r2 = await h2.app.request("/downloads/agent/latest.jar");
    expect(r2.status).toBe(404);
    expect((await r2.json()).error.code).toBe("not_found");
  });
});

describe("servers: create / list / get / patch / delete / rotate", () => {
  const h = makeHarness({ env: ENV });

  it("401 without a session", async () => {
    const anon = await new Client(h.app).init();
    expect((await anon.get("/api/servers")).status).toBe(401);
    expect((await anon.post("/api/servers", { name: "x" })).status).toBe(401);
  });

  it("parallel creates with the same name from different users all succeed with distinct slugs (no 500 on the slug index)", async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => verifiedUser(h)));
    const rs = await Promise.all(users.map((u) => u.client.post("/api/servers", { name: "Race Craft" })));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(201));
    const slugs = new Set((await Promise.all(rs.map(async (r) => createdServerResponse.parse(await r.json())))).map((x) => x.server.slug));
    expect(slugs.size).toBe(8);
  });

  it("create needs a confirmed email: email_not_verified stays as a defence behind the session check", async () => {
    const email = freshEmail("unconfirmed");
    const uid = await ensureUser(handle.db, email);
    expect(await createServerForUser(handle.db, PEPPER, uid, "Nope")).toBe("email_not_verified");
    // Over HTTP an unconfirmed user never even has a session: un-confirming a user kills it (401).
    const { client, id } = await verifiedUser(h);
    await handle.db.execute(sql`update users set email_verified_at = null where id = ${id}`);
    const r = await client.post("/api/servers", { name: "Nope" });
    expect(r.status).toBe(401);
  });

  it("create → 201 with key + config snippet shown once; plan limit → 402", async () => {
    const { client } = await verifiedUser(h);
    const created = await newServer(h, client, "  My Pi  ");
    expect(created.server).toMatchObject({ name: "My Pi", slug: "my-pi", plan: "free", health: "waiting", latest: null, openIncidents: 0, topFinding: null, firstSeenAt: null });
    expect(created.setup.apiKey).toMatch(KEY_PATTERN);
    expect(created.setup.keyPrefix).toBe(created.setup.apiKey.slice(0, 12));
    expect(created.setup.configSnippet).toBe(`api-url: "${WEB_ORIGIN}"\napi-key: "${created.setup.apiKey}"\n`);
    expect(created.setup).toMatchObject({ downloadUrl: "/downloads/agent/latest.jar", agentVersion: "0.1.10" });

    const detail = serverDetail.parse(await (await client.get(`/api/servers/${created.server.id}`)).json());
    expect(JSON.stringify(detail)).not.toContain(created.setup.apiKey);
    expect(detail).toMatchObject({ keyPrefix: created.setup.keyPrefix, info: null });

    const over = await client.post("/api/servers", { name: "Second" });
    expect(over.status).toBe(402);
    expect((await over.json()).error.code).toBe("plan_limit");

    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list.limits).toEqual({ plan: "free", planSource: "stored", maxServers: 1, used: 1 });
    expect(list.servers.map((s) => s.id)).toEqual([created.server.id]);
  });

  it("AGENT_API_URL overrides the snippet's api-url; pro users get more slots and pro servers", async () => {
    const h2 = makeHarness({ env: { ...ENV, AGENT_API_URL: "http://100.64.0.10:3001" } });
    const { client, id } = await verifiedUser(h2);
    await handle.db.execute(sql`update users set plan = 'pro' where id = ${id}`);
    const a = await newServer(h2, client, "A");
    expect(a.setup.configSnippet).toContain('api-url: "http://100.64.0.10:3001"');
    expect(a.server.plan).toBe("pro");
    await newServer(h2, client, "B");
    expect((await client.post("/api/servers", { name: "C" })).status).toBe(402);
    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list.servers.map((s) => s.name)).toEqual(["B", "A"]); // newest first
    expect(list.limits).toEqual({ plan: "pro", planSource: "stored", maxServers: 2, used: 2 });
  });

  it("validation: empty / too long names → 400 with fields", async () => {
    const { client } = await verifiedUser(h);
    for (const name of ["   ", "x".repeat(61)]) {
      const r = await client.post("/api/servers", { name });
      expect(r.status).toBe(400);
      expect((await r.json()).error.fields.name).toBeTruthy();
    }
  });

  it("patch renames; delete needs the exact name and cascades", async () => {
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client, "Old Name");
    const p = await client.req("PATCH", `/api/servers/${server.id}`, { name: "New Name" });
    expect(p.status).toBe(200);
    expect(serverDetail.parse(await p.json()).name).toBe("New Name");

    await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now));
    const bad = await client.req("DELETE", `/api/servers/${server.id}`, { confirmName: "Old Name" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.fields.confirmName).toBeTruthy();
    const ok = await client.req("DELETE", `/api/servers/${server.id}`, { confirmName: "New Name" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await client.get(`/api/servers/${server.id}`)).status).toBe(404);
    const left = (await handle.db.execute(sql`select (select count(*) from metric_samples where server_id = ${server.id})::int + (select count(*) from api_keys where server_id = ${server.id})::int as n`)) as unknown as { n: number }[];
    expect(left[0]!.n).toBe(0);
    expect((await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now))).status).toBe(401);
  });

  it("rotate-key: new key works, old key gets 401 immediately", async () => {
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client);
    const r = await client.post(`/api/servers/${server.id}/rotate-key`);
    expect(r.status).toBe(200);
    const s2 = (await r.json()) as { apiKey: string; configSnippet: string };
    expect(s2.apiKey).toMatch(KEY_PATTERN);
    expect(s2.apiKey).not.toBe(setup.apiKey);
    expect(s2.configSnippet).toContain(s2.apiKey);
    const old = await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now));
    expect(old.status).toBe(401);
    expect((await old.json()).error).toBe("revoked_key");
    expect((await ingest(h.app, s2.apiKey, "metrics", metricsPayload(h.clock.now))).status).toBe(200);
  });
});

describe("first-data, detail info, health, list extras, incidents, metrics", () => {
  const h = makeHarness({ env: ENV });

  it("first-data: waiting → hello → first sample (health healthy)", async () => {
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client);
    const fd0 = firstDataResponse.parse(await (await client.get(`/api/servers/${server.id}/first-data`)).json());
    expect(fd0).toEqual({ received: false, helloAt: null, firstSampleAt: null, software: null, agentVersion: null, health: "waiting" });

    expect((await ingest(h.app, setup.apiKey, "hello", helloBody())).status).toBe(200);
    const fd1 = firstDataResponse.parse(await (await client.get(`/api/servers/${server.id}/first-data`)).json());
    expect(fd1).toMatchObject({ received: true, firstSampleAt: null, health: "waiting", agentVersion: helloBody().agentVersion });
    expect(fd1.helloAt).not.toBeNull();
    expect(fd1.software).toMatch(/^Paper /);

    await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now, 3));
    const fd2 = firstDataResponse.parse(await (await client.get(`/api/servers/${server.id}/first-data`)).json());
    expect(fd2.firstSampleAt).toBe(new Date(h.clock.now).toISOString());
    expect(fd2.health).toBe("healthy");

    const d = serverDetail.parse(await (await client.get(`/api/servers/${server.id}`)).json());
    const hello = helloBody().payload;
    expect(d.info).toMatchObject({
      minecraftVersion: hello.server.minecraftVersion,
      javaVersion: hello.jvm.javaVersion,
      viewDistance: hello.config.viewDistance,
      simulationDistance: hello.config.simulationDistance,
      heapMaxBytes: hello.jvm.heapMaxBytes,
      plugins: hello.plugins.length,
      host: { os: hello.host.os, arch: hello.host.arch, cores: hello.jvm.availableProcessors },
    });
    expect(d.latest).toMatchObject({ ts: new Date(h.clock.now).toISOString(), players: expect.any(Number) });
    expect(d.firstSeenAt).not.toBeNull();

    h.clock.now += 91_000;
    expect(serverDetail.parse(await (await client.get(`/api/servers/${server.id}`)).json()).health).toBe("offline");
  });

  it("degraded from the 5-minute medians; lagging with an open incident; topFinding skips info tips", async () => {
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client);
    await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now, 6, (s) => (s.tick.msptP95 = 45)));
    expect(serverDetail.parse(await (await client.get(`/api/servers/${server.id}`)).json()).health).toBe("degraded");

    const now = new Date(h.clock.now);
    const [inc] = await handle.db
      .insert(incidents)
      .values({ serverId: server.id, startedAt: now, severity: "high", peakMsptP95: 120, minTps1m: 17.5, trigger: "mspt", source: "raw" })
      .returning({ id: incidents.id });
    const f = (severity: string, title: string, lastSeenMs: number) => ({
      serverId: server.id, ruleId: "entity-explosion", scope: "server", dedupKey: title, severity, title,
      explanation: "e", evidence: {}, suggestedFix: "f", firstSeenAt: new Date(lastSeenMs), lastSeenAt: new Date(lastSeenMs),
    });
    const ins = await handle.db
      .insert(findings)
      .values([f("info", "tip", h.clock.now + 5000), f("medium", "older medium", h.clock.now - 5000), f("medium", "newer medium", h.clock.now), { ...f("critical", "fixed critical", h.clock.now), status: "marked_fixed" }])
      .returning({ id: findings.id, title: findings.title });
    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    const s = list.servers.find((x) => x.id === server.id)!;
    expect(s.health).toBe("lagging");
    expect(s.openIncidents).toBe(1);
    expect(s.topFinding).toEqual({ id: ins.find((x) => x.title === "newer medium")!.id, ruleId: "entity-explosion", severity: "medium", title: "newer medium" });

    const r = await client.get(`/api/servers/${server.id}/incidents`);
    const body = (await r.json()) as { incidents: unknown[] };
    expect(body.incidents.map((i) => incidentListItem.parse(i))).toEqual([
      { id: inc!.id, startedAt: now.toISOString(), endedAt: null, severity: "high", peakMsptP95: 120, minTps1m: 17.5, trigger: "mspt" },
    ]);
    const old = await client.get(`/api/servers/${server.id}/incidents?to=${new Date(h.clock.now - 86_400_000).toISOString()}`);
    expect((await old.json()).incidents).toEqual([]);
    expect((await client.get(`/api/servers/${server.id}/incidents?limit=201`)).status).toBe(400);
  });

  it("metrics + metrics/batch (session + owner)", async () => {
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client);
    await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now, 3));
    const from = new Date(h.clock.now - 3600_000).toISOString();
    const to = new Date(h.clock.now + 60_000).toISOString();
    const m = await client.get(`/api/servers/${server.id}/metrics?metric=mspt_p95&from=${from}&to=${to}`);
    expect(m.status).toBe(200);
    expect(metricsResponse.parse(await m.json()).points).toHaveLength(3);

    const b = await client.get(`/api/servers/${server.id}/metrics/batch?metrics=mspt_p95,tps_1m,players,mspt_p95&from=${from}&to=${to}`);
    expect(b.status).toBe(200);
    const series = ((await b.json()) as { series: unknown[] }).series.map((x) => metricsResponse.parse(x));
    expect(series.map((x) => x.metric)).toEqual(["mspt_p95", "tps_1m", "players"]);
    expect(series.every((x) => x.points.length === 3)).toBe(true);

    const nine = "mspt_p95,tps_1m,players,mspt_avg,mspt_p99,mspt_max,slow_ticks,ping_avg,heap_used_bytes";
    for (const q of [`metrics=${nine}&from=${from}&to=${to}`, `metrics=nope&from=${from}&to=${to}`, `metrics=players&from=${to}&to=${from}`, `metrics=players`]) {
      const r = await client.get(`/api/servers/${server.id}/metrics/batch?${q}`);
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_request");
    }
  });
});

describe("IDOR: another user's server is 404 on every route", () => {
  const h = makeHarness({ env: ENV });

  it("user B gets 404 everywhere; A's server untouched", async () => {
    const a = await verifiedUser(h);
    const { server, setup } = await newServer(h, a.client, "A's server");
    const b = await verifiedUser(h);
    const id = server.id;
    const from = new Date(h.clock.now - 3600_000).toISOString();
    const to = new Date(h.clock.now).toISOString();
    const reqs: [string, string, unknown?][] = [
      ["GET", `/api/servers/${id}`],
      ["PATCH", `/api/servers/${id}`, { name: "pwned" }],
      ["DELETE", `/api/servers/${id}`, { confirmName: "A's server" }],
      ["POST", `/api/servers/${id}/rotate-key`, {}],
      ["GET", `/api/servers/${id}/first-data`],
      ["GET", `/api/servers/${id}/incidents`],
      ["GET", `/api/servers/${id}/metrics?metric=mspt_p95&from=${from}&to=${to}`],
      ["GET", `/api/servers/${id}/metrics/batch?metrics=mspt_p95&from=${from}&to=${to}`],
      ["GET", `/api/servers/${id}/live`],
    ];
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const [method, path, body] of reqs) {
      const r = await b.client.req(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      const json = await r.json();
      expect(json).toEqual({ error: { code: "not_found", message: "Server not found" } });
      // Indistinguishable from an id that doesn't exist.
      const r2 = await b.client.req(method, path.replace(id, unknown), body);
      expect(r2.status).toBe(404);
      expect(await r2.json()).toEqual(json);
    }
    expect((await b.client.get("/api/servers")).status).toBe(200);
    expect(serverListResponse.parse(await (await b.client.get("/api/servers")).json()).servers).toEqual([]);
    const d = serverDetail.parse(await (await a.client.get(`/api/servers/${id}`)).json());
    expect(d.name).toBe("A's server");
    expect((await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now))).status).toBe(200);
  });

  it("dev admin bearer: GET only, never in production; unauthenticated → 401", async () => {
    const a = await verifiedUser(h);
    const { server } = await newServer(h, a.client);
    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };
    expect((await h.app.request(`/api/servers/${server.id}`, { headers: bearer })).status).toBe(200);
    expect((await h.app.request(`/api/servers/${server.id}/first-data`, { headers: bearer })).status).toBe(200);
    const anon = await new Client(h.app).init();
    expect((await anon.req("POST", `/api/servers/${server.id}/rotate-key`, {}, { headers: bearer })).status).toBe(401);
    expect((await anon.req("PATCH", `/api/servers/${server.id}`, { name: "x" }, { headers: bearer })).status).toBe(401);
    expect((await h.app.request(`/api/servers/${server.id}`)).status).toBe(401);
    const prod = makeHarness({ env: { ...ENV, NODE_ENV: "production" } });
    expect((await prod.app.request(`/api/servers/${server.id}`, { headers: bearer })).status).toBe(401);
  });
});

describe("live SSE", () => {
  it("status + last sample on connect, samples from ingest, status changes, offline via the 15 s check, pings", async () => {
    const h = makeHarness({ env: ENV, livePingMs: 50 });
    const { client } = await verifiedUser(h);
    const { server, setup } = await newServer(h, client);
    const ac = new AbortController();
    const res = await client.req("GET", `/api/servers/${server.id}/live`, undefined, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const sse = sseReader(res);
    expect(await sse.until((ev) => ev.length >= 1)).toBe(true);
    expect(sse.state.raw.startsWith("retry: 5000\n\n")).toBe(true);
    expect(sse.state.events[0]).toEqual({ event: "status", data: { health: "waiting", lastSeenAt: null, openIncidentId: null } });

    const body = metricsPayload(h.clock.now, 2, (s, i) => (s.tick.msptP95 = 10 + i));
    expect((await ingest(h.app, setup.apiKey, "metrics", body)).status).toBe(200);
    expect(await sse.until((ev) => ev.filter((e) => e.event === "sample").length >= 2 && ev.filter((e) => e.event === "status").length >= 2)).toBe(true);
    const samples = sse.state.events.filter((e) => e.event === "sample");
    expect(samples.map((e) => e.data.ts)).toEqual(body.payload.samples.map((s: { ts: string }) => s.ts));
    expect(Object.keys(samples[0]!.data).sort()).toEqual(
      ["ts", "tps1m", "msptAvg", "msptP95", "players", "hostCpu", "cpuTempC", "heapUsedBytes", "heapMaxBytes", "memAvailableBytes", "swapUsedBytes"].sort(),
    );
    const statuses = sse.state.events.filter((e) => e.event === "status");
    expect(statuses[1]!.data.health).toBe("healthy");

    // Same health again → no new status event; offline after > 90 s, found by the periodic check.
    await ingest(h.app, setup.apiKey, "metrics", metricsPayload(h.clock.now + 10_000));
    await sse.until((ev) => ev.filter((e) => e.event === "sample").length >= 3);
    await flush();
    expect(sse.state.events.filter((e) => e.event === "status")).toHaveLength(2);
    h.clock.now += 91_000;
    await h.hub.checkAll();
    expect(await sse.until((ev) => ev.filter((e) => e.event === "status").length >= 3)).toBe(true);
    expect(sse.state.events.filter((e) => e.event === "status")[2]!.data.health).toBe("offline");
    await h.hub.checkAll();
    await flush();
    expect(sse.state.events.filter((e) => e.event === "status")).toHaveLength(3);
    expect(await sse.until((_ev, raw) => raw.includes(": ping\n\n"), 2000)).toBe(true);

    // A new stream starts with the current status and the last stored sample.
    const res2 = await client.get(`/api/servers/${server.id}/live`);
    const sse2 = sseReader(res2);
    expect(await sse2.until((ev) => ev.length >= 2)).toBe(true);
    expect(sse2.state.events[0]!.event).toBe("status");
    expect(sse2.state.events[1]).toMatchObject({ event: "sample", data: { ts: new Date(h.clock.now - 91_000 + 10_000).toISOString() } });

    await sse.cancel();
    await sse2.cancel();
    await flush();
    expect(h.hub.subscriberCount(server.id)).toBe(0);
    expect(h.hub.openStreams()).toBe(0);
  });

  it("max 5 streams per user (6th → 429); slots come back on disconnect", async () => {
    const h = makeHarness({ env: ENV });
    const { client } = await verifiedUser(h);
    const { server } = await newServer(h, client);
    const readers = [];
    for (let i = 0; i < 5; i++) {
      const r = await client.get(`/api/servers/${server.id}/live`);
      expect(r.status).toBe(200);
      const s = sseReader(r);
      await s.until((ev) => ev.length >= 1);
      readers.push(s);
    }
    const sixth = await client.get(`/api/servers/${server.id}/live`);
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error.code).toBe("rate_limited");
    expect(sixth.headers.get("retry-after")).toBeTruthy();
    // Another user is not affected.
    const other = await verifiedUser(h);
    const { server: s2 } = await newServer(h, other.client);
    const ok = await other.client.get(`/api/servers/${s2.id}/live`);
    expect(ok.status).toBe(200);
    await sseReader(ok).cancel();

    await readers[0]!.cancel();
    await flush();
    const again = await client.get(`/api/servers/${server.id}/live`);
    expect(again.status).toBe(200);
    await sseReader(again).cancel();
    for (const r of readers.slice(1)) await r.cancel();
    await flush();
    expect(h.hub.openStreams()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Phase 5 review fixes
// ---------------------------------------------------------------------------------------------------------

/** Resolves true once the stream has ended (server closed it). */
async function ended(res: Response, timeoutMs = 3000): Promise<boolean> {
  const reader = res.body!.getReader();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      await reader.cancel().catch(() => {});
      return false;
    }
    const r = await Promise.race([reader.read(), new Promise<"t">((ok) => setTimeout(() => ok("t"), left))]);
    if (r === "t") {
      await reader.cancel().catch(() => {});
      return false;
    }
    if (r.done) return true;
  }
}

describe("M3: live streams end when access ends", () => {
  it("logout-all, logout, password change (other sessions only), server delete", async () => {
    const h = makeHarness({ env: ENV });
    const a = await verifiedUser(h);
    const { server } = await newServer(h, a.client, "Closing");
    const second = await new Client(h.app).init();
    await second.post("/api/auth/login", { email: a.email, password: PASSWORD });

    // logout (single session) ends only that session's stream
    const s1 = await second.get(`/api/servers/${server.id}/live`);
    const own = await a.client.get(`/api/servers/${server.id}/live`);
    await second.post("/api/auth/logout");
    expect(await ended(s1)).toBe(true);

    // password change ends other sessions' streams, keeps the caller's
    const third = await new Client(h.app).init();
    await third.post("/api/auth/login", { email: a.email, password: PASSWORD });
    const s3 = await third.get(`/api/servers/${server.id}/live`);
    expect((await a.client.post("/api/account/password", { currentPassword: PASSWORD, newPassword: "password two!!" })).status).toBe(200);
    expect(await ended(s3)).toBe(true);
    expect(h.hub.subscriberCount(server.id)).toBe(1); // `own` still open

    // server delete ends its streams (no "waiting" fallback)
    const ownReader = sseReader(own);
    await ownReader.until((ev) => ev.length >= 1);
    await a.client.req("DELETE", `/api/servers/${server.id}`, { confirmName: "Closing" });
    await flush();
    expect(h.hub.subscriberCount(server.id)).toBe(0);
    expect(ownReader.state.events.filter((e) => e.event === "status")).toHaveLength(1);
    await ownReader.cancel();

    // logout-all ends every stream of the user
    const b = await verifiedUser(h);
    const { server: s2 } = await newServer(h, b.client, "Other");
    const r = await b.client.get(`/api/servers/${s2.id}/live`);
    await b.client.post("/api/auth/logout-all");
    expect(await ended(r)).toBe(true);
    await flush();
    expect(h.hub.openStreams()).toBe(0);
  });

  it("password reset ends all the user's streams", async () => {
    const h = makeHarness({ env: ENV });
    const a = await verifiedUser(h);
    const { server } = await newServer(h, a.client);
    const res = await a.client.get(`/api/servers/${server.id}/live`);
    const c = await new Client(h.app).init();
    await c.post("/api/auth/forgot-password", { email: a.email });
    await flush();
    const token = (/token=([A-Za-z0-9_-]+)/.exec(h.mailer.last(a.email)!.text) ?? [])[1]!;
    expect((await c.post("/api/auth/reset-password", { token, password: "reset password!!" })).status).toBe(200);
    expect(await ended(res)).toBe(true);
  });

  it("the 15 s check closes streams after a transfer (CLI process) or a session that vanished", async () => {
    const h = makeHarness({ env: ENV });
    const a = await verifiedUser(h);
    const b = await verifiedUser(h);
    const { server } = await newServer(h, a.client);
    const res = await a.client.get(`/api/servers/${server.id}/live`);
    await handle.db.execute(sql`update servers set owner_id = ${b.id} where id = ${server.id}`);
    await h.hub.checkAll();
    expect(await ended(res)).toBe(true);
    expect(h.hub.subscriberCount(server.id)).toBe(0);

    const c = await verifiedUser(h);
    const { server: s2 } = await newServer(h, c.client);
    const r2 = await c.client.get(`/api/servers/${s2.id}/live`);
    await handle.db.execute(sql`delete from sessions where user_id = ${c.id}`);
    await h.hub.checkAll();
    expect(await ended(r2)).toBe(true);
    expect(h.hub.openStreams()).toBe(0);
  });
});

describe("M4: status baseline is per subscriber", () => {
  it("a second viewer connecting doesn't make the first one miss a transition", async () => {
    const h = makeHarness({ env: ENV });
    const a = await verifiedUser(h);
    const { server } = await newServer(h, a.client);
    const first = sseReader(await a.client.get(`/api/servers/${server.id}/live`));
    expect(await first.until((ev) => ev.length >= 1)).toBe(true);
    expect(first.state.events[0]!.data.health).toBe("waiting");

    // Data arrives without a live publish (e.g. another API instance / backfill): nobody has been told yet.
    const ts = new Date(h.clock.now);
    await handle.db.execute(sql`insert into metric_samples (server_id, ts, tps_1m, mspt_p95, detail) values (${server.id}, ${ts.toISOString()}::timestamptz, 20, 10, '{}'::jsonb)`);
    await handle.db.execute(sql`update servers set first_sample_at = ${ts.toISOString()}::timestamptz, last_sample_at = ${ts.toISOString()}::timestamptz where id = ${server.id}`);

    const second = sseReader(await a.client.get(`/api/servers/${server.id}/live`));
    expect(await second.until((ev) => ev.length >= 1)).toBe(true);
    expect(second.state.events[0]!.data.health).toBe("healthy");

    await h.hub.checkAll();
    expect(await first.until((ev) => ev.filter((e) => e.event === "status").length >= 2)).toBe(true);
    expect(first.state.events.filter((e) => e.event === "status")[1]!.data.health).toBe("healthy");
    await flush();
    expect(second.state.events.filter((e) => e.event === "status")).toHaveLength(1);
    await first.cancel();
    await second.cancel();
  });
});

describe("plan limit race", () => {
  it("two parallel creates for the last slot → exactly one 201 and one 402", async () => {
    const h = makeHarness({ env: ENV });
    const { client, id } = await verifiedUser(h);
    const res = await Promise.all([client.post("/api/servers", { name: "One" }), client.post("/api/servers", { name: "Two" })]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 402]);
    const n = (await handle.db.execute(sql`select count(*)::int as n from servers where owner_id = ${id}`)) as unknown as { n: number }[];
    expect(n[0]!.n).toBe(1);
  });
});
