// Rules must never throw and must return [] on missing / partial / malformed data: empty samples, null hello,
// null baseline, rollup-only samples, missing host fields, NaN values, garbage snapshots and events.
import { describe, expect, test } from "vitest";
import { RULE_IDS } from "@tickdoctor/shared";
import { RULES } from "../../src/rules/index.js";
import type { RuleContext } from "../../src/rules/types.js";
import { MIN, T0, handCtx, healthyM, minuteSample, rawSeries } from "./helpers.js";

const incident = { start: T0 - 10 * MIN, end: T0 };
const bad: [string, () => RuleContext][] = [
  ["everything empty (server)", () => handCtx({ samples: [], info: null })],
  ["everything empty (incident)", () => handCtx({ scope: "incident", samples: [], info: null, incident })],
  ["incident scope without incident object", () => ({ ...handCtx({ samples: rawSeries(10, () => ({ m: healthyM() })) }), scope: "incident" as const })],
  ["samples with empty m and no detail", () => handCtx({ samples: Array.from({ length: 50 }, (_, i) => ({ ts: new Date(T0 - i * 10_000).toISOString(), seconds: 10, m: {} })) })],
  ["NaN / Infinity / negative values", () => handCtx({ scope: "incident", incident, samples: rawSeries(60, () => ({ m: { mspt_p95: NaN, mspt_avg: Infinity, players: -3, heap_used_bytes: NaN, heap_max_bytes: 0, swap_used_bytes: Infinity, cpu_temp_c: NaN, loaded_chunks: NaN, chunk_gen_per_min: NaN } })) })],
  ["detail with null-ish members", () => handCtx({ scope: "incident", incident, samples: rawSeries(30, () => ({ m: healthyM({ mspt_p95: 90 }), detail: { worlds: null, worstChunks: [null], gcPauses: null, host: null } as never })) })],
  ["rollup-only incident, null baseline, no snapshot", () => handCtx({ scope: "incident", incident, baseline: null, samples: Array.from({ length: 20 }, (_, i) => minuteSample(T0 - i * MIN, healthyM({ mspt_p95: 90 }))) })],
  ["garbage snapshot", () => handCtx({ scope: "incident", incident, samples: rawSeries(10, () => ({ m: healthyM({ mspt_p95: 90 }) })), snapshot: { worldsDetail: [null, { name: 5, topChunks: [null, { x: "a" }] }], sample: null } as never })],
  ["garbage events", () => handCtx({ scope: "incident", incident, samples: rawSeries(10, () => ({ m: healthyM() })), events: [null, { type: "exception" }, { type: "plugins_changed", ts: "nope" }, { type: "server_start" }] as never })],
  ["hello with missing parts", () => handCtx({ samples: rawSeries(10, () => ({ m: healthyM() })), info: { jvm: { flags: null }, host: {}, config: {} } as never })],
  ["baseline with empty metrics", () => handCtx({ scope: "incident", incident, samples: rawSeries(30, () => ({ m: healthyM({ mspt_p95: 90 }) })), baseline: { metrics: {}, plugins: [] } as never })],
  ["window missing", () => ({ ...handCtx({ samples: rawSeries(10, () => ({ m: healthyM() })) }), window: undefined as never })],
];

describe("robustness", () => {
  test("every rule id is registered exactly once, in RULE_IDS order", () => {
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
  });

  for (const [name, mk] of bad) {
    test(`never throws, returns []: ${name}`, () => {
      for (const r of RULES) {
        let out: unknown;
        expect(() => (out = r.evaluate(mk())), r.id).not.toThrow();
        expect(Array.isArray(out), r.id).toBe(true);
        // jvm-flags may legitimately report from a partial hello, everything else must stay silent here.
        if (r.id !== "jvm-flags") expect(out, `${r.id} on ${name}`).toEqual([]);
      }
    });
  }

  test("a rule that throws internally is contained by defineRule", async () => {
    const { defineRule } = await import("../../src/rules/util.js");
    const boom = defineRule({ id: "jvm-flags", scopes: ["server"], evaluate: () => { throw new Error("x"); } });
    expect(boom.evaluate(handCtx({ samples: [] }))).toEqual([]);
  });
});

describe("agent-supplied names that collide with Object.prototype (constructor, toString, __proto__)", () => {
  const evilJson = JSON.parse('{"constructor": 1300, "toString": 900, "__proto__": 700, "hasOwnProperty": 5}') as Record<string, number>;

  test("helpers: sumTypes / ownNum / friendlyType treat them as ordinary names", async () => {
    const { friendlyType, ownNum, sumTypes } = await import("../../src/rules/util.js");
    const sum = sumTypes([evilJson, evilJson]);
    expect(Object.entries(sum).sort()).toEqual([["__proto__", 1400], ["constructor", 2600], ["hasownproperty", 10], ["tostring", 1800]]);
    expect(ownNum({}, "constructor")).toBe(0);
    expect(ownNum({}, "toString")).toBe(0);
    expect(ownNum(evilJson, "__proto__")).toBe(700);
    for (const n of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(friendlyType(n)).not.toMatch(/native code|function/);
      expect(typeof friendlyType(n)).toBe("string");
    }
    expect(friendlyType("constructor")).toBe("constructors");
  });

  test("plugin-exceptions with a class named constructor / toString / __proto__: no native-code text, no throw", async () => {
    const { pluginExceptions } = await import("../../src/rules/plugin-exceptions.js");
    for (const cls of ["x.constructor", "toString", "__proto__", "a.hasOwnProperty"]) {
      const events = Array.from({ length: 20 }, (_, i) => ({
        type: "exception", ts: new Date(T0 - 25 * MIN + i * MIN).toISOString(), plugin: "constructor", exceptionClass: cls, stackHash: "h", count: 20,
      })) as never;
      const fs = pluginExceptions.evaluate(handCtx({ samples: rawSeries(180, () => ({ m: healthyM() })), events }));
      expect(fs).toHaveLength(1);
      expect(JSON.stringify(fs)).not.toMatch(/native code|function /);
    }
  });

  test("every rule on worlds / chunks / baselines keyed by those names: no throw, no native-code text", () => {
    const worlds = [{ name: "constructor", entitiesByType: evilJson, tileEntitiesByType: evilJson, loadedChunks: 400, entities: 3000, chunkGenPerMinute: 50 }];
    const ctx = () =>
      handCtx({
        scope: "incident",
        incident: { start: T0 - 10 * MIN, end: T0, peak: 90 },
        samples: rawSeries(60, () => ({ m: healthyM({ mspt_p95: 90, mspt_avg: 50 }), detail: { worlds, worstChunks: [{ world: "toString", x: 1, z: 1, entities: 2000, tileEntities: 900, byType: evilJson }] } as never })),
        baseline: { metrics: {}, plugins: [], entitiesByType: JSON.parse('{"toString": 1}'), tileEntitiesByType: JSON.parse('{"constructor": 1}') } as never,
        snapshot: { trigger: "threshold", ts: new Date(T0 - 2 * MIN).toISOString(), msptP95AtTrigger: 90, sample: {}, recentEvents: [], worldsDetail: [{ ...worlds[0], topChunks: [{ x: 1, z: 1, entities: 2000, tileEntities: 900, byType: evilJson }] }] } as never,
      });
    for (const r of RULES) {
      let out: unknown;
      expect(() => (out = r.evaluate(ctx())), r.id).not.toThrow();
      expect(JSON.stringify(out), r.id).not.toMatch(/native code|\[object Object\]|NaN/);
    }
  });
});
