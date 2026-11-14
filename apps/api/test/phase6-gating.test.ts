import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createdServerResponse, findingDetailResponse, findingsListResponse, incidentDetail } from "@tickdoctor/shared";
import { findingIncidents, findings, incidentSnapshots, incidents, serverInfoHistory } from "../src/db/schema.js";
import { configureLimits } from "../src/limits.js";
import { fixture, handle, resetStorage } from "./helpers.js";
import { makeHarness, verifiedUser, type Client } from "./app-helpers.js";

// F-04: plans.findings is enforced server-side. Free ("basic") gets title/severity/time; the why is OMITTED from the
// JSON (asserted on the raw text, not just flags). Tuning tips stay full. Pro and beta see everything.

afterAll(() => handle.close());
beforeAll(resetStorage);
afterEach(() => configureLimits({ betaAllPro: false }));

const MIN = 60_000;
const LOCKED_RE = /WHY-TEXT|EVIDENCE-LABEL|FIX-TEXT|dedup-secret|Lagger|view_distance|minecraft:item|"worstChunks"|"whatChanged"|"explanation"|"evidence"|"suggestedFix"|"dedupKey"/;

async function setup(h: ReturnType<typeof makeHarness>, plan: "free" | "pro") {
  const { client, id: userId } = await verifiedUser(h);
  const res = await client.post("/api/servers", { name: "Gate Test" });
  const server = createdServerResponse.parse(await res.json()).server;
  await handle.db.execute(sql`update servers set plan = ${plan} where id = ${server.id}`);
  const start = Date.now() - 20 * MIN;
  const [inc] = await handle.db
    .insert(incidents)
    .values({
      serverId: server.id, startedAt: new Date(start), endedAt: new Date(start + 10 * MIN), endReason: "recovered", severity: "high", peakMsptP95: 140,
      minTps1m: 14, trigger: "mspt", source: "raw",
      baseline: { from: new Date(start - 5 * 3_600_000).toISOString(), to: new Date(start - 15 * MIN).toISOString(), healthyMinutes: 240, metrics: { mspt_p95: { median: 20, p90: 25 } }, entitiesByType: { "minecraft:item": 100 }, tileEntitiesByType: {}, worlds: [], plugins: [] },
    })
    .returning({ id: incidents.id });
  const snap = fixture("snapshot").payload;
  snap.worldsDetail = [{ name: "world", entitiesByType: { "minecraft:item": 2600 }, tileEntitiesByType: {}, topChunks: [{ x: 3, z: -7, entities: 1500, tileEntities: 0, byType: { "minecraft:item": 1500 } }] }];
  await handle.db.insert(incidentSnapshots).values({ serverId: server.id, incidentId: inc!.id, trigger: "threshold", capturedAt: new Date(start + 20_000), msptP95AtTrigger: 160, snapshot: snap });
  const hello = fixture("hello").payload;
  await handle.db.insert(serverInfoHistory).values([
    { serverId: server.id, validFrom: new Date(start - 3 * 3_600_000), validTo: new Date(start - 10 * MIN), info: { ...hello, plugins: [] }, infoHash: "a" },
    { serverId: server.id, validFrom: new Date(start - 10 * MIN), info: { ...hello, plugins: [{ name: "Lagger", version: "1.0", enabled: true }], config: { ...hello.config, viewDistance: 12 } }, infoHash: "b" },
  ]);
  const t = new Date(Date.now() - 60_000);
  const base = { serverId: server.id, ruleId: "entity-explosion", scope: "incident", firstSeenAt: t, lastSeenAt: t };
  const ins = await handle.db
    .insert(findings)
    .values([
      { ...base, dedupKey: "dedup-secret", severity: "high", title: "Too many items", explanation: "WHY-TEXT", evidence: { numbers: [{ label: "EVIDENCE-LABEL", value: 1 }], chunks: [{ world: "world", x: 3, z: -7 }] }, suggestedFix: "FIX-TEXT" },
      { ...base, ruleId: "jvm-flags", scope: "server", dedupKey: "xms", severity: "info", title: "A tuning tip", explanation: "TIPWHY", evidence: { numbers: [] }, suggestedFix: "TIPFIX" },
    ])
    .returning({ id: findings.id, title: findings.title });
  await handle.db.insert(findingIncidents).values(ins.map((f) => ({ findingId: f.id, incidentId: inc!.id })));
  return { client, userId, serverId: server.id, incidentId: inc!.id, causeId: ins.find((f) => f.title === "Too many items")!.id, tipId: ins.find((f) => f.title === "A tuning tip")!.id };
}

const text = async (client: Client, path: string) => (await client.get(path)).text();

describe("findings gating: Free", () => {
  const h = makeHarness();

  it("list: cause has title/severity/time, NO explanation/evidence/fix/dedupKey in the JSON; tips stay full", async () => {
    const s = await setup(h, "free");
    const raw = await text(s.client, `/api/servers/${s.serverId}/findings`);
    const body = findingsListResponse.parse(JSON.parse(raw));
    expect(body.findings).toHaveLength(1);
    const f = body.findings[0]!;
    expect(f).toMatchObject({ title: "Too many items", severity: "high", status: "open", locked: true, lockedReason: "plan" });
    expect(f.lastSeenAt).toBeTruthy();
    for (const k of ["explanation", "evidence", "suggestedFix", "dedupKey"]) expect(Object.keys(f)).not.toContain(k);
    expect(raw).not.toMatch(/WHY-TEXT|EVIDENCE-LABEL|FIX-TEXT|dedup-secret/);
    expect(body.tuningTips[0]).toMatchObject({ title: "A tuning tip", explanation: "TIPWHY", suggestedFix: "TIPFIX" });
    expect(body.tuningTips[0]!.locked).toBeUndefined();
  });

  it("finding detail: locked cause omitted fields; a tip's detail is full", async () => {
    const s = await setup(h, "free");
    const raw = await text(s.client, `/api/findings/${s.causeId}`);
    const d = findingDetailResponse.parse(JSON.parse(raw));
    expect(d.finding).toMatchObject({ locked: true, lockedReason: "plan", title: "Too many items" });
    expect(d.incidents).toHaveLength(1);
    expect(raw).not.toMatch(/WHY-TEXT|EVIDENCE-LABEL|FIX-TEXT|dedup-secret|"chunks"/);
    const tip = findingDetailResponse.parse(await (await s.client.get(`/api/findings/${s.tipId}`)).json());
    expect(tip.finding).toMatchObject({ explanation: "TIPWHY", suggestedFix: "TIPFIX" });
    expect(tip.finding.locked).toBeUndefined();
  });

  it("incident detail: locked, no whatChanged / worstChunks / plugin+config timeline entries; findings locked", async () => {
    const s = await setup(h, "free");
    const raw = await text(s.client, `/api/incidents/${s.incidentId}`);
    const d = incidentDetail.parse(JSON.parse(raw));
    expect(d).toMatchObject({ locked: true, lockedReason: "plan" });
    expect(d.incident).toMatchObject({ severity: "high", findingCount: 1, topFindingTitle: "Too many items" });
    expect(d.whatChanged).toBeUndefined();
    expect(d.snapshot).not.toBeNull();
    expect(d.snapshot!.worstChunks).toBeUndefined();
    expect(d.findings.map((f) => [f.title, f.locked])).toEqual([["Too many items", true]]);
    const kinds = d.timeline.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["incident_opened", "snapshot", "incident_closed"]));
    expect(kinds.some((k) => k.startsWith("plugin_") || k === "config_changed")).toBe(false);
    expect(raw).not.toMatch(LOCKED_RE);
  });

  it("PATCH mark fixed / undo still works; the response stays locked", async () => {
    const s = await setup(h, "free");
    const res = await s.client.req("PATCH", `/api/findings/${s.causeId}`, { status: "marked_fixed" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw).finding).toMatchObject({ status: "marked_fixed", locked: true });
    expect(raw).not.toMatch(/WHY-TEXT|FIX-TEXT|dedup-secret/);
    expect((await s.client.req("PATCH", `/api/findings/${s.causeId}`, { status: "open" })).status).toBe(200);
  });

  it("the GDPR export keeps the full data", async () => {
    const s = await setup(h, "free");
    const raw = await text(s.client, "/api/account/export");
    expect(raw).toContain("WHY-TEXT");
    expect(raw).toContain("FIX-TEXT");
    expect(raw).toContain("EVIDENCE-LABEL");
  });
});

describe("findings gating: Pro and beta", () => {
  const h = makeHarness();

  it("Pro server: everything, nothing flagged locked", async () => {
    const s = await setup(h, "pro");
    const list = findingsListResponse.parse(await (await s.client.get(`/api/servers/${s.serverId}/findings`)).json());
    expect(list.findings[0]).toMatchObject({ explanation: "WHY-TEXT", suggestedFix: "FIX-TEXT", dedupKey: "dedup-secret" });
    expect(list.findings[0]!.locked).toBeUndefined();
    const d = incidentDetail.parse(await (await s.client.get(`/api/incidents/${s.incidentId}`)).json());
    expect(d.locked).toBeUndefined();
    expect(d.whatChanged!.items.length).toBeGreaterThan(0);
    expect(d.snapshot!.worstChunks).toHaveLength(1);
    expect(d.timeline.some((e) => e.kind === "plugin_added")).toBe(true);
    const det = findingDetailResponse.parse(await (await s.client.get(`/api/findings/${s.causeId}`)).json());
    expect(det.finding.evidence!.chunks).toHaveLength(1);
  });

  it("BETA_ALL_PRO on: a stored-free server sees everything; off again: locked", async () => {
    const s = await setup(h, "free");
    configureLimits({ betaAllPro: true });
    const list = findingsListResponse.parse(await (await s.client.get(`/api/servers/${s.serverId}/findings`)).json());
    expect(list.findings[0]).toMatchObject({ explanation: "WHY-TEXT" });
    expect(list.findings[0]!.locked).toBeUndefined();
    const d = incidentDetail.parse(await (await s.client.get(`/api/incidents/${s.incidentId}`)).json());
    expect(d.locked).toBeUndefined();
    expect(d.whatChanged).toBeDefined();
    configureLimits({ betaAllPro: false });
    const raw = await text(s.client, `/api/incidents/${s.incidentId}`);
    expect(raw).not.toMatch(LOCKED_RE);
  });
});
