// Real Pi lag scenarios (engine RuleContext dumps, 2026-11-09 UTC, fixtures/rules/pi-scenarios/*.json.gz,
// trimmed). Each scenario fires exactly the expected rules; every other rule stays silent.
// jvm-flags: the Pi ran -Xms1G -Xmx3G (xms-ne-xmx) except in the small-heap run (-Xms512M -Xmx768M → xmx-too-small).
import { describe, expect, test } from "vitest";
import { RULES } from "../../src/rules/index.js";
import type { RuleContext } from "../../src/rules/types.js";
import { assertValid, incidentFromServer, runAll, scenario, summary } from "./helpers.js";

const CASES: [string, () => RuleContext, string[]][] = [
  ["idle (90 min, nothing loaded)", () => scenario("idle.server"), ["jvm-flags/xms-ne-xmx/info"]],
  ["restored (back to 1G/3G, idle)", () => scenario("restored.server"), ["jvm-flags/xms-ne-xmx/info"]],
  // 450 villagers + ~150 chickens + ~150 items over 32 chunks (max ~71 per chunk), baseline 0, p95 97.6, TPS 15.2.
  ["entity spam, incident", () => scenario("entity-spam.incident"), ["entity-explosion/world:villager/high", "jvm-flags/xms-ne-xmx/info"]],
  // Server scope: lag-cause rules are incident-only.
  ["entity spam, server", () => scenario("entity-spam.server"), ["jvm-flags/xms-ne-xmx/info"]],
  // 5,120 working hoppers in 4 chunks (~1,280 each), MSPT avg 0.1 → 3.6 ms, no lag: low early warning.
  ["hoppers, server", () => scenario("hoppers.server"), ["tile-entity-hotspot/world:hopper/low", "jvm-flags/xms-ne-xmx/info"]],
  ["chunk generation, server", () => scenario("chunkgen.server"), ["jvm-flags/xms-ne-xmx/info"]],
  // Up to 1,138 chunks/min, freezes 1.6–21 s, TPS 11.8, p95 < 10 ms (TPS-opened incident).
  ["chunk generation, incident (built from the server dump)", () => incidentFromServer(scenario("chunkgen.server")), ["live-chunk-generation/chunk-generation/high", "jvm-flags/xms-ne-xmx/info"]],
  // 925 entities (450 villagers) + forceloads over fresh land: the 9 s freeze is the same sample as 880 new
  // chunks/min, so chunk generation is a second, real cause. GC 0.8 %: gc-pressure correctly silent.
  ["small heap, incident", () => scenario("small-heap.incident"), ["entity-explosion/world:villager/high", "live-chunk-generation/chunk-generation/high", "jvm-flags/xmx-too-small/low"]],
  ["small heap, server", () => scenario("small-heap.server"), ["jvm-flags/xmx-too-small/low"]],
];

describe("real Pi scenarios", () => {
  for (const [name, mk, expected] of CASES) {
    test(name, () => {
      const fs = runAll(mk());
      fs.forEach(assertValid);
      expect(summary(fs)).toEqual(expected);
    });
  }

  test("entity spam: names villagers first, lists the busiest chunks for /tp, compares with the empty baseline", () => {
    const f = runAll(scenario("entity-spam.incident")).find((x) => x.ruleId === "entity-explosion")!;
    // Dropped items are not mobs: the title names every part.
    expect(f.title).toBe("Far more villagers, chickens and dropped items than usual");
    expect(f.explanation).toMatch(/^There are 450 villagers, 151 chickens and 147 dropped items in the world `world`, spread over \d+ chunks \(the busiest chunk is around X [\d,]+, Z [\d,]+\)\. Usually your server has almost no mobs or items loaded\./);
    expect(f.explanation).toContain("a Raspberry Pi has little time to spare");
    expect(f.evidence.chunks!.length).toBeGreaterThanOrEqual(8);
    expect(f.evidence.chunks![0]).toEqual({ world: "world", x: 188, z: 189 });
    expect(f.evidence.numbers[0]).toEqual({ label: "Villagers on the whole server", value: 450, baseline: "none" });
    expect(f.suggestedFix).toContain("tick-rates.sensor.villager");
    // validatenearbypoi has done nothing since 1.19.3 (PaperMC/Paper#9925); nearestbedsensor isn't confirmed.
    expect(f.suggestedFix).not.toContain("validatenearbypoi");
    expect(f.suggestedFix).not.toContain("nearestbedsensor");
    // Config-file steps sit under the heading the UI collapses; the simple steps come first.
    const [simple, advanced] = f.suggestedFix.split("\n\n#### Optional, for when the simple steps aren't enough\n\n");
    expect(advanced).toMatch(/^1\. /);
    expect(simple).not.toContain(".yml");
    expect(advanced).toContain("paper-world-defaults.yml");
    // /kill with distance= is in-game only; the console version selects exactly the busiest chunk (188, 189).
    expect(simple).toContain("in-game while standing in the chunk: `/kill @e[type=minecraft:villager,limit=50,distance=..24]`");
    expect(simple).toContain("`/execute in minecraft:overworld run kill @e[type=minecraft:villager,limit=50,x=3008,y=-64,z=3024,dx=15,dy=383,dz=15]`");
  });

  test("hoppers: early warning with the estimated count per chunk and the cost in ms", () => {
    const f = runAll(scenario("hoppers.server")).find((x) => x.ruleId === "tile-entity-hotspot")!;
    expect(f.title).toBe("Early warning: a very large hopper build is slowing the server a little");
    expect(f.evidence.chunks!.length).toBeGreaterThanOrEqual(4); // the 32×32 block straddles chunk borders
    expect(Number(f.evidence.numbers[0]!.value)).toBeGreaterThan(1000);
    expect(f.explanation).toContain("isn't lagging yet");
    expect(f.explanation).toContain("a tick has 50 ms");
    expect(f.explanation).toContain("probably because of these hoppers");
    // The numbers add up: chunks over the line × their estimates ≤ the world's real total.
    const num = (label: string) => Number(f.evidence.numbers.find((x) => x.label.startsWith(label))!.value);
    expect(num("All hoppers in")).toBe(5120);
    expect(num("Hoppers in those chunks together")).toBeLessThanOrEqual(5120);
    expect(num("Hoppers in the busiest chunk")).toBeLessThanOrEqual(num("Hoppers in those chunks together"));
  });

  test("chunk generation: reports the freezes and the TPS drop, not only the rate", () => {
    const f = runAll(incidentFromServer(scenario("chunkgen.server"))).find((x) => x.ruleId === "live-chunk-generation")!;
    const labels = f.evidence.numbers.map((n) => n.label);
    expect(labels).toContain("Longest single tick (server frozen)");
    expect(labels).toContain("Lowest TPS");
    expect(f.explanation).toMatch(/froze for up to [\d.]+ seconds/);
  });

  test("both real chunk-generation incidents had 0 players (forceload): the 0-players wording and force-load step first", () => {
    for (const c of [incidentFromServer(scenario("chunkgen.server")), scenario("small-heap.incident")]) {
      const f = runAll(c).find((x) => x.ruleId === "live-chunk-generation")!;
      expect(f.explanation).toContain("while no players were online");
      expect(f.suggestedFix).toMatch(/^1\. Find what loads the chunks/);
      expect(f.explanation).toContain("That probably means");
      // Chunky only after the force-load / plugin checks, centred on the generated area rather than spawn.
      expect(f.suggestedFix.indexOf("/forceload query")).toBeLessThan(f.suggestedFix.indexOf("the Chunky plugin"));
      expect(f.suggestedFix).toContain("the area that was being generated");
      expect(f.suggestedFix).toContain("Optional, and only if nobody has built outside it");
    }
  });

  test("small heap: switching to -Xms4G -Xmx4G clears xmx-too-small", () => {
    const c = scenario("small-heap.server");
    c.info = { ...c.info!, jvm: { ...c.info!.jvm, flags: c.info!.jvm.flags.map((f) => f.replace("-Xms512M", "-Xms4G").replace("-Xmx768M", "-Xmx4G")), heapInitBytes: 4 * 1024 ** 3, heapMaxBytes: 4 * 1024 ** 3 } };
    expect(runAll(c).filter((f) => f.ruleId === "jvm-flags")).toEqual([]);
  });
});

/** Rules get the same context one after another: none may mutate it. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

test("no rule mutates the context (deep-frozen contexts, every scenario, strict mode throws on writes)", () => {
  for (const [name, mk] of CASES) {
    const frozen = deepFreeze(mk());
    for (const r of RULES) {
      // defineRule swallows errors; call the rule and compare with an unfrozen run to detect a swallowed write.
      const a = summary(r.evaluate(frozen));
      const b = summary(r.evaluate(mk()));
      expect(a, `${r.id} on ${name}`).toEqual(b);
    }
    // And on an unfrozen copy: the context is byte-identical after all rules ran.
    const ctx = mk();
    const before = JSON.stringify(ctx);
    runAll(ctx);
    expect(JSON.stringify(ctx), name).toBe(before);
  }
});
