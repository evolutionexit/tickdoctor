import { describe, expect, it } from "vitest";
import { whatChanged, type Baseline } from "@tickdoctor/shared";
import { MAX_ITEMS, computeWhatChanged, median, numericItem, sortItems, typeLabel } from "../src/incidents/what-changed.js";

// Pure unit tests for "What changed?" (contract app-phase6.ts whatChanged).

const MB = 1_048_576;

function baseline(over: Partial<Baseline> = {}): Baseline {
  return {
    from: "2026-11-09T10:00:00.000Z",
    to: "2026-11-09T12:00:00.000Z",
    healthyMinutes: 120,
    metrics: {
      mspt_p95: { median: 20, p90: 25 },
      mspt_avg: { median: 10, p90: 12 },
      tps_1m: { median: 20, p90: 20 },
      players: { median: 4, p90: 5 },
      entities: { median: 1000, p90: 1100 },
      heap_used_bytes: { median: 1024 * MB, p90: 1200 * MB },
      process_cpu: { median: 0.2, p90: 0.3 },
    },
    entitiesByType: { "minecraft:villager": 30, "minecraft:item": 100, other: 500 },
    tileEntitiesByType: { "minecraft:hopper": 200 },
    worlds: [{ name: "world", loadedChunks: 400, entities: 1000, tileEntities: 300 }],
    plugins: [
      { name: "Essentials", version: "2.20" },
      { name: "WorldEdit", version: "7.3" },
      { name: "OldPlugin", version: "1.0" },
    ],
    config: { viewDistance: 8, simulationDistance: 6 },
    jvm: { heapMaxBytes: 4096 * MB, heapInitBytes: 4096 * MB },
    ...over,
  };
}

const item = (r: ReturnType<typeof computeWhatChanged>, kind: string, key: string) => r.items.find((i) => i.kind === kind && i.key === key);

describe("what changed: helpers", () => {
  it("median (even/odd/empty) and type labels", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(typeLabel("minecraft:zombie_villager")).toBe("Zombie villagers");
    expect(typeLabel("mymod:thing")).toBe("Things");
    expect(typeLabel("minecraft:item")).toBe("Dropped items");
    expect(typeLabel("minecraft:experience_orb")).toBe("Experience orbs");
    expect(typeLabel("minecraft:armor_stand")).toBe("Armor stands");
    expect(typeLabel("minecraft:hopper")).toBe("Hoppers");
    expect(typeLabel("minecraft:chest")).toBe("Chests");
    expect(typeLabel("minecraft:sheep")).toBe("Sheep");
    expect(typeLabel("minecraft:box")).toBe("Boxes");
  });

  it("numericItem: ratio, change, notable thresholds (1.5× up; TPS ≤ 0.67)", () => {
    expect(numericItem("metric", "x", "X", 30, 20)).toMatchObject({ ratio: 1.5, change: "up", notable: true });
    expect(numericItem("metric", "x", "X", 29, 20)).toMatchObject({ ratio: 1.45, change: "up", notable: false });
    expect(numericItem("metric", "x", "X", 21, 20)).toMatchObject({ change: "same", notable: false });
    expect(numericItem("metric", "x", "X", 5, 20)).toMatchObject({ ratio: 0.25, change: "down", notable: false }); // drops aren't notable
    expect(numericItem("metric", "tps_1m", "TPS", 13.4, 20, { lowerIsWorse: true })).toMatchObject({ ratio: 0.67, change: "down", notable: true });
    expect(numericItem("metric", "tps_1m", "TPS", 14, 20, { lowerIsWorse: true })).toMatchObject({ ratio: 0.7, notable: false });
    expect(numericItem("metric", "x", "X", 100, 0)).toMatchObject({ ratio: null, change: "up", notable: true }); // new
    expect(numericItem("metric", "x", "X", 0, 0)).toMatchObject({ ratio: null, change: "same", notable: false });
    expect(numericItem("metric", "x", "X", 12, null)).toMatchObject({ usual: null, ratio: null, change: "same", notable: false });
    expect(numericItem("metric", "x", "X", 12.345, 10, { unit: "ms" })).toMatchObject({ during: 12.3, usual: 10, unit: "ms" });
  });

  it("L6: ratio on unrounded values; an absolute minimum change before 'notable'", () => {
    expect(numericItem("metric", "x", "X", 0.04, 0.03)).toMatchObject({ during: 0, usual: 0, ratio: 1.333, change: "up" });
    expect(numericItem("metric", "mspt_p95", "p95", 0.4, 0.2, { minDelta: 5 })).toMatchObject({ ratio: 2, notable: false });
    expect(numericItem("metric", "mspt_p95", "p95", 12, 6, { minDelta: 5 })).toMatchObject({ ratio: 2, notable: true });
    expect(numericItem("metric", "x", "X", 30, 0, { minDelta: 50 })).toMatchObject({ change: "up", notable: false });
    expect(numericItem("metric", "tps_1m", "TPS", 0.5, 1, { minDelta: 1, lowerIsWorse: true })).toMatchObject({ notable: false });
    const r = computeWhatChanged({ baseline: baseline({ metrics: { mspt_avg: { median: 0.2, p90: 0.3 } } }), samples: [{ mspt_avg: 0.5 }] });
    expect(r.items.find((i) => i.key === "mspt_avg")).toMatchObject({ ratio: 2.5, notable: false });
  });

  it("sort: notable first, then distance from 1 on a log scale (2× and ½ equal), changes first among notable", () => {
    const items = sortItems([
      numericItem("metric", "a", "A", 11, 10), // 1.1
      numericItem("metric", "b", "B", 30, 10), // 3× notable
      numericItem("metric", "c", "C", 5, 10), // 0.5 not notable
      { kind: "plugin", key: "P", label: "P", during: "2", usual: "1", change: "updated", ratio: null, notable: true },
      numericItem("metric", "d", "D", 100, 10), // 10× notable
      numericItem("metric", "e", "E", 7, null), // no comparison
    ]);
    expect(items.map((i) => i.key)).toEqual(["P", "d", "b", "c", "a", "e"]);
  });
});

describe("what changed: computeWhatChanged", () => {
  it("metrics: median during vs baseline median, TPS uses the minimum, bytes in MB, CPU in %", () => {
    const r = computeWhatChanged({
      baseline: baseline(),
      samples: [
        { mspt_p95: 80, mspt_avg: 30, tps_1m: 19.5, players: 4, heap_used_bytes: 2048 * MB, process_cpu: 0.5 },
        { mspt_p95: 120, mspt_avg: 40, tps_1m: 12.1, players: 5, heap_used_bytes: 2048 * MB, process_cpu: 0.7 },
        { mspt_p95: 60, mspt_avg: 20, tps_1m: 17, players: 4, heap_used_bytes: 1024 * MB, process_cpu: 0.6 },
      ],
    });
    expect(whatChanged.parse(r)).toEqual(r);
    expect(r).toMatchObject({ baselineAvailable: true, healthyMinutes: 120, baselineFrom: "2026-11-09T10:00:00.000Z", baselineTo: "2026-11-09T12:00:00.000Z" });
    expect(item(r, "metric", "mspt_p95")).toMatchObject({ during: 80, usual: 20, ratio: 4, change: "up", notable: true, unit: "ms", label: "Tick time (slowest 5 %)" });
    expect(item(r, "metric", "tps_1m")).toMatchObject({ during: 12.1, usual: 20, change: "down", notable: true });
    expect(item(r, "metric", "tps_1m")!.unit).toBeUndefined();
    expect(item(r, "metric", "heap_used_bytes")).toMatchObject({ during: 2048, usual: 1024, unit: "MB", ratio: 2, notable: true });
    expect(item(r, "metric", "process_cpu")).toMatchObject({ during: 60, usual: 20, unit: "%", ratio: 3 });
    expect(item(r, "metric", "players")).toMatchObject({ during: 4, usual: 4, change: "same", notable: false });
    // A metric in the baseline but with no data during: shown with during null, not notable.
    expect(item(r, "metric", "entities")).toMatchObject({ during: null, usual: 1000, notable: false });
    // Not in either: omitted.
    expect(item(r, "metric", "cpu_temp_c")).toBeUndefined();
  });

  it("baseline null: baselineAvailable false, absolute items only (usual null, nothing notable) + plugin history", () => {
    const r = computeWhatChanged({
      baseline: null,
      samples: [{ mspt_p95: 90, tps_1m: 15 }, { mspt_p95: 110, tps_1m: 14 }],
      entitiesByType: { "minecraft:item": 900, "minecraft:cow": 10 },
      worlds: [{ name: "world", loadedChunks: 500, entities: 1200 }],
      plugins: [{ name: "Essentials", version: "2.21" }],
      config: { viewDistance: 12, simulationDistance: 10 },
      pluginHistory: [
        { name: "Essentials", from: "2.20", to: "2.21" },
        { name: "NewThing", from: null, to: "0.1" },
      ],
    });
    expect(whatChanged.parse(r)).toEqual(r);
    expect(r).toMatchObject({ baselineAvailable: false, healthyMinutes: 0, baselineFrom: null, baselineTo: null });
    for (const i of r.items.filter((x) => x.kind !== "plugin")) expect(i).toMatchObject({ usual: null, ratio: null, notable: false });
    expect(item(r, "metric", "mspt_p95")!.during).toBe(100);
    expect(item(r, "metric", "tps_1m")!.during).toBe(14);
    expect(item(r, "entityType", "minecraft:item")).toMatchObject({ during: 900, label: "Dropped items" });
    expect(item(r, "entityType", "minecraft:cow")).toBeUndefined(); // < 50
    expect(item(r, "plugin", "Essentials")).toMatchObject({ change: "updated", usual: "2.20", during: "2.21", notable: true });
    expect(item(r, "plugin", "NewThing")).toMatchObject({ change: "added", usual: null, during: "0.1", notable: true });
    expect(r.items.some((i) => i.kind === "config" || i.kind === "jvm")).toBe(false); // nothing to compare with
    expect(r.items.slice(0, 2).every((i) => i.kind === "plugin")).toBe(true); // notable first
  });

  it("rollup-only incident: metrics from the rollup samples, no type/world items without snapshot or raw detail", () => {
    const r = computeWhatChanged({ baseline: baseline({ entitiesByType: undefined, tileEntitiesByType: undefined, worlds: undefined }), samples: [{ mspt_p95: 70, tps_1m: 16 }, { mspt_p95: 50, tps_1m: 17 }] });
    expect(item(r, "metric", "mspt_p95")).toMatchObject({ during: 60, usual: 20, ratio: 3 });
    expect(r.items.some((i) => ["entityType", "tileEntityType", "world"].includes(i.kind))).toBe(false);
  });

  it("entity / tile entity types: only during ≥ 50 or usual ≥ 50; 'other' skipped; types gone count as 0", () => {
    const r = computeWhatChanged({
      baseline: baseline(),
      samples: [],
      entitiesByType: { "minecraft:villager": 40, "minecraft:item": 2400, "minecraft:zombie": 70, other: 9000 },
      tileEntitiesByType: {},
    });
    expect(item(r, "entityType", "minecraft:villager")).toBeUndefined(); // 40 vs 30
    expect(item(r, "entityType", "minecraft:item")).toMatchObject({ during: 2400, usual: 100, ratio: 24, notable: true });
    expect(item(r, "entityType", "minecraft:zombie")).toMatchObject({ during: 70, usual: 0, ratio: null, change: "up", notable: true });
    expect(item(r, "entityType", "other")).toBeUndefined();
    expect(item(r, "tileEntityType", "minecraft:hopper")).toMatchObject({ during: 0, usual: 200, change: "down", notable: false });
  });

  it("worlds: loaded chunks and entities per world vs baseline", () => {
    const r = computeWhatChanged({ baseline: baseline(), samples: [], worlds: [{ name: "world", loadedChunks: 1200, entities: 1100 }, { name: "nether", loadedChunks: null, entities: 80 }] });
    expect(item(r, "world", "world:loaded_chunks")).toMatchObject({ during: 1200, usual: 400, ratio: 3, notable: true, label: "world: loaded chunks" });
    expect(item(r, "world", "world:entities")).toMatchObject({ during: 1100, usual: 1000, notable: false });
    expect(item(r, "world", "nether:entities")).toMatchObject({ during: 80, usual: null });
    expect(item(r, "world", "nether:loaded_chunks")).toBeUndefined(); // nothing known
  });

  it("plugins added / removed / updated vs the baseline; config and JVM changes; unchanged ones omitted", () => {
    const r = computeWhatChanged({
      baseline: baseline(),
      samples: [],
      plugins: [
        { name: "Essentials", version: "2.21" },
        { name: "WorldEdit", version: "7.3" },
        { name: "Lagger", version: "0.9" },
      ],
      config: { viewDistance: 16, simulationDistance: 6 },
      jvm: { heapMaxBytes: 2048 * MB, heapInitBytes: 4096 * MB },
      pluginHistory: [{ name: "Ignored", from: null, to: "1" }], // only used without a baseline
    });
    expect(item(r, "plugin", "Essentials")).toMatchObject({ change: "updated", usual: "2.20", during: "2.21", notable: true });
    expect(item(r, "plugin", "Lagger")).toMatchObject({ change: "added", usual: null, during: "0.9" });
    expect(item(r, "plugin", "OldPlugin")).toMatchObject({ change: "removed", usual: "1.0", during: null });
    expect(item(r, "plugin", "WorldEdit")).toBeUndefined();
    expect(item(r, "plugin", "Ignored")).toBeUndefined();
    expect(item(r, "config", "view_distance")).toMatchObject({ change: "changed", usual: 8, during: 16, notable: true });
    expect(item(r, "config", "simulation_distance")).toBeUndefined();
    expect(item(r, "jvm", "heap_max")).toMatchObject({ change: "changed", usual: 4096, during: 2048, unit: "MB" });
    expect(item(r, "jvm", "heap_init")).toBeUndefined();
  });

  it("at most 40 items, notable ones kept", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 60; i++) many[`minecraft:t${i}`] = 100 + i;
    const r = computeWhatChanged({ baseline: baseline({ entitiesByType: {} }), samples: [{ mspt_p95: 100 }], entitiesByType: many });
    expect(r.items).toHaveLength(MAX_ITEMS);
    expect(r.items.every((i) => i.notable)).toBe(true);
    expect(whatChanged.parse(r)).toEqual(r);
  });
});
