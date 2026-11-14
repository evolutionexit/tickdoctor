import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { RuleId } from "@tickdoctor/shared";
import { main } from "../src/cli.js";
import { events, incidentSnapshots, metricRollups1m, metricSamples, serverInfoHistory, servers } from "../src/db/schema.js";
import { buildContext } from "../src/findings/context.js";
import { evaluateIncident, evaluateServer, runRules } from "../src/findings/engine.js";
import { runIncidentJob, runRecheckJob, runServerRulesJob } from "../src/findings/jobs.js";
import { getFinding, markFixed, recheckFindings, upsertFinding } from "../src/findings/lifecycle.js";
import { formatFinding, tpHint } from "../src/findings/format.js";
import { detectIncidents } from "../src/incidents/detector.js";
import type { Rule, RuleContext, RuleFinding } from "../src/rules/types.js";
import { testDatabaseUrl } from "./db-url.js";
import { fixture, freshIp, handle, makeApp, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeEach(resetStorage);

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const S = 1000;
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const quiet = () => {};

function rf(over: Partial<RuleFinding> = {}): RuleFinding {
  return {
    ruleId: "gc-pressure",
    dedupKey: "heap",
    severity: "medium",
    title: "GC pauses are eating your ticks",
    explanation: "Garbage collection paused the server often.",
    evidence: { numbers: [{ label: "GC pause per minute", value: 900, unit: "ms", baseline: 60 }] },
    suggestedFix: "Raise -Xmx or find the memory leak.",
    ...over,
  };
}
function rule(id: RuleId, scopes: Rule["scopes"], evaluate: (ctx: RuleContext) => RuleFinding[]): Rule {
  return { id, scopes, evaluate };
}

async function rawSamples(serverId: string, from: number, to: number, stepMs = 10 * S, p95 = 15) {
  const vals = [];
  for (let t = from; t <= to; t += stepMs) vals.push({ serverId, ts: new Date(t), mspt_p95: p95, players: 1, detail: { windowSeconds: 10 } });
  for (let i = 0; i < vals.length; i += 1000) await handle.db.insert(metricSamples).values(vals.slice(i, i + 1000)).onConflictDoNothing();
}

async function closedIncident(serverId: string, start: number, end: number): Promise<string> {
  const [r] = await q(sql`insert into incidents (server_id, started_at, ended_at, end_reason, severity, peak_mspt_p95, source, closed_at)
    values (${serverId}, ${iso(start)}, ${iso(end)}, 'recovered', 'medium', 70, 'raw', ${iso(end)}) returning id`);
  return r!.id;
}

describe("engine: runRules", () => {
  it("isolates a throwing rule, drops invalid findings, respects scopes", () => {
    const logs: string[] = [];
    const ctx = { scope: "server", server: { id: "00000000-0000-4000-8000-000000000000" } } as RuleContext;
    const out = runRules(
      [
        rule("gc-pressure", ["server"], () => { throw new Error("kaboom"); }),
        rule("swap-in-use", ["server"], () => [rf({ ruleId: "swap-in-use", title: "x".repeat(201) })]),
        rule("jvm-flags", ["server"], () => [rf({ ruleId: "jvm-flags", evidence: { numbers: Array.from({ length: 13 }, () => ({ label: "n", value: 1 })) } })]),
        rule("thermal-throttling", ["server"], () => [rf({ ruleId: "swap-in-use" })]), // wrong rule id
        rule("entity-explosion", ["incident"], () => [rf({ ruleId: "entity-explosion" })]), // wrong scope: not run
        rule("view-distance-too-high", ["server", "incident"], () => [rf({ ruleId: "view-distance-too-high" }), rf({ ruleId: "view-distance-too-high" })]),
      ],
      ctx,
      (l) => logs.push(l),
    );
    expect(out.map((f) => f.ruleId)).toEqual(["view-distance-too-high"]); // duplicates collapse
    expect(logs.some((l) => l.includes("gc-pressure failed") && l.includes("kaboom"))).toBe(true);
    expect(logs.filter((l) => l.includes("invalid finding"))).toHaveLength(2);
    expect(logs.some((l) => l.includes("returned a finding for swap-in-use"))).toBe(true);
  });
});

describe("lifecycle", () => {
  it("server scope: upsert refreshes evidence and counts passes; stamps server_rules_at", async () => {
    const s = await makeServer();
    let value = 900;
    const rules = [rule("gc-pressure", ["server"], () => [rf({ evidence: { numbers: [{ label: "GC", value }] } })])];
    const a = await evaluateServer(handle.db, s.serverId, { nowMs: T0, rules, log: quiet });
    value = 1200;
    const b = await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 5 * MIN, rules, log: quiet });
    expect(a.findings[0]!.created).toBe(true);
    expect(b.findings[0]).toMatchObject({ id: a.findings[0]!.id, created: false });
    const f = await getFinding(handle.db, a.findings[0]!.id);
    expect(f).toMatchObject({ status: "open", scope: "server", occurrenceCount: 2, firstSeenAt: iso(T0), lastSeenAt: iso(T0 + 5 * MIN), incidentIds: [] });
    expect(f!.evidence.numbers[0]!.value).toBe(1200);
    const [st] = await q(sql`select server_rules_at from server_analysis_state where server_id = ${s.serverId}`);
    expect(iso(st!.server_rules_at)).toBe(iso(T0 + 5 * MIN));
  });

  it("incident scope: one occurrence per incident, incident ids oldest first, rules_evaluated_at stamped", async () => {
    const s = await makeServer();
    const rules = [rule("entity-explosion", ["incident"], (ctx) => [rf({ ruleId: "entity-explosion", dedupKey: "world:item", explanation: `in ${ctx.incident!.id}` })])];
    const i1 = await closedIncident(s.serverId, T0, T0 + 10 * MIN);
    const i2 = await closedIncident(s.serverId, T0 + 60 * MIN, T0 + 70 * MIN);
    await evaluateIncident(handle.db, i2, { nowMs: T0 + 71 * MIN, rules, log: quiet });
    await evaluateIncident(handle.db, i2, { nowMs: T0 + 72 * MIN, rules, log: quiet }); // closed pass again
    const r = await evaluateIncident(handle.db, i1, { nowMs: T0 + 73 * MIN, rules, log: quiet });
    const f = await getFinding(handle.db, r.findings[0]!.id);
    expect(f).toMatchObject({ occurrenceCount: 2, incidentIds: [i1, i2], scope: "incident", firstSeenAt: iso(T0 + 10 * MIN), lastSeenAt: iso(T0 + 70 * MIN) });
    const [inc] = await q(sql`select rules_evaluated_at from incidents where id = ${i1}`);
    expect(iso(inc!.rules_evaluated_at)).toBe(iso(T0 + 73 * MIN));
  });

  it("marked_fixed reopens when seen after marking, not for older data; confirmed_fixed starts a new finding", async () => {
    const s = await makeServer();
    const up = (seenAt: number) => upsertFinding(handle.db, { serverId: s.serverId, scope: "server", finding: rf(), seenAt });
    const { id } = await up(T0);
    expect(await markFixed(handle.db, id, T0 + MIN)).toBe(true);
    expect(await markFixed(handle.db, id, T0 + MIN)).toBe(false); // only open findings
    expect((await up(T0 + 30 * S)).reopened).toBe(false); // backfilled data from before the fix
    expect((await getFinding(handle.db, id))!.status).toBe("marked_fixed");
    expect((await up(T0 + 2 * MIN)).reopened).toBe(true);
    expect(await getFinding(handle.db, id)).toMatchObject({ status: "open", markedFixedAt: null });

    await handle.db.execute(sql`update findings set status = 'confirmed_fixed', confirmed_fixed_at = now(), resolved_by = 'owner' where id = ${id}`);
    const again = await up(T0 + 10 * MIN);
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(id);
  });
});

describe("cross-scope findings", () => {
  it("one finding per (server, rule, dedupKey): a server pass upgrades an incident-scope finding to server", async () => {
    const s = await makeServer();
    const both = [rule("swap-in-use", ["incident", "server"], () => [rf({ ruleId: "swap-in-use", dedupKey: "swap" })])];
    const inc = await closedIncident(s.serverId, T0, T0 + 10 * MIN);
    const a = await evaluateIncident(handle.db, inc, { nowMs: T0 + 11 * MIN, rules: both, log: quiet });
    expect((await getFinding(handle.db, a.findings[0]!.id))!.scope).toBe("incident");
    const b = await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 12 * MIN, rules: both, log: quiet });
    expect(b.findings[0]!.id).toBe(a.findings[0]!.id);
    expect(await getFinding(handle.db, a.findings[0]!.id)).toMatchObject({ scope: "server", incidentIds: [inc] });
    const [n] = await q(sql`select count(*)::int as n from findings where server_id = ${s.serverId}`);
    expect(n!.n).toBe(1);
  });
});

describe("recheck", () => {
  const cfg = { serverMinutes: 15, incidentHours: 2 };

  it("owner confirm (server scope) needs the window, fresh data and a server pass after it", async () => {
    const s = await makeServer();
    const { id } = await upsertFinding(handle.db, { serverId: s.serverId, scope: "server", finding: rf(), seenAt: T0 });
    await markFixed(handle.db, id, T0 + MIN);
    const at = T0 + 20 * MIN;
    expect((await recheckFindings(handle.db, cfg, at)).confirmedOwner).toEqual([]); // no data, no pass
    await rawSamples(s.serverId, T0 + MIN, at);
    expect((await recheckFindings(handle.db, cfg, at)).confirmedOwner).toEqual([]); // no pass after the window yet
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 17 * MIN, rules: [], log: quiet });
    expect((await recheckFindings(handle.db, cfg, T0 + 10 * MIN)).confirmedOwner).toEqual([]); // window not over
    expect((await recheckFindings(handle.db, cfg, at)).confirmedOwner).toEqual([id]);
    expect(await getFinding(handle.db, id)).toMatchObject({ status: "confirmed_fixed", resolvedBy: "owner", confirmedFixedAt: iso(at) });
  });

  const jvm = rf({ ruleId: "jvm-flags", dedupKey: "xms-ne-xmx", title: "Xms differs from Xmx" });
  const setHello = (serverId: string, at: number) =>
    handle.db.execute(sql`insert into server_analysis_state (server_id, last_hello_at) values (${serverId}, ${iso(at)})
      on conflict (server_id) do update set last_hello_at = excluded.last_hello_at`);

  it("config rule (A): fix + restart hello first, then mark fixed → confirmed by owner", async () => {
    const s = await makeServer();
    let firing = true;
    const rules = [rule("jvm-flags", ["server"], () => (firing ? [jvm] : []))];
    await setHello(s.serverId, T0 - 60 * MIN);
    const { findings } = await evaluateServer(handle.db, s.serverId, { nowMs: T0, rules, log: quiet });
    const id = findings[0]!.id;
    firing = false; // owner switched to -Xms4G -Xmx4G and restarted
    await setHello(s.serverId, T0 + 10 * MIN);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 11 * MIN, rules, log: quiet });
    await markFixed(handle.db, id, T0 + 12 * MIN); // marks AFTER the restart hello
    await rawSamples(s.serverId, T0, T0 + 40 * MIN);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 30 * MIN, rules, log: quiet });
    const r = await recheckFindings(handle.db, cfg, T0 + 30 * MIN);
    expect(r.confirmedOwner).toEqual([id]);
    expect(await getFinding(handle.db, id)).toMatchObject({ status: "confirmed_fixed", resolvedBy: "owner" });
  });

  it("config rule (B): mark fixed, a pass on the old hello doesn't reopen, the restart hello confirms", async () => {
    const s = await makeServer();
    let firing = true;
    const rules = [rule("jvm-flags", ["server"], () => (firing ? [jvm] : []))];
    await setHello(s.serverId, T0 - 60 * MIN);
    const id = (await evaluateServer(handle.db, s.serverId, { nowMs: T0, rules, log: quiet })).findings[0]!.id;
    await markFixed(handle.db, id, T0 + 5 * MIN);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 10 * MIN, rules, log: quiet }); // still the old hello
    expect(await getFinding(handle.db, id)).toMatchObject({ status: "marked_fixed", lastSeenAt: iso(T0) });
    firing = false;
    await setHello(s.serverId, T0 + 15 * MIN); // restart with the fix
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 16 * MIN, rules, log: quiet });
    await rawSamples(s.serverId, T0, T0 + 40 * MIN);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 25 * MIN, rules, log: quiet });
    expect((await recheckFindings(handle.db, cfg, T0 + 25 * MIN)).confirmedOwner).toEqual([id]);
  });

  it("config rule: still wrong after the restart hello → reopened", async () => {
    const s = await makeServer();
    const rules = [rule("jvm-flags", ["server"], () => [jvm])];
    await setHello(s.serverId, T0 - 60 * MIN);
    const id = (await evaluateServer(handle.db, s.serverId, { nowMs: T0, rules, log: quiet })).findings[0]!.id;
    await markFixed(handle.db, id, T0 + 5 * MIN);
    await setHello(s.serverId, T0 + 15 * MIN);
    const r = await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 16 * MIN, rules, log: quiet });
    expect(r.findings[0]).toMatchObject({ id, reopened: true });
    expect((await getFinding(handle.db, id))!.status).toBe("open");
  });

  it("owner wins over auto: a freshly marked finding is not auto-confirmed", async () => {
    const s = await makeServer();
    const { id } = await upsertFinding(handle.db, { serverId: s.serverId, scope: "server", finding: rf({ ruleId: "swap-in-use", dedupKey: "swap" }), seenAt: T0 });
    await rawSamples(s.serverId, T0, T0 + 60 * MIN, 60 * S);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 60 * MIN, rules: [], log: quiet });
    await markFixed(handle.db, id, T0 + 59 * MIN); // auto would have confirmed it now
    expect(await recheckFindings(handle.db, cfg, T0 + 60 * MIN)).toEqual({ confirmedOwner: [], confirmedAuto: [] });
    expect((await getFinding(handle.db, id))!.status).toBe("marked_fixed");
  });

  it("server-scope findings auto-resolve when the condition stays away; incident-scope never do", async () => {
    const s = await makeServer();
    const srv = await upsertFinding(handle.db, { serverId: s.serverId, scope: "server", finding: rf({ ruleId: "swap-in-use", dedupKey: "swap" }), seenAt: T0 });
    const inc = await upsertFinding(handle.db, { serverId: s.serverId, scope: "incident", finding: rf(), seenAt: T0 });
    await rawSamples(s.serverId, T0, T0 + 4 * 3600 * S, 60 * S);
    await evaluateServer(handle.db, s.serverId, { nowMs: T0 + 4 * 3600 * S, rules: [], log: quiet });
    const r = await runRecheckJob(handle.db, cfg, { nowMs: T0 + 4 * 3600 * S });
    expect(r).toEqual({ confirmedOwner: [], confirmedAuto: [srv.id] });
    expect(await getFinding(handle.db, srv.id)).toMatchObject({ status: "confirmed_fixed", resolvedBy: "auto" });
    expect((await getFinding(handle.db, inc.id))!.status).toBe("open");
  });

  it("incident-scope owner confirm after FINDING_RECHECK_INCIDENT_HOURS with data in both halves (1-h rollups)", async () => {
    const s = await makeServer();
    const { id } = await upsertFinding(handle.db, { serverId: s.serverId, scope: "incident", finding: rf(), seenAt: T0 });
    await markFixed(handle.db, id, T0);
    const long = { serverMinutes: 15, incidentHours: 10 };
    const at = T0 + 11 * 3600 * S;
    await handle.db.execute(sql`insert into metric_rollups_1h (server_id, bucket, sample_count) values (${s.serverId}, ${iso(T0 + 3600 * S)}, 360)`);
    expect((await recheckFindings(handle.db, long, at)).confirmedOwner).toEqual([]); // only first half
    await handle.db.execute(sql`insert into metric_rollups_1h (server_id, bucket, sample_count) values (${s.serverId}, ${iso(T0 + 8 * 3600 * S)}, 360)`);
    expect((await recheckFindings(handle.db, long, T0 + 9 * 3600 * S)).confirmedOwner).toEqual([]); // window not over
    expect((await recheckFindings(handle.db, long, at)).confirmedOwner).toEqual([id]);
  });
});

describe("jobs", () => {
  it("incident rules run 90 s after opening (or as soon as a snapshot is linked) and again after close", async () => {
    const s = await makeServer();
    const seen: string[] = [];
    const rules = [rule("entity-explosion", ["incident"], (ctx) => { seen.push(ctx.incident!.endedAt ? "closed" : "open"); return []; })];
    const vals = Array.from({ length: 4 }, (_, i) => ({ serverId: s.serverId, ts: new Date(T0 + i * 10 * S), mspt_p95: 80, detail: {} }));
    await handle.db.insert(metricSamples).values(vals);
    const d = await detectIncidents(handle.db, s.serverId, T0 + 30 * S);
    await runIncidentJob(handle.db, { nowMs: T0 + 60 * S, rules, log: quiet });
    expect(seen).toEqual([]);
    await runIncidentJob(handle.db, { nowMs: T0 + 121 * S, rules, log: quiet });
    expect(seen).toEqual(["open"]);
    await runIncidentJob(handle.db, { nowMs: T0 + 136 * S, rules, log: quiet });
    expect(seen).toEqual(["open"]);
    // Offline close via the job (no samples for 5 min) → closed pass.
    await runIncidentJob(handle.db, { nowMs: T0 + 30 * S + 5 * MIN, rules, log: quiet });
    expect(seen).toEqual(["open", "closed"]);
    const [inc] = await q(sql`select end_reason, rules_evaluated_at from incidents where id = ${d.opened[0]!}`);
    expect(inc!.end_reason).toBe("offline");

    // Second incident with a snapshot: the opened pass runs right away.
    const s2 = await makeServer();
    await handle.db.insert(incidentSnapshots).values({ serverId: s2.serverId, trigger: "threshold", capturedAt: new Date(T0 + 5 * S), msptP95AtTrigger: 80, snapshot: {} });
    await handle.db.insert(metricSamples).values(vals.map((v) => ({ ...v, serverId: s2.serverId })));
    await detectIncidents(handle.db, s2.serverId, T0 + 30 * S);
    seen.length = 0;
    await runIncidentJob(handle.db, { nowMs: T0 + 35 * S, rules, log: quiet });
    expect(seen).toEqual(["open"]);
  });

  it("server-rules job covers servers seen in the last 10 minutes only", async () => {
    const a = await makeServer();
    const b = await makeServer();
    await handle.db.update(servers).set({ lastSeenAt: new Date(T0 - 2 * MIN) }).where(sql`id = ${a.serverId}`);
    await handle.db.update(servers).set({ lastSeenAt: new Date(T0 - 30 * MIN) }).where(sql`id = ${b.serverId}`);
    expect(await runServerRulesJob(handle.db, { nowMs: T0, rules: [], log: quiet })).toEqual([a.serverId]);
  });

  it("POST /v1/ingest/hello triggers a server-scope pass", async () => {
    const s = await makeServer();
    const calls: string[] = [];
    const app = makeApp({ onHello: (id: string) => { calls.push(id); } });
    const res = await app.request("/v1/ingest/hello", {
      method: "POST",
      headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify(fixture("hello")),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([s.serverId]);
  });
});

describe("context", () => {
  it("builds the documented RuleContext (raw with detail, rollup fallback, history, events, info)", async () => {
    const s = await makeServer({ plan: "pro" });
    const now = T0;
    // Rollups for the last 2 h, raw only for the last 10 min (with host detail).
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 120 }, (_, i) => ({ serverId: s.serverId, bucket: new Date(now - (120 - i) * MIN), sampleCount: 6, mspt_p95_avg: 12, mspt_p95_max: 20, players_avg: 2 } as never)));
    await handle.db.insert(metricSamples).values(
      Array.from({ length: 60 }, (_, i) => ({
        serverId: s.serverId,
        ts: new Date(now - 10 * MIN + (i + 1) * 10 * S),
        mspt_p95: 12,
        cpu_temp_c: 61,
        swap_used_bytes: 5,
        detail: {
          windowSeconds: 10,
          jvm: { heapCommittedBytes: 100, gcPauses: [{ collector: "G1", count: 1, totalMs: 4, maxMs: 4 }], threadCount: 30 },
          world: [{ name: "world", loadedChunks: 9, entities: 3, entitiesByType: { cow: 3 }, tileEntitiesByType: {}, countsAgeSeconds: 2 }],
          worstChunks: [],
          host: { throttled: { now: false, sinceBoot: true }, swapTotalBytes: 10 },
        },
      })),
    );
    await handle.db.insert(serverInfoHistory).values([
      { serverId: s.serverId, validFrom: new Date(now - 3 * 86_400_000), validTo: new Date(now - 86_400_000), info: { v: 1 }, infoHash: "a" },
      { serverId: s.serverId, validFrom: new Date(now - 86_400_000), info: { v: 2 }, infoHash: "b" },
    ]);
    await handle.db.insert(events).values({ serverId: s.serverId, ts: new Date(now - 5 * MIN), type: "cant_keep_up", data: { behindMs: 2000, ticksSkipped: 40 }, eventHash: "e1" });

    const ctx = await buildContext(handle.db, { serverId: s.serverId, scope: "server", nowMs: now });
    expect(ctx).toMatchObject({ now: iso(now), scope: "server", server: { id: s.serverId, plan: "pro" }, window: { from: iso(now - 30 * MIN), to: iso(now) } });
    expect(ctx.info).toEqual({ v: 2 });
    expect(ctx.infoHistory.map((h) => h.validTo === null)).toEqual([false, true]);
    const rollups = ctx.samples.filter((x) => x.seconds === 60);
    const raw = ctx.samples.filter((x) => x.detail);
    expect(rollups).toHaveLength(20); // −30 min … −10 min
    expect(raw).toHaveLength(60);
    expect(rollups[0]).toMatchObject({ m: { mspt_p95: 12, players: 2 }, max: { mspt_p95: 20 } });
    expect(raw[0]!.detail).toMatchObject({
      worlds: [{ name: "world", entitiesByType: { cow: 3 } }],
      gcPauses: [{ collector: "G1", totalMs: 4 }],
      heapCommittedBytes: 100,
      threadCount: 30,
      host: { cpuTempC: 61, swapUsedBytes: 5, swapTotalBytes: 10, throttled: { now: false, sinceBoot: true } },
    });
    expect(ctx.history).toHaveLength(120);
    expect(ctx.history[0]!.detail).toBeUndefined();
    expect(ctx.events).toEqual([{ type: "cant_keep_up", ts: iso(now - 5 * MIN), behindMs: 2000, ticksSkipped: 40 }]);
    expect(ctx.incident).toBeUndefined();

    const incId = await closedIncident(s.serverId, now - 8 * MIN, now - 4 * MIN);
    const ictx = await buildContext(handle.db, { serverId: s.serverId, scope: "incident", incidentId: incId, nowMs: now });
    expect(ictx.window).toEqual({ from: iso(now - 18 * MIN), to: iso(now - 4 * MIN) });
    expect(ictx.now).toBe(iso(now - 4 * MIN));
    expect(ictx.incident!.id).toBe(incId);
    expect(ictx.snapshot).toBeNull();
    expect(ictx.baseline).toBeNull();
  });
});

describe("context bounds", () => {
  it("server scope: 24 h history; busy events only window + 24 h; lifecycle events 7 days", async () => {
    const s = await makeServer();
    const now = T0;
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 48 * 60 }, (_, i) => ({ serverId: s.serverId, bucket: new Date(now - (i + 1) * MIN), sampleCount: 6, mspt_p95_avg: 10 } as never)));
    const ev = (ago: number, type: string, data: object, h: string) => ({ serverId: s.serverId, ts: new Date(now - ago), type, data, eventHash: h });
    await handle.db.insert(events).values([
      ev(3 * 86_400_000, "exception", { exceptionClass: "X", stackHash: "a", count: 1 }, "1"),
      ev(3 * 86_400_000, "plugins_changed", { added: [], removed: [], updated: [] }, "2"),
      ev(20 * 3_600_000, "exception", { exceptionClass: "X", stackHash: "b", count: 1 }, "3"),
      ev(8 * 86_400_000, "server_start", { uncleanPreviousShutdown: false }, "4"),
    ]);
    const ctx = await buildContext(handle.db, { serverId: s.serverId, scope: "server", nowMs: now });
    expect(ctx.history.length).toBe(24 * 60);
    expect(ctx.events.map((e) => e.type)).toEqual(["plugins_changed", "exception"]);
  });
});

describe("cli (phase 4)", () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    process.env.DATABASE_URL = testDatabaseUrl();
  });
  afterAll(() => {
    process.env.DATABASE_URL = saved;
  });
  async function run(...argv: string[]) {
    const lines: string[] = [];
    const code = await main(argv, (l) => lines.push(l));
    return { code, lines, text: lines.join("\n") };
  }

  it("finding:show reads like the owner will see it; mark-fixed; list --status", async () => {
    const s = await makeServer();
    const { id } = await upsertFinding(handle.db, {
      serverId: s.serverId,
      scope: "incident",
      seenAt: T0,
      finding: rf({
        ruleId: "entity-explosion",
        dedupKey: "world:item",
        severity: "high",
        title: "Too many item entities in one chunk",
        evidence: {
          numbers: [{ label: "Item entities", value: 3800, baseline: 60 }],
          chart: { metric: "entities", from: iso(T0 - 3600 * S), to: iso(T0) },
          chunks: [{ world: "world", x: -40, z: 112 }],
        },
        suggestedFix: "1. Teleport there.\n2. Clear the items.",
      }),
    });
    const show = await run("finding:show", id);
    expect(show.lines[0]).toBe("[HIGH] Too many item entities in one chunk");
    expect(show.text).toContain("Item entities: 3,800   (normal: 60)");
    expect(show.text).toContain("Chart: entities");
    expect(show.text).toContain("/execute in minecraft:overworld run tp @s -632 ~ 1800");
    expect(show.text).toContain("  2. Clear the items.");
    expect(show.text).toContain("Status: open");
    expect(show.text).toMatch(/First seen 2026-11-09 12:00:00 UTC/);

    expect((await run("finding:list", s.serverId, "--status", "open")).lines).toHaveLength(1);
    await run("finding:mark-fixed", id);
    expect((await run("finding:list", s.serverId, "--status", "open")).lines).toEqual(["(no findings)"]);
    expect((await run("finding:show", id)).text).toMatch(/Marked fixed/);
    await expect(run("finding:mark-fixed", id)).rejects.toThrow(/not open/);
    await expect(run("finding:list", s.serverId, "--status", "bogus")).rejects.toThrow(/usage/);
  });

  it("incident:list / incident:show / incidents:backfill / rules:run / rules:context", async () => {
    const s = await makeServer();
    expect((await run("incident:list", s.serverId)).lines).toEqual(["(no incidents)"]);
    await rawSamples(s.serverId, T0, T0 + 10 * MIN, 10 * S, 15);
    await handle.db.execute(sql`update metric_samples set mspt_p95 = 120 where server_id = ${s.serverId} and ts between ${iso(T0 + 2 * MIN)} and ${iso(T0 + 4 * MIN)}`);
    const bf = await run("incidents:backfill", s.serverId, "--from", iso(T0 - MIN), "--to", iso(T0 + 11 * MIN));
    expect(bf.text).toContain("created=1");
    const list = await run("incident:list", s.serverId);
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]).toMatch(/high\ttrigger mspt\tpeak p95 120\.0 ms\tmin TPS -\traw/);
    const incId = list.lines[0]!.split("\t")[0]!;
    const show = await run("incident:show", incId);
    expect(show.text).toContain("Peak MSPT p95: 120.0 ms");
    expect(show.text).toContain("Baseline: none");

    expect((await run("rules:run", s.serverId)).text).toMatch(/findings=\d+/);
    const ctx = JSON.parse((await run("rules:context", s.serverId, "--scope", "incident", "--incident", incId)).text);
    expect(ctx.scope).toBe("incident");
    expect(ctx.incident.id).toBe(incId);
    expect(ctx.samples.length).toBeGreaterThan(0);
    const sctx = JSON.parse((await run("rules:context", s.serverId, "--scope", "server", "--at", iso(T0 + 10 * MIN))).text);
    expect(sctx.window).toEqual({ from: iso(T0 - 20 * MIN), to: iso(T0 + 10 * MIN) });
    await expect(run("rules:context", s.serverId, "--scope", "incident")).rejects.toThrow(/--incident/);
    expect((await run("rules:run", s.serverId, "--incident", incId)).text).toMatch(/findings=\d+/);
    const other = await makeServer();
    await expect(run("rules:run", other.serverId, "--incident", incId)).rejects.toThrow(/not found for this server/);
    await expect(run("incidents:backfill", "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/);
  });

  it("tp hint for custom worlds", () => {
    expect(tpHint("survival2", 1, -1)).toBe('/tp @s 24 ~ -8   (in world "survival2")');
    expect(formatFinding({ ...rf(), id: "x", serverId: "s", scope: "server", status: "confirmed_fixed", incidentIds: [], occurrenceCount: 1, firstSeenAt: iso(T0), lastSeenAt: iso(T0), markedFixedAt: null, confirmedFixedAt: iso(T0), resolvedBy: "auto", createdAt: iso(T0), updatedAt: iso(T0) })[1]).toMatch(/confirmed fixed \(resolved by auto\)/);
  });
});
