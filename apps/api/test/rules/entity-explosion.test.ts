import { describe, expect, test } from "vitest";
import type { SnapshotPayload } from "@tickdoctor/shared";
import { entityExplosion } from "../../src/rules/entity-explosion.js";
import { MIN, T0, assertValid, baselineOf, handCtx, healthyM, minuteSample, piHello, rawSeries } from "./helpers.js";

const inc = { start: T0 - 5 * MIN, end: T0, peak: 90 };
const lagM = (extra = {}) => healthyM({ mspt_p95: 80, mspt_avg: 45, ...extra });
const snap = (worlds: SnapshotPayload["worldsDetail"]) => ({ trigger: "threshold", ts: new Date(T0 - 2 * MIN).toISOString(), msptP95AtTrigger: 80, sample: {}, worldsDetail: worlds, recentEvents: [] }) as unknown as SnapshotPayload;
const chunk = (x: number, z: number, byType: Record<string, number>, tiles = 0) => ({ x, z, entities: Object.values(byType).reduce((a, b) => a + b, 0), tileEntities: tiles, byType });

describe("entity-explosion", () => {
  test("snapshot: 1,200 zombies in one chunk, no baseline → high, with the chunk for /tp", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(40, () => ({ m: lagM() })),
      snapshot: snap([{ name: "world", entitiesByType: { zombie: 1300, cow: 50 }, tileEntitiesByType: { chest: 20 }, topChunks: [chunk(10, -3, { zombie: 1200, chest: 20 }, 20), chunk(0, 0, { cow: 30 })] }]),
    });
    const fs = entityExplosion.evaluate(ctx);
    fs.forEach(assertValid);
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["world:zombie", "high"]]);
    expect(fs[0]!.title).toBe("Too many zombies in one chunk");
    expect(fs[0]!.evidence.chunks).toEqual([{ world: "world", x: 10, z: -3 }]);
    expect(fs[0]!.suggestedFix).toContain("/tp @s 168 ~ -40");
    expect(fs[0]!.suggestedFix).toContain("minecraft:zombie");
    // Console version covers exactly chunk (10, -3): blocks 160..175, -48..-33.
    expect(fs[0]!.suggestedFix).toContain("`/execute in minecraft:overworld run kill @e[type=minecraft:zombie,limit=100,x=160,y=-64,z=-48,dx=15,dy=383,dz=15]`");
    expect(fs[0]!.suggestedFix).toContain("including named pets");
  });

  describe("console /kill only for Paper's exact default world names", () => {
    const fixIn = (world: string) =>
      entityExplosion.evaluate(handCtx({
        scope: "incident", incident: inc, samples: rawSeries(40, () => ({ m: lagM() })),
        snapshot: snap([{ name: world, entitiesByType: { zombie: 1300 }, tileEntitiesByType: {}, topChunks: [chunk(1, 1, { zombie: 1200 })] }]),
      }))[0]!.suggestedFix;

    test("world_nether → the_nether console command for exactly that chunk", () => {
      expect(fixIn("world_nether")).toContain("`/execute in minecraft:the_nether run kill @e[type=minecraft:zombie,limit=100,x=16,y=-64,z=16,dx=15,dy=383,dz=15]`");
    });
    // A Multiverse world named like a nether must not hit the same chunk of the main nether.
    for (const world of ["creative_nether", "creative_the_end", "survival2"]) {
      test(`${world} → in-game command only, no console guess`, () => {
        const fix = fixIn(world);
        expect(fix).toContain("`/kill @e[type=minecraft:zombie,limit=100,distance=..24]` (only in-game");
        expect(fix).not.toContain("/execute in");
      });
    }
  });

  test("raw worstChunks only (no snapshot, no baseline): 450 items → medium; 300 → not enough without a baseline", () => {
    const mk = (n: number) => handCtx({ scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM(), detail: { worstChunks: [{ world: "world_nether", x: -4, z: 9, entities: n, tileEntities: 0, topEntityType: "item" }] } })) });
    const fs = entityExplosion.evaluate(mk(450));
    expect(fs.map((f) => [f.dedupKey, f.severity])).toEqual([["world_nether:item", "medium"]]);
    expect(fs[0]!.suggestedFix).toContain("in the world `world_nether`");
    expect(fs[0]!.suggestedFix).toContain("`/execute in minecraft:the_nether run kill @e[type=minecraft:item,x=-64,y=-64,z=144,dx=15,dy=383,dz=15]`");
    expect(fs[0]!.suggestedFix).toContain("#### Optional, for when the simple steps aren't enough\n\n1. In `spigot.yml` raise `merge-radius.item`");
    expect(entityExplosion.evaluate(mk(300))).toEqual([]);
  });

  test("a villager hall that was always there (not up vs baseline) is not blamed", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM({ players: 5 }) })),
      baseline: baselineOf({ players: 5, entities: 2000 }, { entitiesByType: { villager: 310, zombie: 200 } }),
      snapshot: snap([{ name: "world", entitiesByType: { villager: 320, zombie: 210 }, tileEntitiesByType: {}, topChunks: [chunk(3, 3, { villager: 300 })] }]),
    });
    expect(entityExplosion.evaluate(ctx)).toEqual([]);
  });

  test("a chunk of 300 cows that's new vs baseline fires", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM({ players: 5 }) })),
      baseline: baselineOf({ players: 5 }, { entitiesByType: { cow: 40 } }),
      snapshot: snap([{ name: "world", entitiesByType: { cow: 360 }, tileEntitiesByType: {}, topChunks: [chunk(3, 3, { cow: 300 })] }]),
    });
    const fs = entityExplosion.evaluate(ctx);
    expect(fs.map((f) => f.dedupKey)).toEqual(["world:cow"]);
    // Verified on Paper 26.2: snake_case is accepted, camelCase rejected.
    expect(fs[0]!.suggestedFix).toContain("`/gamerule max_entity_cramming 24` (on versions before 1.21.11: `maxEntityCramming`)");
  });

  test("world-wide surge without a single hot chunk: 'Far more … than usual' with the usual number", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM({ players: 4 }) })),
      baseline: baselineOf({ players: 4, entities: 1500 }, { entitiesByType: { "minecraft:item": 150 } }),
      snapshot: snap([{ name: "world", entitiesByType: { item: 2600 }, tileEntitiesByType: {}, topChunks: [chunk(1, 1, { item: 60 })] }]),
    });
    const fs = entityExplosion.evaluate(ctx);
    expect(fs.map((f) => f.title)).toEqual(["Far more dropped items than usual"]);
    expect(fs[0]!.explanation).toContain("usually the whole server has about 150");
  });

  test("more players legitimately mean more drops: 5× items at 7× players is not an explosion", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM({ players: 20 }) })),
      baseline: baselineOf({ players: 2 }, { entitiesByType: { item: 500 } }),
      snapshot: snap([{ name: "world", entitiesByType: { item: 2500 }, tileEntitiesByType: {}, topChunks: [chunk(1, 1, { item: 120 })] }]),
    });
    expect(entityExplosion.evaluate(ctx)).toEqual([]);
  });

  test("'other' bucket is never treated as a type", () => {
    const ctx = handCtx({
      scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM(), detail: { worlds: [{ name: "world", loadedChunks: 1, entities: 9000, entitiesByType: { other: 9000 }, tileEntitiesByType: {}, countsAgeSeconds: 5 }] } })),
      baseline: baselineOf({ players: 5 }, { entitiesByType: { other: 100 } }),
    });
    expect(entityExplosion.evaluate(ctx)).toEqual([]);
  });

  test("server scope, rollup-only incidents, empty snapshot: nothing", () => {
    expect(entityExplosion.evaluate(handCtx({ samples: rawSeries(30, () => ({ m: lagM(), detail: { worstChunks: [{ world: "w", x: 1, z: 1, entities: 5000, tileEntities: 0 }] } })) }))).toEqual([]);
    const rollups = Array.from({ length: 20 }, (_, i) => minuteSample(T0 - (19 - i) * MIN, lagM({ entities: 9000 })));
    expect(entityExplosion.evaluate(handCtx({ scope: "incident", incident: inc, samples: rollups }))).toEqual([]);
    expect(entityExplosion.evaluate(handCtx({ scope: "incident", incident: inc, samples: [], snapshot: snap([]) }))).toEqual([]);
  });
});

describe("entity-explosion: spread-out load surge (weighted by cost)", () => {
  const spread = (types: Record<string, number>) =>
    snap([{ name: "world", entitiesByType: types, tileEntitiesByType: {}, topChunks: Array.from({ length: 20 }, (_, i) => chunk(100 + i, 5, Object.fromEntries(Object.entries(types).map(([k, v]) => [k, Math.round(v / 20)])))) }]);
  const run = (types: Record<string, number>, base: Parameters<typeof baselineOf>[1], info?: ReturnType<typeof piHello>) =>
    entityExplosion.evaluate(handCtx({ scope: "incident", incident: inc, samples: rawSeries(30, () => ({ m: lagM({ players: 0 }) })), snapshot: spread(types), baseline: baselineOf({ players: 0, entities: 0 }, base), ...(info ? { info } : {}) }));

  test("Pi: 300 villagers spread over 20 chunks from an empty baseline → fires, villagers first", () => {
    const fs = run({ villager: 300, chicken: 100 }, { entitiesByType: {} });
    expect(fs.map((f) => [f.dedupKey, f.title])).toEqual([["world:villager", "Far more villagers and chickens than usual"]]);
    expect(fs[0]!.evidence.chunks).toHaveLength(10);
  });

  test("Pi: 400 dropped items spread out (cheap) → silent", () => {
    expect(run({ item: 400 }, { entitiesByType: {} })).toEqual([]);
  });

  test("the same 300 villagers on a 16-core server → silent (it has room)", () => {
    const big = piHello({ model: "", arch: "amd64", cores: 16, ram: 64 * 1024 ** 3 });
    delete (big.host as { model?: string }).model;
    expect(run({ villager: 300, chicken: 100 }, { entitiesByType: {} }, big)).toEqual([]);
  });

  test("a server that always has many mobs (baseline 1,500): +400 isn't a surge", () => {
    expect(run({ villager: 120, zombie: 900, cow: 800 }, { entitiesByType: { villager: 100, zombie: 700, cow: 700 } })).toEqual([]);
  });
});
