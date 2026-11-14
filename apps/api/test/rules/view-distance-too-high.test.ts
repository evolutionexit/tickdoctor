import { describe, expect, test } from "vitest";
import { viewDistanceTooHigh } from "../../src/rules/view-distance-too-high.js";
import { GB } from "../../src/rules/util.js";
import { MIN, T0, assertValid, baselineOf, handCtx, healthyM, piHello, rawSeries } from "./helpers.js";

const inc = { start: T0 - 10 * MIN, end: T0, peak: 90 };
const load = (o: { chunks?: number; gen?: number; pile?: number; entities?: number } = {}) =>
  rawSeries(60, () => ({
    m: healthyM({ mspt_p95: 75, mspt_avg: 40, players: 6, loaded_chunks: o.chunks ?? 2600, chunk_gen_per_min: o.gen ?? 3, entities: o.entities ?? 900 }),
    detail: { worstChunks: o.pile ? [{ world: "world", x: 1, z: 1, entities: o.pile, tileEntities: 0 }] : [] },
  }));
const run = (info = piHello({ view: 12, sim: 10 }), samples = load(), baseline = baselineOf({ entities: 700, players: 4, loaded_chunks: 1200 })) =>
  viewDistanceTooHigh.evaluate(handCtx({ scope: "incident", incident: inc, samples, info, baseline }));

describe("view-distance-too-high", () => {
  test("Pi at view 12 / sim 10, 2,600 chunks loaded while lagging → medium, concrete server.properties values", () => {
    const fs = run();
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["distance-settings", "medium"]]);
    expect(fs[0]!.suggestedFix).toContain("`simulation-distance=6` and `view-distance=8`");
    expect(fs[0]!.explanation).toContain("Raspberry Pi 5 Model B");
  });

  test("≥ 2× the chunk budget → high", () => {
    expect(run(undefined, load({ chunks: 3200 }))[0]!.severity).toBe("high");
  });

  test("the real Pi's view 8 / sim 6 is within limits: nothing, even when lagging", () => {
    expect(run(piHello())).toEqual([]);
  });

  test("lag better explained by chunk generation or an entity pile: nothing", () => {
    expect(run(undefined, load({ gen: 60 }))).toEqual([]);
    expect(run(undefined, load({ pile: 400 }))).toEqual([]);
    expect(run(undefined, load({ entities: 9000 }))).toEqual([]);
  });

  test("few chunks loaded, or a 16-core machine at view 12 / sim 10: nothing", () => {
    expect(run(undefined, load({ chunks: 900 }))).toEqual([]);
    const big = piHello({ model: "", arch: "amd64", cores: 16, ram: 64 * GB, view: 12, sim: 10 });
    delete (big.host as { model?: string }).model;
    expect(run(big, load({ chunks: 7000 }))).toEqual([]);
  });

  test("server scope, borderline lag (p95 55 with a 35 ms average), no hello: nothing", () => {
    expect(viewDistanceTooHigh.evaluate(handCtx({ samples: load(), info: piHello({ view: 12, sim: 10 }) }))).toEqual([]);
    const mild = rawSeries(60, () => ({ m: healthyM({ mspt_p95: 55, mspt_avg: 35, loaded_chunks: 2600 }) }));
    expect(run(undefined, mild)).toEqual([]);
    expect(viewDistanceTooHigh.evaluate(handCtx({ scope: "incident", incident: inc, samples: load(), info: null }))).toEqual([]);
  });
});
