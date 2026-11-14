import { describe, expect, test } from "vitest";
import type { RuleEvent } from "../../src/rules/types.js";
import { pluginExceptions } from "../../src/rules/plugin-exceptions.js";
import { plainName } from "../../src/rules/util.js";
import { MIN, T0, assertValid, handCtx, healthyM, rawSeries } from "./helpers.js";

const exc = (t: number, count: number, o: Partial<Extract<RuleEvent, { type: "exception" }>> = {}): RuleEvent => ({
  type: "exception", ts: new Date(t).toISOString(), plugin: "ShopGUIPlus", exceptionClass: "java.lang.NullPointerException",
  message: "Cannot invoke because player Steve_123 is null", stackHash: "a1b2c3", topFrames: ["net.brcdev.shopgui.ShopManager.open(ShopManager.java:212)"], count, ...o,
});
const spread = (n: number, per: number, o = {}) => Array.from({ length: n }, (_, i) => exc(T0 - 25 * MIN + i * MIN, per, o));
const samples = rawSeries(180, () => ({ m: healthyM() }));

describe("plugin-exceptions", () => {
  test("400 errors from one plugin over 20 minutes, server keeps up → low; never shows the message (player names)", () => {
    const fs = pluginExceptions.evaluate(handCtx({ samples, events: spread(20, 20) }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity, f.title])).toEqual([["plugin:shopguiplus", "low", "Errors that point to ShopGUIPlus keep repeating"]]);
    expect(JSON.stringify(fs)).not.toContain("Steve_123");
    expect(fs[0]!.explanation).toContain("`NullPointerException` (the plugin looked for something that wasn't there)");
    expect(fs[0]!.explanation).toContain("best guess");
    expect(fs[0]!.suggestedFix).toContain("logs/latest.log");
  });

  test("a flood (≥ 30/min) → medium; during an incident → high", () => {
    expect(pluginExceptions.evaluate(handCtx({ samples, events: spread(25, 100) }))[0]!.severity).toBe("medium");
    const inc = pluginExceptions.evaluate(handCtx({ scope: "incident", incident: { start: T0 - 26 * MIN, end: T0 }, samples, events: spread(25, 100) }));
    expect(inc[0]!.severity).toBe("high");
  });

  test("a single burst (500 in one minute, e.g. at startup) or a few errors an hour: nothing", () => {
    expect(pluginExceptions.evaluate(handCtx({ samples, events: [exc(T0 - 5 * MIN, 500)] }))).toEqual([]);
    expect(pluginExceptions.evaluate(handCtx({ samples, events: spread(6, 2) }))).toEqual([]);
  });

  test("unknown source is grouped by stack and worded neutrally", () => {
    const fs = pluginExceptions.evaluate(handCtx({ samples, events: spread(10, 20, { plugin: undefined, stackHash: "ffee" }) }));
    expect(fs.map((f) => [f.dedupKey, f.title])).toEqual([["stack:ffee", "The same error keeps repeating in the server log"]]);
  });

  test("events outside the window don't count", () => {
    expect(pluginExceptions.evaluate(handCtx({ samples, events: spread(20, 20).map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) - 2 * 3_600_000).toISOString() })) }))).toEqual([]);
  });

  test("agent-supplied plugin / class names can't inject Markdown links, code fences or newlines into finding text", () => {
    const evil = "X](https://evil.example/fix) [\n```";
    const fs = pluginExceptions.evaluate(handCtx({ samples, events: spread(20, 20, { plugin: evil, exceptionClass: "a.B`\n```*Boom*" }) }));
    expect(fs).toHaveLength(1);
    fs.forEach(assertValid);
    const f = fs[0]!;
    for (const text of [f.title, f.explanation, f.suggestedFix.replace(/\n\d+\. /g, " ")]) {
      expect(text).not.toMatch(/\[[^\]]*\]\(/); // no link syntax
      expect(text).not.toContain("```");
      expect(text).not.toContain("\n");
      expect(text).not.toContain("*Boom*");
    }
    expect(f.title).toBe("Errors that point to X)(https://evil.example/fix) ( ''' keep repeating");
  });

  test("plainName: collapses whitespace/control chars, caps at 64 with an ellipsis, neutralises Markdown", () => {
    expect(plainName("  a\tb\r\n\u0000c d  ")).toBe("a b c d");
    expect(plainName("[x](y) `z` **w** <@123>")).toBe("(x)(y) 'z' ∗∗w∗∗ ‹@123›");
    expect(plainName("Plugin_Name-1.2")).toBe("Plugin_Name-1.2");
    const long = plainName("a".repeat(200));
    expect([...long]).toHaveLength(64);
    expect(long.endsWith("…")).toBe(true);
  });
});
