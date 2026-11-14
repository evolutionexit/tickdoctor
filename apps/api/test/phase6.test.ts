import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createdServerResponse,
  findingDetailResponse,
  findingsListResponse,
  incidentDetail,
  incidentListItemV6,
  serverListResponse,
  type Baseline,
} from "@tickdoctor/shared";
import { events, findingIncidents, findings, incidentSnapshots, incidents, serverInfoHistory } from "../src/db/schema.js";
import { recheckFindings } from "../src/findings/lifecycle.js";
import { Client, freshEmail, makeHarness, verifiedUser, type Harness } from "./app-helpers.js";
import { WEB_ORIGIN, fixture, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);

const MIN = 60_000;
const MB = 1_048_576;

/** Pro by default (plan gating has its own tests in phase6-gating.test.ts); pass plan "free" for a locked server. */
async function newServer(h: Harness, client: Client, name = "Pi Survival", plan = "pro") {
  const res = await client.post("/api/servers", { name });
  expect(res.status).toBe(201);
  const server = createdServerResponse.parse(await res.json()).server;
  await handle.db.execute(sql`update servers set plan = ${plan} where id = ${server.id}`);
  return server;
}

let dedup = 0;
function findingRow(serverId: string, severity: string, title: string, over: Record<string, unknown> = {}) {
  const t = new Date(Date.now() - 60_000);
  return {
    serverId, ruleId: "entity-explosion", scope: "incident", dedupKey: `${title}-${++dedup}`, severity, title,
    explanation: "e", evidence: { numbers: [] }, suggestedFix: "f", firstSeenAt: t, lastSeenAt: t, ...over,
  };
}

async function insertFindings(serverId: string, rows: ReturnType<typeof findingRow>[], incidentId?: string) {
  const ins = await handle.db.insert(findings).values(rows).returning({ id: findings.id, title: findings.title });
  if (incidentId) await handle.db.insert(findingIncidents).values(ins.map((f) => ({ findingId: f.id, incidentId })));
  const byTitle = (t: string) => ins.find((x) => x.title === t)!.id;
  return byTitle;
}

async function insertIncident(serverId: string, over: Partial<typeof incidents.$inferInsert> = {}) {
  const [i] = await handle.db
    .insert(incidents)
    .values({ serverId, startedAt: new Date(Date.now() - 20 * MIN), severity: "high", peakMsptP95: 140, minTps1m: 14, trigger: "mspt", source: "raw", ...over })
    .returning({ id: incidents.id });
  return i!.id;
}

describe("incident list v6: findingCount, topFindingTitle (no tips), status filter", () => {
  const h = makeHarness();
  it("counts only non-tip findings, top title by impact; status=open|closed", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const closedId = await insertIncident(server.id, { startedAt: new Date(Date.now() - 3 * 3_600_000), endedAt: new Date(Date.now() - 2 * 3_600_000), endReason: "recovered" });
    const openId = await insertIncident(server.id);
    await insertFindings(server.id, [findingRow(server.id, "info", "A tip (info)"), findingRow(server.id, "medium", "Medium cause"), findingRow(server.id, "high", "High cause")], openId);
    await insertFindings(server.id, [findingRow(server.id, "info", "Only a tip")], closedId);

    const all = (await (await client.get(`/api/servers/${server.id}/incidents`)).json()).incidents.map((i: unknown) => incidentListItemV6.parse(i));
    expect(all.map((i: { id: string }) => i.id)).toEqual([openId, closedId]);
    expect(all[0]).toMatchObject({ findingCount: 2, topFindingTitle: "High cause" });
    expect(all[1]).toMatchObject({ findingCount: 0, topFindingTitle: null });
    const open = (await (await client.get(`/api/servers/${server.id}/incidents?status=open`)).json()).incidents;
    expect(open.map((i: { id: string }) => i.id)).toEqual([openId]);
    const closed = (await (await client.get(`/api/servers/${server.id}/incidents?status=closed`)).json()).incidents;
    expect(closed.map((i: { id: string }) => i.id)).toEqual([closedId]);
    expect((await client.get(`/api/servers/${server.id}/incidents?status=nope`)).status).toBe(400);
  });

  it("server card topFinding never shows a tip, even an open one of higher rank than nothing", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    await insertFindings(server.id, [findingRow(server.id, "info", "tip only", { scope: "server", ruleId: "jvm-flags" })]);
    const list = serverListResponse.parse(await (await client.get("/api/servers")).json());
    expect(list.servers.find((s) => s.id === server.id)!.topFinding).toBeNull();
  });
});

describe("GET /api/incidents/:id", () => {
  const h = makeHarness();

  it("full detail: snapshot (worlds, worst chunks + top types), what changed, non-tip findings in impact order, timeline", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const start = Date.now() - 20 * MIN;
    const end = start + 10 * MIN;
    const base: Baseline = {
      from: new Date(start - 5 * 3_600_000).toISOString(),
      to: new Date(start - 15 * MIN).toISOString(),
      healthyMinutes: 240,
      metrics: { mspt_p95: { median: 20, p90: 25 }, tps_1m: { median: 20, p90: 20 }, heap_used_bytes: { median: 1024 * MB, p90: 1100 * MB } },
      entitiesByType: { "minecraft:item": 100 },
      tileEntitiesByType: { "minecraft:hopper": 300 },
      worlds: [{ name: "world", loadedChunks: 400, entities: 800, tileEntities: 300 }],
      plugins: [{ name: "Essentials", version: "2.20" }],
      config: { viewDistance: 8, simulationDistance: 6 },
      jvm: { heapMaxBytes: 4096 * MB, heapInitBytes: 4096 * MB },
    };
    const id = await insertIncident(server.id, {
      startedAt: new Date(start), endedAt: new Date(end), endReason: "recovered", baseline: base, severity: "critical", peakMsptP95: 300, minTps1m: 8, initialSeverity: "high",
    });
    // Raw samples during the incident.
    for (let t = start + 10_000, k = 0; t <= end; t += 60_000, k++) {
      await handle.db.execute(sql`insert into metric_samples (server_id, ts, mspt_p95, tps_1m, heap_used_bytes, detail)
        values (${server.id}, ${new Date(t).toISOString()}::timestamptz, ${k % 2 ? 100 : 120}, ${k === 3 ? 8 : 15}, ${2048 * MB}, '{}'::jsonb)`);
    }
    const snap = fixture("snapshot").payload;
    snap.worldsDetail = [
      {
        name: "world",
        entitiesByType: { "minecraft:item": 2600, "minecraft:cow": 20 },
        tileEntitiesByType: { "minecraft:hopper": 320 },
        topChunks: [
          { x: 3, z: -7, entities: 1500, tileEntities: 10, byType: { "minecraft:item": 1450, "minecraft:cow": 20, a: 5, b: 4, c: 3, d: 2 } },
          { x: 0, z: 0, entities: 10, tileEntities: 300, byType: { "minecraft:hopper": 300 } },
        ],
      },
      { name: "world_nether", entitiesByType: {}, tileEntitiesByType: {}, topChunks: [{ x: 1, z: 1, entities: 2000, tileEntities: 0, byType: {} }] },
    ];
    snap.sample.world = [{ name: "world", loadedChunks: 1300, entities: 2620, entitiesByType: {}, tileEntitiesByType: {}, countsAgeSeconds: 1 }];
    snap.sample.players = { count: 6, pingAvg: 40 };
    await handle.db.insert(incidentSnapshots).values({
      serverId: server.id, incidentId: id, trigger: "threshold", capturedAt: new Date(start + 20_000), msptP95AtTrigger: 160, snapshot: snap,
    });
    const hello = fixture("hello").payload;
    const info1 = { ...hello, plugins: [{ name: "Essentials", version: "2.20", enabled: true }], config: { ...hello.config, viewDistance: 8 } };
    const info2 = { ...hello, plugins: [{ name: "Essentials", version: "2.21", enabled: true }, { name: "Lagger", version: "1.0", enabled: true }], config: { ...hello.config, viewDistance: 12 } };
    await handle.db.insert(serverInfoHistory).values([
      { serverId: server.id, validFrom: new Date(start - 3 * 3_600_000), validTo: new Date(start - 10 * MIN), info: info1, infoHash: "a" },
      { serverId: server.id, validFrom: new Date(start - 10 * MIN), info: info2, infoHash: "b" },
    ]);
    await handle.db.insert(events).values([
      { serverId: server.id, ts: new Date(start - 11 * MIN), type: "server_start", data: { uncleanPreviousShutdown: true }, eventHash: `h1-${id}` },
      { serverId: server.id, ts: new Date(start - 12 * MIN), type: "crash", data: {}, eventHash: `h2-${id}` },
      { serverId: server.id, ts: new Date(start - 2 * 3_600_000), type: "server_start", data: { uncleanPreviousShutdown: false }, eventHash: `h3-${id}` }, // before the window
    ]);
    const byTitle = await insertFindings(
      server.id,
      [
        findingRow(server.id, "info", "Xms and Xmx differ", { ruleId: "jvm-flags" }),
        findingRow(server.id, "medium", "Medium open"),
        findingRow(server.id, "critical", "Critical but marked fixed", { status: "marked_fixed", markedFixedAt: new Date() }),
        findingRow(server.id, "critical", "Critical open"),
      ],
      id,
    );

    const res = await client.get(`/api/incidents/${id}`);
    expect(res.status).toBe(200);
    const d = incidentDetail.parse(await res.json());
    expect(d.incident).toMatchObject({ id, serverId: server.id, severity: "critical", endReason: "recovered", source: "raw", durationSeconds: 600, findingCount: 3, topFindingTitle: "Critical open" });
    expect(d.findings.map((f) => f.title)).toEqual(["Critical open", "Critical but marked fixed", "Medium open"]);
    expect(d.findings.some((f) => f.id === byTitle("Xms and Xmx differ"))).toBe(false); // tips never among causes

    expect(d.snapshot).toMatchObject({ trigger: "threshold", msptP95AtTrigger: 160, players: 6 });
    expect(d.snapshot!.worlds.find((w) => w.name === "world")).toEqual({ name: "world", loadedChunks: 1300, entities: 2620, tileEntities: 320 });
    expect(d.snapshot!.worlds.find((w) => w.name === "world_nether")).toMatchObject({ loadedChunks: null });
    expect(d.snapshot!.worstChunks!.map((c) => [c.world, c.x, c.z])).toEqual([["world_nether", 1, 1], ["world", 3, -7], ["world", 0, 0]]);
    expect(d.snapshot!.worstChunks![1]!.topTypes).toEqual([
      { type: "minecraft:item", count: 1450 }, { type: "minecraft:cow", count: 20 }, { type: "a", count: 5 }, { type: "b", count: 4 }, { type: "c", count: 3 },
    ]);

    const w = d.whatChanged!;
    expect(w).toMatchObject({ baselineAvailable: true, healthyMinutes: 240 });
    const it = (kind: string, key: string) => w.items.find((i) => i.kind === kind && i.key === key);
    expect(it("metric", "mspt_p95")).toMatchObject({ usual: 20, notable: true });
    expect(it("metric", "tps_1m")).toMatchObject({ during: 8, usual: 20, change: "down", notable: true });
    expect(it("metric", "heap_used_bytes")).toMatchObject({ during: 2048, usual: 1024, unit: "MB" });
    expect(it("entityType", "minecraft:item")).toMatchObject({ during: 2600, usual: 100, notable: true });
    expect(it("tileEntityType", "minecraft:hopper")).toMatchObject({ during: 320, usual: 300, notable: false });
    expect(it("world", "world:loaded_chunks")).toMatchObject({ during: 1300, usual: 400, notable: true });
    expect(it("plugin", "Essentials")).toMatchObject({ change: "updated", usual: "2.20", during: "2.21" });
    expect(it("plugin", "Lagger")).toMatchObject({ change: "added" });
    expect(it("config", "view_distance")).toMatchObject({ usual: 8, during: 12 });
    const firstPlain = w.items.findIndex((i) => !i.notable);
    expect(firstPlain).toBeGreaterThan(0);
    expect(w.items.slice(firstPlain).every((i) => !i.notable)).toBe(true); // notable first

    const kinds = d.timeline.map((e) => e.kind);
    expect(kinds).toEqual(["crash", "server_start", "plugin_updated", "plugin_added", "config_changed", "incident_opened", "snapshot", "incident_closed"]);
    expect(d.timeline.find((e) => e.kind === "plugin_updated")!.label).toBe("Plugin Essentials updated 2.20 → 2.21.");
    expect(d.timeline.find((e) => e.kind === "config_changed")!.label).toBe("View distance changed from 8 to 12.");
    expect(d.timeline.find((e) => e.kind === "snapshot")!.label).toBe("Snapshot saved (6 players online).");
    expect(d.timeline.find((e) => e.kind === "incident_closed")!.label).toBe("Back to normal after 10 min.");
    expect(d.timeline.find((e) => e.kind === "server_start")!.label).toContain("wasn't shut down cleanly");
    const ts = d.timeline.map((e) => Date.parse(e.ts));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // No player names anywhere (none are stored); no IP-ish strings.
    expect(JSON.stringify(d)).not.toMatch(/playerId|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("no baseline, rollup-only, no snapshot, ongoing: absolute values + plugin history; durationSeconds to now", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const start = Date.now() - 3 * 86_400_000; // raw retention gone: rollups only
    const id = await insertIncident(server.id, { startedAt: new Date(start), source: "rollup_1m", baseline: null });
    for (let k = 0; k < 5; k++) {
      await handle.db.execute(sql`insert into metric_rollups_1m (server_id, bucket, sample_count, mspt_p95_avg, tps_1m_avg, tps_1m_min)
        values (${server.id}, ${new Date(Math.floor(start / MIN) * MIN + k * MIN).toISOString()}::timestamptz, 6, ${60 + k * 10}, 17, ${16 - k})`);
    }
    await handle.db.execute(sql`insert into plugin_inventory_history (server_id, plugin, version, first_seen, last_seen) values
      (${server.id}, 'Essentials', '2.20', ${new Date(start - 10 * 86_400_000).toISOString()}::timestamptz, now()),
      (${server.id}, 'Essentials', '2.21', ${new Date(start - 3_600_000).toISOString()}::timestamptz, now()),
      (${server.id}, 'Fresh', '0.1', ${new Date(start - 7_200_000).toISOString()}::timestamptz, now()),
      (${server.id}, 'Old', '1.0', ${new Date(start - 5 * 86_400_000).toISOString()}::timestamptz, now())`);
    const d = incidentDetail.parse(await (await client.get(`/api/incidents/${id}`)).json());
    expect(d.snapshot).toBeNull();
    expect(d.incident).toMatchObject({ source: "rollup_1m", endedAt: null, endReason: null });
    expect(d.incident.durationSeconds).toBeGreaterThanOrEqual(3 * 86_400 - 5);
    expect(d.whatChanged).toMatchObject({ baselineAvailable: false, baselineFrom: null });
    const tps = d.whatChanged!.items.find((i) => i.key === "tps_1m")!;
    expect(tps).toMatchObject({ during: 12, usual: null, notable: false }); // min of the buckets' minimums
    expect(d.whatChanged!.items.find((i) => i.key === "mspt_p95")!.during).toBe(80);
    const plugins = d.whatChanged!.items.filter((i) => i.kind === "plugin");
    expect(plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "Essentials", change: "updated", usual: "2.20", during: "2.21" }),
        expect.objectContaining({ key: "Fresh", change: "added" }),
      ]),
    );
    expect(plugins).toHaveLength(2);
    expect(d.timeline.map((e) => e.kind)).toEqual(["incident_opened"]);
    expect(d.timeline[0]!.label).toBe("Lag started. Slowest ticks passed 50 ms.");
  });

  it("no snapshot: per-type and per-world values from raw sample detail (one row per minute)", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const start = Math.floor((Date.now() - 30 * MIN) / MIN) * MIN;
    const id = await insertIncident(server.id, { startedAt: new Date(start), endedAt: new Date(start + 5 * MIN), endReason: "recovered", baseline: null });
    // 6 samples per minute; the first of each minute carries 900 items, the others 0: only one per minute is read.
    for (let k = 0; k < 30; k++) {
      const t = start + k * 10_000;
      const items = k % 6 === 0 ? 900 : 0;
      const world = [{ name: "world", loadedChunks: 300, entities: items + 10, entitiesByType: { "minecraft:item": items }, tileEntitiesByType: {}, countsAgeSeconds: 1 }];
      await handle.db.execute(sql`insert into metric_samples (server_id, ts, mspt_p95, detail)
        values (${server.id}, ${new Date(t).toISOString()}::timestamptz, 80, ${JSON.stringify({ world })}::jsonb)`);
    }
    const d = incidentDetail.parse(await (await client.get(`/api/incidents/${id}`)).json());
    expect(d.snapshot).toBeNull();
    expect(d.whatChanged!.items.find((i) => i.kind === "entityType" && i.key === "minecraft:item")).toMatchObject({ during: 900, label: "Dropped items" });
    expect(d.whatChanged!.items.find((i) => i.key === "world:loaded_chunks")).toMatchObject({ during: 300 });
  });

  it("another user's incident, unknown and malformed ids → 404; anonymous → 401", async () => {
    const a = await verifiedUser(h);
    const b = await verifiedUser(h);
    const server = await newServer(h, a.client);
    const id = await insertIncident(server.id);
    expect((await a.client.get(`/api/incidents/${id}`)).status).toBe(200);
    for (const path of [`/api/incidents/${id}`, "/api/incidents/00000000-0000-4000-8000-000000000000", "/api/incidents/nope"]) {
      const r = await b.client.get(path);
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe("not_found");
    }
    expect((await (await new Client(h.app).init()).get(`/api/incidents/${id}`)).status).toBe(401);
  });
});

describe("findings API", () => {
  const h = makeHarness();

  it("list: default active, tips separate (status filter only), severity minimum, ruleId, impact order", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const incId = await insertIncident(server.id);
    await insertFindings(
      server.id,
      [
        findingRow(server.id, "info", "Tip open", { ruleId: "jvm-flags", scope: "server" }),
        findingRow(server.id, "info", "Tip fixed", { ruleId: "jvm-flags", scope: "server", status: "confirmed_fixed", confirmedFixedAt: new Date(), resolvedBy: "auto" }),
        findingRow(server.id, "low", "Low open", { ruleId: "swap-in-use" }),
        findingRow(server.id, "high", "High marked", { status: "marked_fixed", markedFixedAt: new Date() }),
        findingRow(server.id, "high", "High open"),
        findingRow(server.id, "critical", "Critical gone", { status: "confirmed_fixed", confirmedFixedAt: new Date(), resolvedBy: "owner" }),
      ],
      incId,
    );
    const get = async (q = "") => findingsListResponse.parse(await (await client.get(`/api/servers/${server.id}/findings${q}`)).json());
    const def = await get();
    expect(def.findings.map((f) => f.title)).toEqual(["High open", "High marked", "Low open"]);
    expect(def.tuningTips.map((f) => f.title)).toEqual(["Tip open"]);
    expect(def.findings[0]!.incidentIds).toEqual([incId]);
    expect((await get("?status=all")).findings.map((f) => f.title)).toEqual(["Critical gone", "High open", "High marked", "Low open"]);
    expect((await get("?status=all")).tuningTips.map((f) => f.title).sort()).toEqual(["Tip fixed", "Tip open"]);
    expect((await get("?status=confirmed_fixed")).findings.map((f) => f.title)).toEqual(["Critical gone"]);
    expect((await get("?status=marked_fixed")).findings.map((f) => f.title)).toEqual(["High marked"]);
    expect((await get("?severity=high")).findings.map((f) => f.title)).toEqual(["High open", "High marked"]);
    const byRule = await get("?ruleId=swap-in-use&severity=low");
    expect(byRule.findings.map((f) => f.title)).toEqual(["Low open"]);
    expect(byRule.tuningTips.map((f) => f.title)).toEqual(["Tip open"]); // other filters ignored for tips
    for (const q of ["?status=nope", "?severity=huge", "?ruleId=nope"]) expect((await client.get(`/api/servers/${server.id}/findings${q}`)).status).toBe(400);
  });

  it("detail: finding + linked incidents newest first", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const older = await insertIncident(server.id, { startedAt: new Date(Date.now() - 5 * 3_600_000), endedAt: new Date(Date.now() - 4 * 3_600_000), endReason: "recovered" });
    const newer = await insertIncident(server.id);
    const byTitle = await insertFindings(server.id, [findingRow(server.id, "high", "Linked twice")], older);
    await handle.db.insert(findingIncidents).values({ findingId: byTitle("Linked twice"), incidentId: newer });
    const d = findingDetailResponse.parse(await (await client.get(`/api/findings/${byTitle("Linked twice")}`)).json());
    expect(d.finding.title).toBe("Linked twice");
    expect(d.incidents.map((i) => i.id)).toEqual([newer, older]);
  });

  it("PATCH state machine: open → marked_fixed → open (undo); 409 otherwise; recheck job still confirms", async () => {
    const { client } = await verifiedUser(h);
    const server = await newServer(h, client);
    const byTitle = await insertFindings(server.id, [
      findingRow(server.id, "high", "Fix me"),
      findingRow(server.id, "high", "Done", { status: "confirmed_fixed", confirmedFixedAt: new Date(), resolvedBy: "owner" }),
      findingRow(server.id, "info", "Tip", { ruleId: "jvm-flags", scope: "server" }),
    ]);
    const id = byTitle("Fix me");
    const patch = (fid: string, status: unknown) => client.req("PATCH", `/api/findings/${fid}`, { status });

    expect((await patch(id, "open")).status).toBe(409); // undo only from marked_fixed
    const m = await patch(id, "marked_fixed");
    expect(m.status).toBe(200);
    const mf = (await m.json()).finding;
    expect(mf).toMatchObject({ id, status: "marked_fixed" });
    expect(mf.markedFixedAt).toBe(new Date(h.clock.now).toISOString());
    const again = await patch(id, "marked_fixed");
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("conflict");
    const u = await patch(id, "open");
    expect(u.status).toBe(200);
    expect((await u.json()).finding).toMatchObject({ status: "open", markedFixedAt: null });
    for (const s of ["marked_fixed", "open"]) expect((await patch(byTitle("Done"), s)).status).toBe(409);
    expect((await patch(id, "confirmed_fixed")).status).toBe(400);
    expect((await patch(byTitle("Tip"), "marked_fixed")).status).toBe(200); // tips can be marked fixed too

    // The Phase 4 recheck job confirms a finding marked through the API (incident scope, short window via cfg).
    expect((await patch(id, "marked_fixed")).status).toBe(200);
    await handle.db.execute(sql`update findings set marked_fixed_at = now() - interval '3 hours', last_seen_at = now() - interval '4 hours' where id = ${id}`);
    for (let k = 0; k < 2; k++) {
      await handle.db.execute(sql`insert into metric_samples (server_id, ts, detail) values (${server.id}, now() - ${`${k === 0 ? 150 : 30} minutes`}::interval, '{}'::jsonb)`);
    }
    const r = await recheckFindings(handle.db, { incidentHours: 1, serverMinutes: 15 }, Date.now());
    expect(r.confirmedOwner).toContain(id);
  });

  it("IDOR: another user's finding (GET, PATCH) and server findings list → 404; CSRF needed for PATCH", async () => {
    const a = await verifiedUser(h);
    const b = await verifiedUser(h);
    const server = await newServer(h, a.client);
    const byTitle = await insertFindings(server.id, [findingRow(server.id, "high", "Mine")]);
    const id = byTitle("Mine");
    expect((await b.client.get(`/api/findings/${id}`)).status).toBe(404);
    expect((await b.client.req("PATCH", `/api/findings/${id}`, { status: "marked_fixed" })).status).toBe(404);
    expect((await b.client.get(`/api/servers/${server.id}/findings`)).status).toBe(404);
    expect((await b.client.get("/api/findings/nope")).status).toBe(404);
    const noCsrf = await a.client.req("PATCH", `/api/findings/${id}`, { status: "marked_fixed" }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    const evil = await a.client.req("PATCH", `/api/findings/${id}`, { status: "marked_fixed" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const [row] = (await handle.db.execute(sql`select status from findings where id = ${id}`)) as unknown as { status: string }[];
    expect(row!.status).toBe("open");
    expect((await (await new Client(h.app).init()).get(`/api/findings/${id}`)).status).toBe(401);
    void WEB_ORIGIN;
    void freshEmail;
  });
});
