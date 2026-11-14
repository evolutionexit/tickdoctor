import { describe, expect, test } from "vitest";
import { liveChunkGeneration } from "../../src/rules/live-chunk-generation.js";
import { GB } from "../../src/rules/util.js";
import { MIN, T0, assertValid, baselineOf, handCtx, healthyM, piHello, rawSeries } from "./helpers.js";

const inc = { start: T0 - 8 * MIN, end: T0, peak: 90 };
const gen = (rate: number, p95 = 85) =>
  rawSeries(60, () => ({
    m: healthyM({ mspt_p95: p95, chunk_gen_per_min: rate, players: 2 }),
    detail: { worlds: [{ name: "world", loadedChunks: 900, entities: 300, entitiesByType: {}, tileEntitiesByType: {}, chunkGenPerMinute: rate, countsAgeSeconds: 4 }] },
  }));
const vps = piHello({ model: "", arch: "amd64", cores: 4, ram: 8 * GB });
delete (vps.host as { model?: string }).model;

describe("live-chunk-generation", () => {
  test("Pi lagging while generating 45 chunks/min → medium, with a Chunky plan", () => {
    const fs = liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: gen(45) }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["chunk-generation", "medium"]]);
    expect(fs[0]!.suggestedFix).toContain("/chunky radius");
    expect(fs[0]!.suggestedFix).toContain("/worldborder set");
    // One world generating: no per-world line that would just repeat the total.
    expect(fs[0]!.evidence.numbers.map((n) => n.label).filter((l) => l.startsWith("New chunks per minute in"))).toEqual([]);
  });

  test("100/min on a Pi → high", () => {
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: gen(100) }))[0]!.severity).toBe("high");
  });

  test("normal exploring: 15/min on a Pi, 35/min on a 4-core VPS → nothing", () => {
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: gen(15) }))).toEqual([]);
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: gen(35), info: vps }))).toEqual([]);
  });

  test("a server that always generates a lot (baseline p90 30/min): 50/min is its normal", () => {
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: gen(50), info: vps, baseline: baselineOf({ chunk_gen_per_min: 25 }) }))).toEqual([]);
  });

  test("server scope / no chunk-gen metric (older agent): nothing", () => {
    expect(liveChunkGeneration.evaluate(handCtx({ samples: gen(200) }))).toEqual([]);
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: { mspt_p95: 90 } })) }))).toEqual([]);
  });
});

describe("live-chunk-generation: who is generating", () => {
  const withPlayers = (players: number) =>
    rawSeries(60, (i) => ({
      m: healthyM({ mspt_p95: 85, chunk_gen_per_min: 45, players, ...(i % 6 === 0 ? { mspt_max: 2500 } : {}) }),
      detail: { worlds: [{ name: "world", loadedChunks: 900, entities: 300, entitiesByType: {}, tileEntitiesByType: {}, chunkGenPerMinute: 45, countsAgeSeconds: 4 }] },
    }));

  test("players online: explains exploring, fix starts with Chunky", () => {
    const f = liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: withPlayers(3) }))[0]!;
    expect(f.explanation).toContain("players explore land nobody has visited before");
    // Rule out force-loads and plugins before suggesting Chunky.
    expect(f.suggestedFix).toMatch(/^1\. First rule out the server itself: run `\/forceload query`/);
    expect(f.suggestedFix).toMatch(/\n2\. Install the Chunky plugin/);
  });

  test("nobody online: points at force-loads / pre-generation / plugins first", () => {
    const f = liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples: withPlayers(0) }))[0]!;
    assertValid(f);
    expect(f.explanation).toContain("while no players were online");
    expect(f.explanation).not.toContain("players explore");
    expect(f.suggestedFix).toMatch(/^1\. Find what loads the chunks: run `\/forceload query`/);
    expect(f.suggestedFix).toContain("/chunky center <x> <z>");
  });

  test("player count not reported: keeps the exploring wording", () => {
    const samples = withPlayers(0).map((s) => {
      const { players: _p, ...m } = s.m;
      return { ...s, m };
    });
    expect(liveChunkGeneration.evaluate(handCtx({ scope: "incident", incident: inc, samples }))[0]!.explanation).toContain("players explore");
  });
});
