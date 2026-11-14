import { describe, expect, test } from "vitest";
import type { SnapshotPayload } from "@tickdoctor/shared";
import { tileEntityHotspot } from "../../src/rules/tile-entity-hotspot.js";
import { MIN, T0, assertValid, baselineOf, handCtx, healthyM, minuteSample, rawSeries } from "./helpers.js";

const inc = { start: T0 - 5 * MIN, end: T0, peak: 90 };
const lag = () => rawSeries(30, () => ({ m: healthyM({ mspt_p95: 80 }) }));
const snap = (topChunks: { x: number; z: number; byType: Record<string, number> }[], tiles: Record<string, number> = {}) =>
  ({
    trigger: "threshold", ts: new Date(T0).toISOString(), msptP95AtTrigger: 80, sample: {}, recentEvents: [],
    worldsDetail: [{ name: "world", entitiesByType: {}, tileEntitiesByType: tiles, topChunks: topChunks.map((c) => ({ ...c, entities: 0, tileEntities: Object.values(c.byType).reduce((a, b) => a + b, 0) })) }],
  }) as unknown as SnapshotPayload;

describe("tile-entity-hotspot", () => {
  test("180 hoppers in one chunk → medium, 350 → high; fix mentions the Paper/Spigot hopper settings", () => {
    const fs = tileEntityHotspot.evaluate(handCtx({ scope: "incident", incident: inc, samples: lag(), snapshot: snap([{ x: 5, z: 7, byType: { hopper: 180, chest: 40 } }], { hopper: 400 }) }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["world:hopper", "medium"]]);
    expect(fs[0]!.evidence.chunks).toEqual([{ world: "world", x: 5, z: 7 }]);
    expect(fs[0]!.suggestedFix).toContain("hopper.ignore-occluding-blocks");
    expect(fs[0]!.suggestedFix).toContain("ticks-per.hopper-check");
    const high = tileEntityHotspot.evaluate(handCtx({ scope: "incident", incident: inc, samples: lag(), snapshot: snap([{ x: 5, z: 7, byType: { "minecraft:hopper": 350 } }]) }));
    expect(high[0]!.severity).toBe("high");
  });

  test("a storage room with 600 chests and barrels: chests don't tick, nothing", () => {
    expect(tileEntityHotspot.evaluate(handCtx({ scope: "incident", incident: inc, samples: lag(), snapshot: snap([{ x: 1, z: 1, byType: { chest: 450, barrel: 150 } }]) }))).toEqual([]);
  });

  test("320 furnaces in one chunk fires as furnaces", () => {
    const fs = tileEntityHotspot.evaluate(handCtx({ scope: "incident", incident: inc, samples: lag(), snapshot: snap([{ x: 2, z: 2, byType: { furnace: 320 } }]) }));
    expect(fs.map((f) => [f.dedupKey, f.title])).toEqual([["world:furnace", "Too many furnaces packed into one chunk"]]);
  });

  test("raw worstChunks without types: needs ≥ 800 block entities", () => {
    const mk = (n: number) => handCtx({ scope: "incident", incident: inc, samples: rawSeries(20, () => ({ m: healthyM({ mspt_p95: 80 }), detail: { worstChunks: [{ world: "world", x: 0, z: 0, entities: 3, tileEntities: n }] } })) });
    expect(tileEntityHotspot.evaluate(mk(500))).toEqual([]);
    expect(tileEntityHotspot.evaluate(mk(900)).map((f) => f.dedupKey)).toEqual(["world:mixed"]);
  });

  test("world-wide hopper surge vs baseline", () => {
    const fs = tileEntityHotspot.evaluate(handCtx({
      scope: "incident", incident: inc, samples: lag(),
      baseline: baselineOf({}, { tileEntitiesByType: { hopper: 200 } }),
      snapshot: snap([{ x: 9, z: 9, byType: { hopper: 60 } }], { hopper: 900 }),
    }));
    expect(fs.map((f) => f.title)).toEqual(["Too many hoppers packed into one chunk"]);
    expect(fs[0]!.explanation).toContain("usually the server has about 200");
  });

  test("seed-like snapshot (64 block entities per chunk, 210 hoppers in the world) and server scope: nothing", () => {
    expect(tileEntityHotspot.evaluate(handCtx({ scope: "incident", incident: inc, samples: lag(), snapshot: snap([{ x: -40, z: 112, byType: { item: 3000 } }], { hopper: 210, chest: 180 }) }))).toEqual([]);
    expect(tileEntityHotspot.evaluate(handCtx({ samples: lag(), snapshot: snap([{ x: 5, z: 7, byType: { hopper: 500 } }]) }))).toEqual([]);
  });
});

describe("tile-entity-hotspot, server scope (early warning)", () => {
  // worstChunks carry only totals; the hopper share comes from the world's tileEntitiesByType.
  const series = (perChunk: number, chunksN: number, avg: number, hopperShare = 0.95) =>
    rawSeries(60, () => ({
      m: healthyM({ mspt_avg: avg, mspt_p95: avg * 1.3 }),
      detail: {
        worlds: [{ name: "world", loadedChunks: 400, entities: 50, entitiesByType: {}, tileEntitiesByType: { hopper: Math.round(perChunk * chunksN * hopperShare), chest: Math.round(perChunk * chunksN * (1 - hopperShare)) }, countsAgeSeconds: 4 }],
        worstChunks: Array.from({ length: chunksN }, (_, i) => ({ world: "world", x: i, z: 0, entities: 0, tileEntities: perChunk })),
      },
    }));
  const hist = (avg: number) => Array.from({ length: 120 }, (_, i) => minuteSample(T0 - (120 - i) * MIN, { mspt_avg: avg }));

  test("1,300 hoppers per chunk, average tick +3.5 ms: low early warning", () => {
    const fs = tileEntityHotspot.evaluate(handCtx({ samples: series(1300, 4, 3.6), history: hist(0.1) }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["world:hopper", "low"]]);
  });

  test("a normal server with a few hopper farms (150 per chunk): silent even though ticks cost more", () => {
    expect(tileEntityHotspot.evaluate(handCtx({ samples: series(150, 3, 12), history: hist(8) }))).toEqual([]);
  });

  test("extreme concentration but no measurable cost (+0.5 ms): silent", () => {
    expect(tileEntityHotspot.evaluate(handCtx({ samples: series(1300, 4, 9.5), history: hist(9) }))).toEqual([]);
  });

  test("a huge storage room (1,500 chests, few hoppers) is not ticking: silent", () => {
    expect(tileEntityHotspot.evaluate(handCtx({ samples: series(1500, 1, 4, 0.02), history: hist(0.5) }))).toEqual([]);
  });
});
