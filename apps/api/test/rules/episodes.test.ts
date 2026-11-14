// (d) Each seed episode triggers the right rule and no unrelated rule, at several anchors (the episodes then
// fall on different times of day: night, afternoon, evening peak). jvm-flags on the Pi is the documented
// exception (the seed Pi's flags really are incomplete) and is ignored here.
import { describe, expect, test } from "vitest";
import { EPISODES } from "../../src/seed.js";
import { H, assertValid, episodeContexts, episodeRange, runAll, seedCtx, summary, type ServerKey } from "./helpers.js";

const ANCHORS = [Date.parse("2026-11-09T12:00:00Z"), Date.parse("2026-11-08T23:00:00Z"), Date.parse("2026-11-09T04:30:00Z")];
const EXPECT: Record<string, { rule: string; key: string; severity?: string }> = {
  "smp-heap-pressure": { rule: "gc-pressure", key: "heap-too-small", severity: "high" },
  "pi-plugin-update": { rule: "plugin-change-before-lag", key: "plugins:farmcontrol" },
  "smp-entity-buildup": { rule: "entity-explosion", key: "world:item", severity: "high" },
  "pi-hot-afternoon": { rule: "thermal-throttling", key: "throttling", severity: "high" },
};
const ignore = (s: string) => s.startsWith("jvm-flags/");

describe.each(EPISODES.map((e) => e.id))("episode %s", (id) => {
  for (const anchor of ANCHORS) {
    test(`incidents trigger only ${EXPECT[id]!.rule} (anchor ${new Date(anchor).toISOString()})`, () => {
      const ctxs = episodeContexts(id, anchor, { max: 6 });
      expect(ctxs.length).toBeGreaterThan(0);
      let hits = 0;
      for (const ctx of ctxs) {
        const fs = runAll(ctx);
        fs.forEach(assertValid);
        const other = summary(fs).filter((s) => !ignore(s) && !s.startsWith(`${EXPECT[id]!.rule}/`));
        expect(other, `unrelated findings in incident ${ctx.incident!.startedAt}`).toEqual([]);
        const f = fs.find((x) => x.ruleId === EXPECT[id]!.rule);
        if (f) {
          hits++;
          expect(f.dedupKey).toBe(EXPECT[id]!.key);
          if (EXPECT[id]!.severity) expect(f.severity).toBe(EXPECT[id]!.severity);
        }
      }
      // gc-pressure needs 10 min of window: a rare very short incident may miss it; all others must hit.
      expect(hits).toBeGreaterThanOrEqual(Math.max(1, ctxs.length - 1));
    }, 120_000);
  }
});

test("entity buildup: the finding points at the farm chunk with numbers vs baseline", () => {
  const ctx = episodeContexts("smp-entity-buildup", ANCHORS[0]!)[0]!;
  const f = runAll(ctx).find((x) => x.ruleId === "entity-explosion")!;
  expect(f.evidence.chunks?.[0]).toEqual({ world: "world", x: -40, z: 112 });
  expect(f.title).toBe("Too many dropped items in one chunk");
  const n = f.evidence.numbers.find((x) => x.label === "Dropped items on the whole server")!;
  expect(Number(n.value)).toBeGreaterThan(2000);
  expect(Number(n.baseline)).toBeLessThan(400);
  expect(f.suggestedFix).toContain("/kill @e[type=minecraft:item,distance=..48]");
  expect(f.suggestedFix).toContain("/tp @s -632 ~ 1800");
});

test("plugin update: names the plugin and both versions, suggests the rollback", () => {
  for (const anchor of ANCHORS) {
    const ctx = episodeContexts("pi-plugin-update", anchor)[0]!;
    const f = runAll(ctx).find((x) => x.ruleId === "plugin-change-before-lag")!;
    expect(f, `anchor ${new Date(anchor).toISOString()}`).toBeDefined();
    expect(f.title).toBe("The server got slower after FarmControl was updated");
    expect(f.evidence.numbers[0]).toEqual({ label: "Changed", value: "FarmControl 2.3.1 → 2.4.0" });
    expect(f.suggestedFix).toContain("FarmControl 2.4.0 with version 2.3.1");
  }
});

test("hot afternoon: server scope fires during the episode and is gone two hours after it", () => {
  for (const anchor of ANCHORS) {
    const r = episodeRange("pi-hot-afternoon", anchor);
    const during = runAll(seedCtx({ server: "pi" as ServerKey, anchor, to: (r.from + r.to) / 2 })).filter((f) => f.ruleId === "thermal-throttling");
    expect(during.map((f) => f.dedupKey)).toEqual(["throttling"]);
    const after = runAll(seedCtx({ server: "pi", anchor, to: r.to + 2 * H })).filter((f) => f.ruleId === "thermal-throttling");
    expect(after).toEqual([]);
  }
});

test("heap pressure: server scope fires in the middle of the week (1-min rollups), nothing else", () => {
  const anchor = ANCHORS[0]!;
  const r = episodeRange("smp-heap-pressure", anchor);
  for (const t of [r.from + 30 * H, r.from + 80 * H, r.to - 5 * H]) {
    expect(summary(runAll(seedCtx({ server: "smp", anchor, to: t })))).toEqual(["gc-pressure/heap-too-small/high"]);
  }
});
