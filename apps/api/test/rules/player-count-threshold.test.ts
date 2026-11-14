import { describe, expect, test } from "vitest";
import type { RuleEvent } from "../../src/rules/types.js";
import { playerCountThreshold } from "../../src/rules/player-count-threshold.js";
import { H, MIN, T0, assertValid, handCtx, minuteSample, piHello } from "./helpers.js";

/** 7 days; evenings ramp to `peak` players; p95 from `p95Of(players, t)`. */
function week(peak: number, p95Of: (players: number, t: number) => number) {
  const out = [];
  for (let t = T0 - 7 * 24 * H; t <= T0; t += MIN) {
    const h = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const act = Math.max(0, Math.sin(((h - 8) / 24) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5);
    const players = Math.round(peak * act ** 1.5);
    const p95 = p95Of(players, t);
    out.push(minuteSample(t, { players, mspt_p95: p95, mspt_avg: p95 / 1.6 }));
  }
  return out;
}
const knee = (p: number) => (p >= 12 ? 85 : 15 + 2 * p);
const incAt = (players: number) => ({ start: T0 - 20 * MIN, end: T0, players });
const run = (history: ReturnType<typeof week>, players = 13, events: RuleEvent[] = []) =>
  playerCountThreshold.evaluate(
    handCtx({
      scope: "incident",
      incident: incAt(players),
      samples: Array.from({ length: 30 }, (_, i) => minuteSample(T0 - (29 - i) * MIN, { players, mspt_p95: 85, mspt_avg: 50 })),
      history,
      events,
      info: piHello({ sim: 8 }),
    }),
  );

describe("player-count-threshold", () => {
  test("lags every evening from 12 players on, fine below → 'above about 11 players'", () => {
    const fs = run(week(15, knee));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity, f.title])).toEqual([["capacity", "medium", "The server starts lagging above about 11 players"]]);
    expect(fs[0]!.suggestedFix).toContain("simulation-distance");
    expect(fs[0]!.suggestedFix).toContain("max-players=11");
    expect(fs[0]!.evidence.chart?.metric).toBe("players");
  });

  test("MSPT rising gently with players but staying healthy (seed-like, p95 ≤ 45): nothing", () => {
    expect(run(week(15, (p) => 10 + 2.3 * p))).toEqual([]);
  });

  test("borderline p95 50–58 with a ~35 ms average (TPS stays 20): nothing", () => {
    expect(run(week(20, (p) => 10 + 2.4 * p).map((s) => ({ ...s, m: { ...s.m, mspt_avg: Math.min(36, s.m.mspt_avg!) } })))).toEqual([]);
  });

  test("one bad evening only (a farm, a heat wave): nothing", () => {
    const oneEvening = (p: number, t: number) => (t > T0 - 30 * H && t < T0 - 20 * H && p >= 12 ? 85 : 15 + 2 * p);
    expect(run(week(15, oneEvening))).toEqual([]);
  });

  test("capacity dropped after a plugin update (fine with 12+ players before it): left to plugin-change-before-lag", () => {
    const change = T0 - 3 * 24 * H;
    const afterChange = (p: number, t: number) => (t >= change && p >= 12 ? 85 : 15 + 2 * p);
    const ev: RuleEvent = { type: "plugins_changed", ts: new Date(change).toISOString(), added: [], removed: [], updated: [{ name: "X", from: "1", to: "2" }] };
    expect(run(week(15, afterChange), 13, [ev])).toEqual([]);
  });

  test("this incident happened with few players: not a capacity problem", () => {
    expect(run(week(15, knee), 4)).toEqual([]);
  });

  test("no or short history, server scope: nothing", () => {
    expect(run([])).toEqual([]);
    expect(run(week(15, knee).slice(-60))).toEqual([]);
    expect(playerCountThreshold.evaluate(handCtx({ samples: [], history: week(15, knee) }))).toEqual([]);
  });
});
