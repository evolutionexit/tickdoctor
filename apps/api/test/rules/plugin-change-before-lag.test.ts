import { describe, expect, test } from "vitest";
import type { RuleEvent } from "../../src/rules/types.js";
import { pluginChangeBeforeLag } from "../../src/rules/plugin-change-before-lag.js";
import { H, MIN, T0, assertValid, handCtx, minuteSample } from "./helpers.js";

/** Daily player curve 0–8, mspt_avg = 5 + 2 × players (+ extra after `slowFrom`). */
function history(from: number, to: number, slowFrom = Infinity, extra = 8, recoverAt = Infinity) {
  const out = [];
  for (let t = from; t <= to; t += MIN) {
    const h = new Date(t).getUTCHours();
    const players = Math.max(0, Math.round(8 * Math.sin(((h - 6) / 24) * Math.PI * 2)));
    const slow = t >= slowFrom && t < recoverAt ? extra : 0;
    const avg = 5 + 2 * players + slow + ((t / MIN) % 3) * 0.3;
    out.push(minuteSample(t, { players, mspt_avg: avg, mspt_p95: avg * 1.6 }));
  }
  return out;
}
const upd = (t: number, name = "FarmControl", from = "2.3.1", to = "2.4.0"): RuleEvent => ({ type: "plugins_changed", ts: new Date(t).toISOString(), added: [], removed: [], updated: [{ name, from, to }] });
const incident = { start: T0 - 30 * MIN, end: T0, peak: 85 };
const ctxWith = (o: { change: number; inc?: typeof incident; events?: RuleEvent[]; slowFrom?: number; extra?: number; recoverAt?: number; histFrom?: number; plugins?: Parameters<typeof handCtx>[0]["plugins"] }) => {
  const hist = history(o.histFrom ?? T0 - 7 * 24 * H, T0, o.slowFrom ?? Infinity, o.extra ?? 8, o.recoverAt ?? Infinity);
  return handCtx({ scope: "incident", incident: o.inc ?? incident, samples: hist.slice(-80), history: hist, events: o.events ?? [upd(o.change)], plugins: o.plugins });
};

describe("plugin-change-before-lag", () => {
  test("update 30 h before the incident, ticks +8 ms at the same player counts → names plugin + versions, rollback steps", () => {
    const change = T0 - 30 * H;
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change }));
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["plugins:farmcontrol", "medium"]]);
    expect(fs[0]!.title).toBe("The server got slower after FarmControl was updated");
    expect(fs[0]!.explanation).toContain("FarmControl was updated from 2.3.1 to 2.4.0 30 hours before this lag started");
    expect(fs[0]!.suggestedFix).toContain("replace FarmControl 2.4.0 with version 2.3.1");
    expect(Number(fs[0]!.evidence.numbers.find((n) => n.label === "Slower by")!.value)).toBeCloseTo(8, 0);
    expect(fs[0]!.evidence.chart?.highlight?.from).toBe(new Date(change).toISOString());
  });

  test("agent-supplied plugin names / versions can't inject Markdown or newlines; dedupKey keeps the raw name", () => {
    const change = T0 - 30 * H;
    const evil = "X](https://evil.example/fix) [\n```";
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change, events: [upd(change, evil, "1.0`\n", "[2.0](https://e.x)")] }));
    expect(fs).toHaveLength(1);
    fs.forEach(assertValid);
    const f = fs[0]!;
    for (const text of [f.title, f.explanation, f.suggestedFix.replace(/\n\d+\. /g, " ")]) {
      expect(text).not.toMatch(/\[[^\]]*\]\(/);
      expect(text).not.toContain("```");
      expect(text).not.toContain("\n");
    }
    expect(f.title).toBe("The server got slower after X)(https://evil.example/fix) ( ''' was updated");
    expect(f.dedupKey).toBe(`plugins:${evil.toLowerCase()}`);
  });

  test("an update followed by NO slowdown (this incident has another cause): nothing", () => {
    expect(pluginChangeBeforeLag.evaluate(ctxWith({ change: T0 - 30 * H }))).toEqual([]);
  });

  test("a small difference (+2 ms) is noise: nothing", () => {
    const change = T0 - 30 * H;
    expect(pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change, extra: 2 }))).toEqual([]);
  });

  test("a rollback that made things faster is not blamed", () => {
    const change = T0 - 20 * H;
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: T0 - 6 * 24 * H, recoverAt: change, events: [upd(change, "FarmControl", "2.4.0", "2.3.1")] }));
    expect(fs).toEqual([]);
  });

  test("change older than 72 h, or no history before the change (new server): nothing", () => {
    expect(pluginChangeBeforeLag.evaluate(ctxWith({ change: T0 - 80 * H, slowFrom: T0 - 80 * H }))).toEqual([]);
    expect(pluginChangeBeforeLag.evaluate(ctxWith({ change: T0 - 10 * H, slowFrom: T0 - 10 * H, histFrom: T0 - 10 * H - 20 * MIN }))).toEqual([]);
  });

  test("the change opened the incident (update at its start, no data in between): compares including the incident", () => {
    const change = T0 - 55 * MIN;
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change, extra: 20, inc: { start: T0 - 60 * MIN, end: T0, peak: 90 } }));
    expect(fs.map((f) => f.dedupKey)).toEqual(["plugins:farmcontrol"]);
    expect(fs[0]!.explanation).toContain("right when this lag started");
    expect(fs[0]!.evidence.numbers.some((n) => n.label === "Comparison includes this incident")).toBe(true);
  });

  test("a removed plugin and several changes at once: one finding, all names in the key", () => {
    const change = T0 - 20 * H;
    const ev: RuleEvent = { type: "plugins_changed", ts: new Date(change).toISOString(), added: [{ name: "Shops", version: "1.0" }], removed: [{ name: "ClearLagg", version: "3.2" }], updated: [] };
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change, events: [ev] }));
    expect(fs.map((f) => f.dedupKey)).toEqual(["plugins:clearlagg+shops"]);
    expect(fs[0]!.suggestedFix).toContain("ClearLagg may have been keeping the load down");
  });

  test("no event, but the plugin inventory shows the new version: still found", () => {
    const change = T0 - 30 * H;
    const iso = (t: number) => new Date(t).toISOString();
    const plugins = [
      { name: "LuckPerms", version: "5.5.17", firstSeen: iso(T0 - 20 * 24 * H), lastSeen: iso(T0) },
      { name: "FarmControl", version: "2.3.1", firstSeen: iso(T0 - 20 * 24 * H), lastSeen: iso(change) },
      { name: "FarmControl", version: "2.4.0", firstSeen: iso(change), lastSeen: iso(T0) },
    ];
    const fs = pluginChangeBeforeLag.evaluate(ctxWith({ change, slowFrom: change, events: [], plugins }));
    expect(fs[0]!.evidence.numbers[0]).toEqual({ label: "Changed", value: "FarmControl 2.3.1 → 2.4.0" });
  });

  test("server scope or no incident: nothing", () => {
    const ctx = ctxWith({ change: T0 - 30 * H, slowFrom: T0 - 30 * H });
    expect(pluginChangeBeforeLag.evaluate({ ...ctx, scope: "server" })).toEqual([]);
    expect(pluginChangeBeforeLag.evaluate({ ...ctx, incident: undefined })).toEqual([]);
  });
});
