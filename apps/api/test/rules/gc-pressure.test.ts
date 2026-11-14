import { describe, expect, test } from "vitest";
import { gcPressure } from "../../src/rules/gc-pressure.js";
import { GB } from "../../src/rules/util.js";
import { MIN, T0, assertValid, handCtx, healthyM, minuteSample, piHello, rawSeries } from "./helpers.js";

const series = (n: number, heap: (i: number) => number, gc: number, heapMax = 4 * GB, ram = 16 * GB) =>
  rawSeries(n, (i) => ({
    m: healthyM({ heap_used_bytes: heap(i) * heapMax, heap_max_bytes: heapMax, gc_pause_ms: gc }),
    detail: { gcPauses: [{ collector: "G1 Young Generation", count: 4, totalMs: gc, maxMs: gc / 3 }], host: { memTotalBytes: ram } },
  }));
const full = (i: number) => 0.86 + ((i * 37) % 10) / 100; // 86–95 %
const saw = (i: number) => 0.35 + ((i % 15) / 15) * 0.35; // healthy sawtooth 35–70 %

describe("gc-pressure", () => {
  test("heap ≥ 86 % after clean-ups and 4 % of the time frozen: heap-too-small (medium without lag)", () => {
    const fs = gcPressure.evaluate(handCtx({ samples: series(180, full, 400), info: piHello({ ram: 16 * GB }) }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["heap-too-small", "medium"]]);
    expect(fs[0]!.suggestedFix).toContain("`-Xmx4G` to `-Xmx6G`");
    expect(fs[0]!.evidence.chart?.metric).toBe("heap_used_bytes");
  });

  test("≥ 5 % frozen, or during an incident: high", () => {
    expect(gcPressure.evaluate(handCtx({ samples: series(180, full, 700) }))[0]!.severity).toBe("high");
    const inc = gcPressure.evaluate(handCtx({ scope: "incident", samples: series(180, full, 300), incident: { start: T0 - 5 * MIN, end: T0 } }));
    expect(inc[0]!.severity).toBe("high");
  });

  test("no room on the machine for a bigger heap: suggests reducing memory use instead", () => {
    const fs = gcPressure.evaluate(handCtx({ samples: series(180, full, 400, 4 * GB, 5 * GB), info: piHello({ ram: 5 * GB }) }));
    expect(fs[0]!.suggestedFix).toContain("no room for a bigger memory limit");
  });

  test("heap full but GC cheap (G1 just fills lazily): nothing", () => {
    expect(gcPressure.evaluate(handCtx({ samples: series(180, full, 50) }))).toEqual([]);
  });

  test("lots of GC but heap empties fine: not a heap-size problem, nothing", () => {
    expect(gcPressure.evaluate(handCtx({ samples: series(180, saw, 500) }))).toEqual([]);
  });

  test("healthy sawtooth with small pauses: nothing", () => {
    expect(gcPressure.evaluate(handCtx({ samples: series(180, saw, 12) }))).toEqual([]);
  });

  test("1-min rollups (avg of 10 s values) work too", () => {
    const samples = Array.from({ length: 30 }, (_, i) => minuteSample(T0 - (29 - i) * MIN, healthyM({ heap_used_bytes: 0.9 * 6 * GB, heap_max_bytes: 6 * GB, gc_pause_ms: 450 })));
    expect(gcPressure.evaluate(handCtx({ samples })).map((f) => f.dedupKey)).toEqual(["heap-too-small"]);
  });

  test("less than 10 minutes of data, or missing heap metrics: nothing", () => {
    expect(gcPressure.evaluate(handCtx({ samples: series(30, full, 700) }))).toEqual([]);
    expect(gcPressure.evaluate(handCtx({ samples: rawSeries(180, () => ({ m: { mspt_p95: 20 } })) }))).toEqual([]);
  });
});
