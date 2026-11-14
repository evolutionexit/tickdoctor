import { describe, expect, test } from "vitest";
import { swapInUse } from "../../src/rules/swap-in-use.js";
import { GB, MB } from "../../src/rules/util.js";
import { MIN, T0, assertValid, handCtx, healthyM, minuteSample, rawSeries } from "./helpers.js";

const series = (fn: (i: number) => { swap?: number; avail?: number }, swapTotal = 2 * GB, n = 180) =>
  rawSeries(n, (i) => {
    const x = fn(i);
    return {
      m: healthyM({ ...(x.swap !== undefined ? { swap_used_bytes: x.swap } : {}), ...(x.avail !== undefined ? { mem_available_bytes: x.avail } : {}) }),
      detail: { host: { memTotalBytes: 8 * GB, swapTotalBytes: swapTotal } },
    };
  });

describe("swap-in-use", () => {
  test("600 MB swapped and only 300 MB available: fires (medium without lag, high in an incident)", () => {
    const samples = series(() => ({ swap: 600 * MB, avail: 300 * MB }));
    const fs = swapInUse.evaluate(handCtx({ samples }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["memory-pressure", "medium"]]);
    expect(fs[0]!.evidence.chart?.metric).toBe("swap_used_bytes");
    expect(swapInUse.evaluate(handCtx({ scope: "incident", samples, incident: { start: T0 - 10 * MIN, end: T0 } }))[0]!.severity).toBe("high");
  });

  test("lots of swap but plenty of memory free and flat: old idle pages, nothing", () => {
    expect(swapInUse.evaluate(handCtx({ samples: series(() => ({ swap: 900 * MB, avail: 3 * GB })) }))).toEqual([]);
  });

  test("seed-like noise (300–500 MB, random per minute) with 2.5 GB free: nothing", () => {
    expect(swapInUse.evaluate(handCtx({ samples: series((i) => ({ swap: (300 + ((i * 7919) % 200)) * MB, avail: 2.5 * GB })) }))).toEqual([]);
  });

  test("swap growing by 700 MB within the window: fires even with memory still available", () => {
    const fs = swapInUse.evaluate(handCtx({ samples: series((i) => ({ swap: (200 + i * 4) * MB, avail: 2 * GB })) }));
    expect(fs.map((f) => f.dedupKey)).toEqual(["memory-pressure"]);
    expect(fs[0]!.explanation).toContain("grew by");
  });

  test("a few MB of zram, or a small share of a huge swap file: nothing", () => {
    expect(swapInUse.evaluate(handCtx({ samples: series(() => ({ swap: 12 * MB, avail: 200 * MB })) }))).toEqual([]);
    expect(swapInUse.evaluate(handCtx({ samples: series(() => ({ swap: 300 * MB, avail: 200 * MB }), 16 * GB) }))).toEqual([]);
  });

  test("no swap metric (Windows / not reported), too few samples: nothing", () => {
    expect(swapInUse.evaluate(handCtx({ samples: series(() => ({ avail: 100 * MB })) }))).toEqual([]);
    expect(swapInUse.evaluate(handCtx({ samples: series(() => ({ swap: GB, avail: 100 * MB }), 2 * GB, 2) }))).toEqual([]);
  });

  test("rollup-only window with pressure, RAM from hello: fires", () => {
    const samples = Array.from({ length: 30 }, (_, i) => minuteSample(T0 - (29 - i) * MIN, healthyM({ swap_used_bytes: GB, mem_available_bytes: 200 * MB })));
    expect(swapInUse.evaluate(handCtx({ samples })).map((f) => f.dedupKey)).toEqual(["memory-pressure"]);
  });
});
