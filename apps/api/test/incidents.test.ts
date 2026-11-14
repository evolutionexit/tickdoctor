import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { metricRollups1m, metricSamples, incidentSnapshots, serverInfoHistory } from "../src/db/schema.js";
import { detectInTx, detectIncidents, detectorTick } from "../src/incidents/detector.js";
import { storeMetrics, type DetectHook } from "../src/ingest/storage.js";
import { runIncidentJob } from "../src/findings/jobs.js";
import { buildBaseline } from "../src/incidents/baseline.js";
import { backfillIncidents } from "../src/incidents/backfill.js";
import { emptyState, severityFor, step } from "../src/incidents/core.js";
import { getIncident } from "../src/incidents/store.js";
import { runRetention } from "../src/jobs/retention.js";
import { ingestTx } from "../src/ingest/storage.js";
import { fixture, freshFixture, freshIp, handle, makeApp, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeEach(resetStorage);

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const S = 1000;
const iso = (t: number) => new Date(t).toISOString();

/** Raw samples every 10 s starting at `from` (ts = end of window) with the given p95 values. */
async function samples(serverId: string, from: number, p95s: number[], detail: Record<string, unknown> = {}) {
  if (p95s.length === 0) return;
  await handle.db
    .insert(metricSamples)
    .values(p95s.map((p95, i) => ({ serverId, ts: new Date(from + i * 10 * S), mspt_p95: p95, mspt_avg: p95 / 2, players: 2, detail: { windowSeconds: 10, ...detail } })))
    .onConflictDoNothing();
}
const rep = (n: number, v: number) => Array.from({ length: n }, () => v);
const incidentsOf = (serverId: string) => q(sql`select * from incidents where server_id = ${serverId} order by started_at`);

describe("state machine (core)", () => {
  it("opens after 30 s over 50, closes after 120 s under 40, severity from peak", () => {
    const st = emptyState();
    const pts = [55, 60, 52, 45, 120, 260, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39].map((p95, i) => ({ start: i * 10_000, end: (i + 1) * 10_000, p95 }));
    const evs = pts.flatMap((p) => step(st, p));
    expect(evs[0]).toMatchObject({ kind: "open", startedAt: 0, peak: 60 });
    const close = evs.find((e) => e.kind === "close");
    expect(close).toMatchObject({ reason: "recovered", startedAt: 0, endedAt: 60_000, peak: 260 });
    expect(severityFor(99)).toBe("medium");
    expect(severityFor(100)).toBe("high");
    expect(severityFor(250)).toBe("critical");
  });

  it("a 1-min rollup ≥ 50 opens on its own; two < 40 close", () => {
    const st = emptyState();
    const m = (i: number, p95: number) => ({ start: i * 60_000, end: (i + 1) * 60_000, p95 });
    expect(step(st, m(0, 51))[0]).toMatchObject({ kind: "open" });
    expect(step(st, m(1, 39))).toEqual([]);
    expect(step(st, m(2, 39))[0]).toMatchObject({ kind: "close", endedAt: 60_000 });
  });
});

describe("state machine: low TPS (stall lag)", () => {
  const pt = (i: number, p95: number, tps: number | null) => ({ start: i * 10_000, end: (i + 1) * 10_000, p95, tps });

  it("opens after 90 s of tps < 18 even with a low p95; closes only when p95 < 40 AND tps ≥ 19 for 120 s", () => {
    const st = emptyState();
    const evs = [19, 17, 16, 15, 12, 14, 15, 16, 16, 17].map((t, i) => step(st, pt(i, 8, t))).flat(); // 90 s under 18 on the 10th
    expect(evs).toEqual([{ kind: "open", startedAt: 10_000, peak: 8, minTps: 12, trigger: "tps", at: 100_000 }]);
    // TPS back to 18.5 (≥ 18 but < 19): not healthy, the incident stays open.
    for (let i = 10; i < 30; i++) expect(step(st, pt(i, 8, 18.5)).filter((e) => e.kind === "close")).toEqual([]);
    const close = Array.from({ length: 12 }, (_, k) => step(st, pt(30 + k, 8, 19.6))).flat().find((e) => e.kind === "close");
    expect(close).toMatchObject({ reason: "recovered", startedAt: 10_000, endedAt: 300_000, minTps: 12 });
  });

  it("one ~6 s stall (tps_1m < 18 for ~60 s as the 1-min average recovers) opens nothing", () => {
    const st = emptyState();
    const tps = [20, 20, 13.5, 14.5, 15.5, 16.5, 17.2, 17.8, 18.4, 19, 19.6, 20, 20];
    expect(tps.flatMap((t, i) => step(st, pt(i, i === 2 ? 30 : 2, t)))).toEqual([]);
  });

  it("a tps-opened incident's peak is the run's max p95, not just the last point", () => {
    const st = emptyState();
    const evs = [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => step(st, pt(i, i === 3 ? 45 : 5, 15)));
    expect(evs[0]).toMatchObject({ kind: "open", trigger: "tps", peak: 45 });
  });

  it("real Pi data: the chunk-generation run opens a tps incident; the idle Pi opens nothing", () => {
    const load = (name: string) =>
      JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/rules/pi-scenarios/${name}.json.gz`, import.meta.url))).toString("utf8")) as {
        samples: { ts: string; seconds: number; m: { mspt_p95?: number; tps_1m?: number } }[];
      };
    const run = (name: string) => {
      const st = emptyState();
      return load(name).samples.flatMap((x) => {
        const end = Date.parse(x.ts);
        return step(st, { start: end - x.seconds * 1000, end, p95: x.m.mspt_p95 ?? 0, tps: x.m.tps_1m ?? null });
      });
    };
    expect(run("idle.server")).toEqual([]);
    const opens = run("chunkgen.server").filter((e) => e.kind === "open");
    const tpsOpen = opens.find((e) => e.kind === "open" && e.trigger === "tps");
    expect(tpsOpen).toBeDefined();
    expect(new Date((tpsOpen as { startedAt: number }).startedAt).toISOString()).toMatch(/^2026-11-09T16:55:32/); // b2ef9187
  });

  it("50 s under 18 is not enough; a missing TPS value never counts as low; p95 wins a tie", () => {
    const st = emptyState();
    expect([17, 17, 17, 17, 17, 19].flatMap((t, i) => step(st, pt(i, 8, t)))).toEqual([]);
    const st2 = emptyState();
    expect([0, 1, 2, 3, 4, 5, 6].flatMap((i) => step(st2, pt(i, 8, null)))).toEqual([]);
    const st3 = emptyState();
    const evs = [0, 1, 2, 3, 4, 5].flatMap((i) => step(st3, pt(i, i >= 3 ? 70 : 8, 15)));
    expect(evs[0]).toMatchObject({ kind: "open", trigger: "mspt", startedAt: 30_000, minTps: 15 });
  });

  it("severity is the worse of peak p95 and lowest TPS", () => {
    expect(severityFor(60, 16)).toBe("medium");
    expect(severityFor(60, 14.9)).toBe("high");
    expect(severityFor(60, 9.5)).toBe("critical");
    expect(severityFor(300, 19)).toBe("critical");
    expect(severityFor(120, null)).toBe("high");
  });
});

describe("live detector", () => {
  it("opens a tps-triggered incident from raw samples and stores minTps1m + trigger", async () => {
    const s = await makeServer();
    const tps = [19.9, 17.5, 15, 12.2, 11.8, 13, 14, 16, 16.5, 17];
    await handle.db.insert(metricSamples).values(tps.map((t, i) => ({ serverId: s.serverId, ts: new Date(T0 + i * 10 * S), mspt_p95: 6, tps_1m: t, detail: { windowSeconds: 10 } })));
    const r = await detectIncidents(handle.db, s.serverId, T0 + 100 * S);
    expect(r.opened).toHaveLength(1);
    const inc = await getIncident(handle.db, r.opened[0]!);
    expect(inc).toMatchObject({ trigger: "tps", minTps1m: 11.8, severity: "high", peakMsptP95: 6, startedAt: iso(T0) });
    // Recovery needs tps ≥ 19 too.
    await handle.db.insert(metricSamples).values(Array.from({ length: 14 }, (_, i) => ({ serverId: s.serverId, ts: new Date(T0 + (10 + i) * 10 * S), mspt_p95: 6, tps_1m: i < 2 ? 18.6 : 19.8, detail: { windowSeconds: 10 } })));
    const c = await detectIncidents(handle.db, s.serverId, T0 + 240 * S);
    expect(c.closed).toEqual(r.opened);
    expect((await getIncident(handle.db, r.opened[0]!))!.endedAt).toBe(iso(T0 + 110 * S));
  });

  it("opens only after 30 s of consecutive samples ≥ 50", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, [20, 55, 55, 30, 60, 60]);
    await detectIncidents(handle.db, s.serverId, T0 + 60 * S);
    expect(await incidentsOf(s.serverId)).toHaveLength(0);
    await samples(s.serverId, T0 + 60 * S, [70]);
    const r = await detectIncidents(handle.db, s.serverId, T0 + 70 * S);
    expect(r.opened).toHaveLength(1);
    const [inc] = await incidentsOf(s.serverId);
    expect(iso(inc!.started_at)).toBe(iso(T0 + 30 * S)); // window start of the first sample of the run
    expect(inc).toMatchObject({ ended_at: null, severity: "medium", source: "raw", peak_mspt_p95: 70 });
  });

  it("hysteresis: 40–50 keeps it open, a short dip doesn't close, 120 s under 40 closes", async () => {
    const s = await makeServer();
    let t = T0;
    const push = async (vals: number[]) => {
      await samples(s.serverId, t, vals);
      t += vals.length * 10 * S;
      return detectIncidents(handle.db, s.serverId, t);
    };
    await push(rep(4, 80));
    await push(rep(30, 45)); // 5 min in the 40–50 band
    await push([...rep(6, 30), 55]); // 60 s dip, then over again
    expect((await incidentsOf(s.serverId))[0]!.ended_at).toBeNull();
    await push(rep(11, 30)); // 110 s under
    expect((await incidentsOf(s.serverId))[0]!.ended_at).toBeNull();
    const r = await push([30]); // 120 s
    expect(r.closed).toHaveLength(1);
    const [inc] = await incidentsOf(s.serverId);
    expect(inc).toMatchObject({ end_reason: "recovered", peak_mspt_p95: 80 });
    const firstUnder = T0 + (4 + 30 + 7) * 10 * S - 10 * S; // window start of the first sample after the 55
    expect(iso(inc!.ended_at)).toBe(iso(firstUnder));
  });

  it("severity follows the peak while open", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, [60, 60, 60]);
    await detectIncidents(handle.db, s.serverId, T0 + 30 * S);
    await samples(s.serverId, T0 + 30 * S, [150]);
    await detectIncidents(handle.db, s.serverId, T0 + 40 * S);
    expect((await incidentsOf(s.serverId))[0]).toMatchObject({ severity: "high", peak_mspt_p95: 150 });
    await samples(s.serverId, T0 + 40 * S, [400]);
    await detectIncidents(handle.db, s.serverId, T0 + 50 * S);
    expect((await incidentsOf(s.serverId))[0]).toMatchObject({ severity: "critical", peak_mspt_p95: 400 });
  });

  it("closes as offline on a ≥ 5 min gap in samples (end = last sample) and via the tick when nothing arrives", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(5, 90));
    await detectIncidents(handle.db, s.serverId, T0 + 50 * S);
    const lastTs = T0 + 40 * S;
    await samples(s.serverId, lastTs + 6 * 60 * S, rep(4, 90)); // back after 6 min, still lagging
    const r = await detectIncidents(handle.db, s.serverId, lastTs + 7 * 60 * S);
    expect(r.closed).toHaveLength(1);
    expect(r.opened).toHaveLength(1); // new run after the gap
    const [first, second] = await incidentsOf(s.serverId);
    expect(first).toMatchObject({ end_reason: "offline" });
    expect(iso(first!.ended_at)).toBe(iso(lastTs));
    expect(second!.ended_at).toBeNull();

    // No more samples: the periodic tick closes it 5 min after the last one.
    const last2 = lastTs + 6 * 60 * S + 30 * S;
    expect((await detectorTick(handle.db, last2 + 4 * 60 * S)).closed).toHaveLength(0);
    const tick = await detectorTick(handle.db, last2 + 5 * 60 * S);
    expect(tick.closed).toEqual([second!.id]);
    const after = await incidentsOf(s.serverId);
    expect(after[1]).toMatchObject({ end_reason: "offline" });
    expect(iso(after[1]!.ended_at)).toBe(iso(last2));
  });

  it("is idempotent under replays and ignores samples older than the watermark", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(6, 70));
    await detectIncidents(handle.db, s.serverId, T0 + 60 * S);
    await samples(s.serverId, T0, rep(6, 70)); // retry: same ts → ON CONFLICT DO NOTHING
    const again = await detectIncidents(handle.db, s.serverId, T0 + 60 * S);
    expect(again).toMatchObject({ processed: 0, opened: [], closed: [] });
    // Late sample (older than the watermark) is ignored live.
    await handle.db.insert(metricSamples).values({ serverId: s.serverId, ts: new Date(T0 - 5 * S), mspt_p95: 999, detail: {} });
    expect((await detectIncidents(handle.db, s.serverId, T0 + 61 * S)).processed).toBe(0);
    const incs = await incidentsOf(s.serverId);
    expect(incs).toHaveLength(1);
    expect(incs[0]!.peak_mspt_p95).toBe(70);
  });

  it("handles a buffered catch-up batch (60 samples at once) with a whole incident inside", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0 - 10 * S, [20]);
    await detectIncidents(handle.db, s.serverId, T0 - 10 * S); // the server is known (watermark set)
    const vals = [...rep(10, 20), ...rep(20, 75), ...rep(30, 25)];
    await samples(s.serverId, T0, vals);
    const now = T0 + 30 * 60 * S; // arriving 30 min late
    const r = await detectIncidents(handle.db, s.serverId, now);
    expect(r).toMatchObject({ processed: 60, snapshotRequested: false });
    expect(r.opened).toHaveLength(1);
    expect(r.closed).toEqual(r.opened);
    const [inc] = await incidentsOf(s.serverId);
    expect(iso(inc!.started_at)).toBe(iso(T0 + 90 * S));
    expect(iso(inc!.ended_at)).toBe(iso(T0 + 290 * S));
    const [srv] = await q(sql`select snapshot_requested_at from servers where id = ${s.serverId}`);
    expect(srv!.snapshot_requested_at).toBeNull();
  });

  it("requests a snapshot once when none is linked 30 s after opening (live data only)", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(3, 70));
    await detectIncidents(handle.db, s.serverId, T0 + 20 * S); // opens at wall clock T0+20s
    await samples(s.serverId, T0 + 30 * S, [70]);
    expect((await detectIncidents(handle.db, s.serverId, T0 + 40 * S)).snapshotRequested).toBe(false);
    await samples(s.serverId, T0 + 40 * S, [70, 70]);
    expect((await detectIncidents(handle.db, s.serverId, T0 + 51 * S)).snapshotRequested).toBe(true);
    const [srv] = await q(sql`select snapshot_requested_at from servers where id = ${s.serverId}`);
    expect(srv!.snapshot_requested_at).not.toBeNull();
    await handle.db.execute(sql`update servers set snapshot_requested_at = null where id = ${s.serverId}`);
    await samples(s.serverId, T0 + 60 * S, [70]);
    expect((await detectIncidents(handle.db, s.serverId, T0 + 70 * S)).snapshotRequested).toBe(false); // only once
  });

  it("does not request a snapshot when one is linked", async () => {
    const s = await makeServer();
    await handle.db.insert(incidentSnapshots).values({ serverId: s.serverId, trigger: "threshold", capturedAt: new Date(T0 + 5 * S), msptP95AtTrigger: 70, snapshot: {} });
    await samples(s.serverId, T0, rep(8, 70));
    const r = await detectIncidents(handle.db, s.serverId, T0 + 120 * S);
    expect(r.snapshotRequested).toBe(false);
    expect((await getIncident(handle.db, r.opened[0]!))!.snapshotId).not.toBeNull();
  });
});

describe("catch-up, serialisation, offline", () => {
  const lagThenHealthy = (n: number, lag: number) => Array.from({ length: n }, (_, i) => (i < lag ? 80 : 15));

  it("two catch-up batches with the incident job in between give one incident (reopen when contiguous)", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0 - 10 * S, [15]);
    await detectIncidents(handle.db, s.serverId, T0 - 10 * S);
    const late = T0 + 60 * 60 * S; // the buffered data arrives an hour later
    await samples(s.serverId, T0, rep(60, 80)); // batch 1: 10 min of lag
    expect((await detectIncidents(handle.db, s.serverId, late)).opened).toHaveLength(1);
    // The job runs between the two requests: watermark is old and the agent wasn't seen → closes "offline".
    const job = await runIncidentJob(handle.db, { nowMs: late + 5 * S, rules: [], log: () => {} });
    expect(job!.closed).toHaveLength(1);
    await samples(s.serverId, T0 + 600 * S, lagThenHealthy(30, 10)); // batch 2 continues without a gap
    const r = await detectIncidents(handle.db, s.serverId, late + 10 * S);
    expect(r.reopened).toHaveLength(1);
    expect(r.closed).toEqual(r.reopened);
    const incs = await incidentsOf(s.serverId);
    expect(incs).toHaveLength(1);
    expect(incs[0]).toMatchObject({ end_reason: "recovered" });
    expect(iso(incs[0]!.ended_at)).toBe(iso(T0 + 690 * S)); // window start of the first healthy sample
  });

  it("never closes offline while unprocessed stored samples exist, or while the agent is still in contact", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(5, 80));
    await detectIncidents(handle.db, s.serverId, T0 + 50 * S);
    // Samples stored without detection (e.g. a backlog beyond one run): the tick processes them instead.
    await samples(s.serverId, T0 + 50 * S, rep(5, 80));
    const t = await detectorTick(handle.db, T0 + 20 * 60 * S);
    expect(t).toMatchObject({ closed: [], caughtUp: 1 });
    const [st] = await q(sql`select detector_watermark from server_analysis_state where server_id = ${s.serverId}`);
    expect(iso(st!.detector_watermark)).toBe(iso(T0 + 90 * S));
    // Agent in contact (last_seen_at fresh) → still not offline.
    await handle.db.execute(sql`update servers set last_seen_at = ${iso(T0 + 20 * 60 * S)} where id = ${s.serverId}`);
    expect((await detectorTick(handle.db, T0 + 21 * 60 * S)).closed).toEqual([]);
    expect((await detectorTick(handle.db, T0 + 26 * 60 * S)).closed).toHaveLength(1);
  });

  it("store + detect are serialised per server: an overlapping request can't skip uncommitted samples", async () => {
    const s = await makeServer();
    const processed: number[] = [];
    const slow: DetectHook = async (tx, serverId, nowMs, st) => {
      const r = await detectInTx(tx, serverId, nowMs, st);
      processed.push(r.processed);
      return r;
    };
    const env = (ts: number) => {
      const body = fixture("metrics");
      body.payload.samples = [{ ...body.payload.samples[0], ts: iso(ts) }];
      return body;
    };
    const principal = { serverId: s.serverId, keyId: "k", plan: "free" };
    const now = Date.parse("2026-11-09T14:10:00Z");
    // A stores ts=100 and holds the transaction for a while; B (ts=110) starts while A is still open.
    const a = storeMetrics(handle.db, principal, env(now - 20_000), now, async (tx, id, n, st) => {
      await new Promise((r) => setTimeout(r, 300));
      return slow(tx, id, n, st);
    });
    await new Promise((r) => setTimeout(r, 50));
    const b = storeMetrics(handle.db, principal, env(now - 10_000), now, slow);
    await Promise.all([a, b]);
    expect(processed).toEqual([1, 1]); // B waited for A, then saw A's sample as already processed
    const [st] = await q(sql`select detector_watermark from server_analysis_state where server_id = ${s.serverId}`);
    expect(iso(st!.detector_watermark)).toBe(iso(now - 10_000));
  });

  it("prefers the first snapshot captured after the start; the job re-links stragglers", async () => {
    const s = await makeServer();
    const snap = (at: number) => ({ serverId: s.serverId, trigger: "threshold", capturedAt: new Date(at), msptP95AtTrigger: 70, snapshot: {} });
    await handle.db.insert(incidentSnapshots).values([snap(T0 - 30 * S), snap(T0 + 15 * S)]);
    await samples(s.serverId, T0 + 10 * S, rep(4, 70)); // started_at = T0
    const r = await detectIncidents(handle.db, s.serverId, T0 + 40 * S);
    const after = await q(sql`select id from incident_snapshots where captured_at = ${iso(T0 + 15 * S)}`);
    expect((await getIncident(handle.db, r.opened[0]!))!.snapshotId).toBe(after[0]!.id);
    // A snapshot that slipped in unlinked (concurrent transactions): the incident job links it.
    await handle.db.insert(incidentSnapshots).values(snap(T0 + 35 * S));
    await runIncidentJob(handle.db, { nowMs: T0 + 45 * S, rules: [], log: () => {} });
    const [n] = await q(sql`select count(*)::int as n from incident_snapshots where incident_id = ${r.opened[0]!}`);
    expect(n!.n).toBe(3);
  });

  it("clamps the watermark to now (samples ahead of the clock wait)", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, [15, 15, 15]);
    await detectIncidents(handle.db, s.serverId, T0 + 10 * S);
    const [st] = await q(sql`select detector_watermark from server_analysis_state where server_id = ${s.serverId}`);
    expect(iso(st!.detector_watermark)).toBe(iso(T0 + 10 * S));
  });
});

describe("snapshot linking", () => {
  it("links a snapshot from up to 60 s before the start (at open) and copies the baseline", async () => {
    const s = await makeServer();
    // 2 h of healthy minutes so there is a baseline.
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 120 }, (_, i) => ({ serverId: s.serverId, bucket: new Date(T0 - (130 - i) * 60 * S), sampleCount: 6, mspt_p95_avg: 20 } as never)));
    const snap = (at: number) => ({ serverId: s.serverId, trigger: "threshold", capturedAt: new Date(at), msptP95AtTrigger: 70, snapshot: {} });
    await handle.db.insert(incidentSnapshots).values([snap(T0 - 90 * S), snap(T0 - 50 * S)]);
    await samples(s.serverId, T0 + 10 * S, rep(3, 70)); // started_at = T0
    const r = await detectIncidents(handle.db, s.serverId, T0 + 40 * S);
    const linked = await q(sql`select captured_at, incident_id, baseline from incident_snapshots where server_id = ${s.serverId} order by captured_at`);
    expect(linked[0]!.incident_id).toBeNull(); // 90 s before: outside the lead
    expect(linked[1]!.incident_id).toBe(r.opened[0]);
    expect(linked[1]!.baseline).toMatchObject({ healthyMinutes: 120, metrics: { mspt_p95: { median: 20, p90: 20 } } });
    const inc = await getIncident(handle.db, r.opened[0]!);
    expect(inc!.baseline).toEqual(linked[1]!.baseline);
  });

  it("links a snapshot that arrives during the incident (ingest) and unlinks one captured after the end", async () => {
    const s = await makeServer();
    const app = makeApp({ detect: false });
    await samples(s.serverId, T0, rep(4, 70));
    const r = await detectIncidents(handle.db, s.serverId, T0 + 40 * S);
    const body = fixture("snapshot");
    body.payload.ts = iso(T0 + 25 * S);
    body.payload.sample.ts = iso(T0 + 25 * S);
    const res = await app.request("/v1/ingest/snapshot", {
      method: "POST",
      headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const [row] = await q(sql`select incident_id from incident_snapshots where server_id = ${s.serverId}`);
    expect(row!.incident_id).toBe(r.opened[0]);

    // A snapshot during the recovery run: linked while open, dropped at close (it is after endedAt).
    await samples(s.serverId, T0 + 40 * S, rep(13, 20));
    await handle.db.insert(incidentSnapshots).values({ serverId: s.serverId, trigger: "manual", capturedAt: new Date(T0 + 100 * S), msptP95AtTrigger: 20, snapshot: {} });
    await handle.db.execute(sql`update incident_snapshots set incident_id = ${r.opened[0]!} where captured_at = ${iso(T0 + 100 * S)}`);
    await detectIncidents(handle.db, s.serverId, T0 + 200 * S);
    const rows2 = await q(sql`select captured_at, incident_id from incident_snapshots where server_id = ${s.serverId} order by captured_at`);
    expect(rows2.map((x) => x.incident_id)).toEqual([r.opened[0], null]);
  });
});

describe("baseline", () => {
  it("is null with fewer than 30 healthy minutes and ignores minutes near incidents", async () => {
    const s = await makeServer();
    const minute = (ago: number, p95: number) => ({ serverId: s.serverId, bucket: new Date(T0 - ago * 60 * S), sampleCount: 6, mspt_p95_avg: p95, players_avg: 3 } as never);
    await handle.db.insert(metricRollups1m).values([...Array.from({ length: 25 }, (_, i) => minute(20 + i, 15)), ...Array.from({ length: 30 }, (_, i) => minute(60 + i, 35))]);
    expect(await buildBaseline(handle.db, s.serverId, T0)).toBeNull();

    await handle.db.insert(metricRollups1m).values(Array.from({ length: 40 }, (_, i) => minute(200 + i, 10 + (i % 10))));
    const b = await buildBaseline(handle.db, s.serverId, T0);
    expect(b!.healthyMinutes).toBe(65);
    expect(b!.metrics.players).toEqual({ median: 3, p90: 3 });
    expect(b!.entitiesByType).toBeUndefined(); // no raw data

    // An incident 200–240 min ago removes those minutes (and 10 min around it).
    await handle.db.execute(sql`insert into incidents (server_id, started_at, ended_at, end_reason, severity, peak_mspt_p95, source)
      values (${s.serverId}, ${iso(T0 - 235 * 60 * S)}, ${iso(T0 - 205 * 60 * S)}, 'recovered', 'medium', 60, 'raw')`);
    expect(await buildBaseline(handle.db, s.serverId, T0)).toBeNull();
  });

  it("adds per-type and per-world medians from raw detail, plugins/config/jvm from server info", async () => {
    const s = await makeServer();
    const start = T0 - 3 * 3600 * S;
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 60 }, (_, i) => ({ serverId: s.serverId, bucket: new Date(start + i * 60 * S), sampleCount: 6, mspt_p95_avg: 12 } as never)));
    await handle.db.insert(metricSamples).values(
      Array.from({ length: 60 }, (_, i) => ({
        serverId: s.serverId,
        ts: new Date(start + i * 60 * S + 5 * S),
        mspt_p95: 12,
        detail: { world: [{ name: "world", loadedChunks: 100 + i, entities: 50, entitiesByType: { "minecraft:item": i < 30 ? 10 : 20, other: 40 }, tileEntitiesByType: { "minecraft:hopper": 7 } }] },
      })),
    );
    await handle.db.insert(serverInfoHistory).values({
      serverId: s.serverId,
      validFrom: new Date(start - 3600 * S),
      info: { plugins: [{ name: "LuckPerms", version: "5.5", enabled: true }], config: { viewDistance: 10, simulationDistance: 8 }, jvm: { heapMaxBytes: 4, heapInitBytes: 1 } },
      infoHash: "h",
    });
    const b = await buildBaseline(handle.db, s.serverId, T0);
    expect(b!.entitiesByType).toEqual({ "minecraft:item": 15, other: 40 });
    expect(b!.tileEntitiesByType).toEqual({ "minecraft:hopper": 7 });
    expect(b!.worlds).toEqual([{ name: "world", loadedChunks: 129.5, entities: 50, tileEntities: 7 }]);
    expect(b!.plugins).toEqual([{ name: "LuckPerms", version: "5.5" }]);
    expect(b!.config).toEqual({ viewDistance: 10, simulationDistance: 8 });
    expect(b!.jvm).toEqual({ heapMaxBytes: 4, heapInitBytes: 1 });
  });
});

describe("ingest integration", () => {
  it("POST /v1/ingest/metrics runs the detector and logs the opened incident", async () => {
    const s = await makeServer();
    const lines: string[] = [];
    const app = makeApp({ log: (l) => lines.push(l), now: () => Date.parse("2026-11-09T14:01:00Z") });
    const body = fixture("metrics");
    const base = body.payload.samples[0];
    body.payload.samples = [0, 1, 2, 3].map((i) => ({ ...base, ts: iso(Date.parse("2026-11-09T14:00:10Z") + i * 10 * S), tick: { ...base.tick, msptP95: 90 } }));
    const res = await app.request("/v1/ingest/metrics", {
      method: "POST",
      headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(lines.at(-1)).toMatch(/incidentOpened=/);
    expect(await incidentsOf(s.serverId)).toHaveLength(1);
  });

  it("a failing detector never fails the ingest", async () => {
    const s = await makeServer();
    const lines: string[] = [];
    const app = makeApp({ log: (l) => lines.push(l), detect: async () => { throw new Error("boom"); } });
    const res = await app.request("/v1/ingest/metrics", {
      method: "POST",
      headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify(freshFixture("metrics")), // dated now: an old fixture would fall outside raw retention
    });
    expect(res.status).toBe(200);
    expect(lines.some((l) => l.includes("incident detection failed") && l.includes("boom"))).toBe(true);
  });

  it("detector overhead per metrics push stays small", async () => {
    const s = await makeServer();
    // Some history so the queries are realistic: 1 day of raw samples.
    await samples(s.serverId, T0 - 86_400 * S, rep(8640, 15));
    await detectIncidents(handle.db, s.serverId, T0);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      await samples(s.serverId, T0 + i * 10 * S, [15]);
      const t = performance.now();
      await detectIncidents(handle.db, s.serverId, T0 + i * 10 * S);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[20]!;
    // Reference: an empty transaction with the same timeouts (pure round-trip cost to Postgres).
    const ref: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await ingestTx(handle.db, async (tx) => tx.execute(sql`select 1`));
      ref.push(performance.now() - t);
    }
    ref.sort((a, b) => a - b);
    console.log(`detector per push: median ${median.toFixed(2)} ms, max ${times.at(-1)!.toFixed(2)} ms (empty tx: ${ref[10]!.toFixed(2)} ms)`);
    expect(median).toBeLessThan(25);
  });
});

describe("backfill", () => {
  it("finds incidents from rollups (older) and raw (newer), and is idempotent / non-destructive", async () => {
    const s = await makeServer();
    const minute = (i: number, p95: number) => ({ serverId: s.serverId, bucket: new Date(T0 - 3 * 3600 * S + i * 60 * S), sampleCount: 6, mspt_p95_avg: p95, mspt_p95_max: p95 + 100 } as never);
    // Rollups for 2 h with one lag episode (minutes 30–39), raw from T0 - 1 h with another.
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 120 }, (_, i) => minute(i, i >= 30 && i < 40 ? 70 : 15)));
    const rawStart = T0 - 3600 * S;
    await samples(s.serverId, rawStart, [...rep(100, 15), ...rep(12, 66), ...rep(200, 15)]);
    const r = await backfillIncidents(handle.db, s.serverId, { from: T0 - 4 * 3600 * S, to: T0, nowMs: T0 });
    expect(r.created).toHaveLength(2);
    const incs = await incidentsOf(s.serverId);
    expect(incs.map((i) => i.source)).toEqual(["rollup_1m", "raw"]);
    expect(iso(incs[0]!.started_at)).toBe(iso(T0 - 3 * 3600 * S + 30 * 60 * S));
    expect(iso(incs[0]!.ended_at)).toBe(iso(T0 - 3 * 3600 * S + 40 * 60 * S));
    expect(incs[0]).toMatchObject({ peak_mspt_p95: 170, severity: "high", end_reason: "recovered" });
    expect(incs[1]).toMatchObject({ peak_mspt_p95: 66, severity: "medium" });

    const again = await backfillIncidents(handle.db, s.serverId, { from: T0 - 4 * 3600 * S, to: T0, nowMs: T0 });
    expect(again).toMatchObject({ created: [], skippedOverlap: 2 });
    expect(await incidentsOf(s.serverId)).toHaveLength(2);
  });

  it("opens on 1-min rollups with tps_1m_avg < 18 (trigger tps)", async () => {
    const s = await makeServer();
    const minute = (i: number, tps: number) => ({ serverId: s.serverId, bucket: new Date(T0 + i * 60 * S), sampleCount: 6, mspt_p95_avg: 8, tps_1m_avg: tps, tps_1m_min: tps - 2 } as never);
    await handle.db.insert(metricRollups1m).values(Array.from({ length: 30 }, (_, i) => minute(i, i >= 10 && i < 14 ? 13 : 20)));
    const r = await backfillIncidents(handle.db, s.serverId, { from: T0, to: T0 + 30 * 60 * S, nowMs: T0 + 30 * 60 * S });
    expect(r.created).toHaveLength(1);
    expect(await getIncident(handle.db, r.created[0]!)).toMatchObject({ trigger: "tps", minTps1m: 11, severity: "high", source: "rollup_1m", startedAt: iso(T0 + 10 * 60 * S), endedAt: iso(T0 + 14 * 60 * S) });
  });

  it("leaves an ongoing incident to the live detector, closes it offline if data stopped", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(10, 80));
    expect((await backfillIncidents(handle.db, s.serverId, { from: T0 - 60 * S, to: T0 + 120 * S })).ongoing).toBe(true);
    const r = await backfillIncidents(handle.db, s.serverId, { from: T0 - 60 * S, to: T0 + 20 * 60 * S });
    expect(r.created).toHaveLength(1);
    expect((await incidentsOf(s.serverId))[0]).toMatchObject({ end_reason: "offline" });
  });
});

describe("retention and cascade", () => {
  it("drops closed incidents and confirmed findings past incidentRetentionDays; keeps open ones", async () => {
    const s = await makeServer({ plan: "free" }); // 7 days
    const now = Date.now();
    const ago = (d: number) => iso(now - d * 86_400_000);
    await handle.db.execute(sql`insert into incidents (server_id, started_at, ended_at, end_reason, severity, peak_mspt_p95, source) values
      (${s.serverId}, ${ago(10)}, ${ago(9.9)}, 'recovered', 'medium', 60, 'raw'),
      (${s.serverId}, ${ago(2)}, ${ago(1.9)}, 'recovered', 'medium', 60, 'raw'),
      (${s.serverId}, ${ago(20)}, null, null, 'medium', 60, 'raw')`);
    const f = (status: string, confirmed: string | null) => sql`(${s.serverId}, 'jvm-flags', 'server', ${status + String(confirmed)}, 'low', 't', 'e', '{"numbers":[]}', 'fix', ${status}, ${ago(30)}, ${ago(30)}, ${confirmed}::timestamptz)`;
    await handle.db.execute(sql`insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix, status, first_seen_at, last_seen_at, confirmed_fixed_at) values
      ${f("confirmed_fixed", ago(8))}, ${f("confirmed_fixed", ago(1))}, ${f("open", null)}, ${f("marked_fixed", null)}`);
    const r = await runRetention(handle.db, { now });
    expect(r.deleted).toMatchObject({ incidents: 1, findings: 1 });
    expect(await incidentsOf(s.serverId)).toHaveLength(2);
    expect((await q(sql`select status from findings where server_id = ${s.serverId} order by status`)).map((x) => x.status)).toEqual(["confirmed_fixed", "marked_fixed", "open"]);
  });

  it("deleting the account removes incidents, findings, links and detector state", async () => {
    const s = await makeServer();
    await samples(s.serverId, T0, rep(5, 80));
    const r = await detectIncidents(handle.db, s.serverId, T0 + 50 * S);
    const [fnd] = await q(sql`insert into findings (server_id, rule_id, scope, dedup_key, severity, title, explanation, evidence, suggested_fix, first_seen_at, last_seen_at)
      values (${s.serverId}, 'gc-pressure', 'incident', 'k', 'medium', 't', 'e', '{"numbers":[]}', 'f', now(), now()) returning id`);
    await handle.db.execute(sql`insert into finding_incidents values (${fnd!.id}, ${r.opened[0]!})`);
    await handle.db.execute(sql`delete from users where id = ${s.ownerId}`);
    for (const t of ["incidents", "findings", "server_analysis_state"]) {
      const [n] = await q(sql`select count(*)::int as n from ${sql.identifier(t)} where server_id = ${s.serverId}`);
      expect(n!.n, t).toBe(0);
    }
    const [n] = await q(sql`select count(*)::int as n from finding_incidents`);
    expect(n!.n).toBe(0);
  });
});
