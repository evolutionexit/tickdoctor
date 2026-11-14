import { describe, expect, test } from "vitest";
import { thermalThrottling } from "../../src/rules/thermal-throttling.js";
import { H, MIN, T0, assertValid, handCtx, healthyM, minuteSample, piHello, rawSeries } from "./helpers.js";

const piSamples = (n: number, temp: number, throttled?: { now: boolean; sinceBoot: boolean; raw?: string } | ((i: number) => { now: boolean; sinceBoot: boolean; raw?: string })) =>
  rawSeries(n, (i) => ({
    m: healthyM({ cpu_temp_c: temp }),
    detail: { host: { memTotalBytes: 8e9, ...(throttled ? { throttled: typeof throttled === "function" ? throttled(i) : throttled } : {}) } },
  }));
const x86 = piHello({ model: "", arch: "amd64", cores: 8, ram: 32e9 });
delete (x86.host as { model?: string }).model;

describe("thermal-throttling", () => {
  test("Pi at 83 °C, throttled now: medium on a server that keeps up, high during an incident", () => {
    const samples = piSamples(180, 83, { now: true, sinceBoot: true, raw: "0x60006" });
    const s = thermalThrottling.evaluate(handCtx({ samples }));
    expect(s.map((f) => [f.dedupKey, f.severity])).toEqual([["throttling", "medium"]]);
    s.forEach(assertValid);
    expect(s[0]!.evidence.chart?.metric).toBe("cpu_temp_c");
    expect(s[0]!.suggestedFix).toContain("vcgencmd get_throttled");
    const i = thermalThrottling.evaluate(handCtx({ scope: "incident", samples, incident: { start: T0 - 20 * MIN, end: T0 } }));
    expect(i.map((f) => f.severity)).toEqual(["high"]);
  });

  test("under-voltage with a cool CPU: only the power-supply finding", () => {
    const fs = thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 55, { now: true, sinceBoot: true, raw: "0x50005" }) }));
    expect(fs.map((f) => f.dedupKey)).toEqual(["under-voltage"]);
    expect(fs[0]!.suggestedFix).toContain("27 W");
  });

  test("only 'since boot' (old event) or a short blip: nothing", () => {
    expect(thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 60, { now: false, sinceBoot: true, raw: "0x60000" }) }))).toEqual([]);
    expect(thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 62, (i) => ({ now: i < 2, sinceBoot: true })) }))).toEqual([]);
  });

  test("Pi at 79 °C without throttling: below the 80 °C limit, nothing", () => {
    expect(thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 79, { now: false, sinceBoot: false, raw: "0x0" }) }))).toEqual([]);
  });

  test("x86 at 88 °C is normal; at 97 °C it fires (no throttle flags on x86)", () => {
    expect(thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 88), info: x86 }))).toEqual([]);
    const fs = thermalThrottling.evaluate(handCtx({ samples: piSamples(180, 97), info: x86 }));
    expect(fs.map((f) => f.dedupKey)).toEqual(["throttling"]);
    expect(fs[0]!.suggestedFix).not.toContain("Raspberry");
  });

  test("Windows host without temperature or throttle data: nothing", () => {
    const win = piHello({ arch: "amd64", cores: 8 });
    win.host = { os: "Windows 11", arch: "amd64" };
    expect(thermalThrottling.evaluate(handCtx({ samples: rawSeries(180, () => ({ m: healthyM(), detail: { host: {} } })), info: win }))).toEqual([]);
  });

  test("rollup-only Pi window (no detail) at 82 °C: fires from temperature alone", () => {
    const samples = Array.from({ length: 30 }, (_, i) => minuteSample(T0 - (29 - i) * MIN, healthyM({ cpu_temp_c: 82 })));
    expect(thermalThrottling.evaluate(handCtx({ samples })).map((f) => f.dedupKey)).toEqual(["throttling"]);
  });

  test("too little temperature data (2 min): nothing", () => {
    expect(thermalThrottling.evaluate(handCtx({ samples: piSamples(12, 84) }))).toEqual([]);
  });

  test("baseline temperature appears as 'usually'", () => {
    const fs = thermalThrottling.evaluate(handCtx({
      samples: piSamples(180, 83, { now: true, sinceBoot: true }),
      history: Array.from({ length: 100 }, (_, i) => minuteSample(T0 - 2 * H + i * MIN, { cpu_temp_c: 50 })),
    }));
    expect(fs[0]!.evidence.numbers[0]).toMatchObject({ label: "CPU temperature", value: 83, baseline: 50 });
    expect(fs[0]!.explanation).toContain("usually 50 °C");
  });
});
