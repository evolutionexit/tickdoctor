// Rule 1: entity explosion. Scope "incident": entity piles matter because they cause lag; outside an incident a
// big farm on a server that runs fine is not a problem worth a finding.
//
// Sources, best first: the incident snapshot (all entity types per world + top 50 chunks with per-type counts),
// then the raw samples' detail (top 20 types per world + the 10 worst chunks). Compared with the baseline's
// per-type medians when there is one, scaled by player count (more players → more mobs and drops, legitimately).
// Rollup-only incidents (no detail, no snapshot) can't be judged: no finding.
import { worldToDimension } from "@tickdoctor/shared";
import type { RuleContext, RuleFinding } from "./types.js";
import {
  theWorld,
  usualOf,
  type Chunk,
  type HardwareClass,
  hardwareClass,
  blockX,
  chart,
  chunkKey,
  defineRule,
  fmtInt,
  focusSamples,
  friendlyType,
  isNum,
  median,
  normType,
  steps,
  stepsWithAdvanced,
  sumTypes,
  values,
  plainName,
  withDetail,
  dict,
  ownNum,
} from "./util.js";

/**
 * A chunk with ≥ 250 entities is a candidate. Normal chunks hold a handful; mob farms at the cramming limit
 * and villager halls usually stay under ~150. Without a baseline to show it's new, we need ≥ 400.
 */
const CHUNK_MIN = 250;
const CHUNK_MIN_NO_BASELINE = 400;
/** ≥ 1,000 in one chunk is lag on any hardware: fire even if the type isn't up vs the baseline. */
const CHUNK_ALWAYS = 1000;
/** A type counts as "up" vs baseline at ≥ 2× the expected count and +200. */
const ELEVATED_FACTOR = 2;
const ELEVATED_MIN = 200;
/** World-wide surge without a single hot chunk: ≥ 3× expected and +1,000. */
const SURGE_FACTOR = 3;
const SURGE_MIN = 1000;
const HIGH_CHUNK = 1000;

/**
 * Rough relative main-thread cost per entity (a plain mob = 1), from Paper/spark experience: villagers run a
 * "brain" (job sites, beds, gossip, pathfinding) and cost several times a cow or zombie; other brain mobs
 * (piglins, axolotls, goats, ...) about double; dropped items, orbs and decorations far less.
 */
const BRAIN4 = new Set(["villager", "wandering_trader", "warden"]);
const BRAIN2 = new Set([
  "piglin",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "axolotl",
  "goat",
  "frog",
  "tadpole",
  "allay",
  "camel",
  "sniffer",
  "armadillo",
  "breeze",
  "creaking",
  "bogged",
]);
export function entityWeight(type: string): number {
  const t = normType(type);
  if (BRAIN4.has(t)) return 4;
  if (BRAIN2.has(t)) return 2;
  if (ITEMS.has(t)) return 0.25;
  if (PROJECTILES.has(t)) return 0.3;
  if (t === "hopper_minecart") return 1;
  if (VEHICLES.test(t)) return 0.5;
  if (t === "armor_stand") return 0.2;
  if (DECOR.has(t)) return 0.05;
  return 1;
}
/**
 * Load surge: weighted entity load up by at least this much vs the (player-scaled) baseline, and ≥ 3× it.
 * A Raspberry Pi handles roughly 1,000–1,500 plain mobs before ticks get tight; +600 weighted (150 villagers,
 * or 600 cows) on top of its usual load is a clear cause. Faster CPUs get proportionally more room.
 */
const LOAD_SURGE: Record<HardwareClass, number> = { sbc: 600, small: 1500, large: 3000 };
const LOAD_FACTOR = 3;
const HIGH_SURGE = 3000;

const ITEMS = new Set(["item", "experience_orb"]);
const PROJECTILES = new Set([
  "arrow",
  "spectral_arrow",
  "trident",
  "snowball",
  "egg",
  "ender_pearl",
  "fireball",
  "small_fireball",
  "wither_skull",
  "firework_rocket",
  "llama_spit",
  "shulker_bullet",
]);
const VEHICLES = /minecart$|boat$|^raft$|chest_raft$/;
const DECOR = new Set([
  "armor_stand",
  "item_frame",
  "glow_item_frame",
  "painting",
  "item_display",
  "block_display",
  "text_display",
  "interaction",
]);

interface ChunkCand extends Chunk {
  entities: number;
  type?: string;
  typeCount?: number;
  byType?: Record<string, number>;
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope !== "incident") return [];
  const samples = focusSamples(ctx);
  const raw = withDetail(samples);
  const snap = ctx.snapshot && typeof ctx.snapshot === "object" ? ctx.snapshot : null;
  const snapWorlds = Array.isArray(snap?.worldsDetail) ? snap!.worldsDetail : [];

  // ---- now: per-world type counts ----
  const worldTypes = new Map<string, Record<string, number>>();
  const tileIds = new Set<string>();
  for (const w of snapWorlds) {
    if (!w || typeof w.name !== "string") continue;
    worldTypes.set(w.name, sumTypes([w.entitiesByType]));
    for (const k of Object.keys(w.tileEntitiesByType ?? {})) tileIds.add(normType(k));
  }
  // Peak raw sample (most entities) fills in worlds the snapshot doesn't cover. When the snapshot has a world,
  // its fresh full count wins: raw counts are gathered incrementally and can count moving mobs twice
  // (real Pi entity run: 600 villagers in raw vs the 450 actually summoned, which the snapshot reported).
  const peakRaw = raw.reduce<(typeof raw)[number] | undefined>(
    (best, s) => ((s.m?.entities ?? 0) > (best?.m?.entities ?? -1) ? s : best),
    undefined,
  );
  if (peakRaw) {
    for (const w of peakRaw.detail!.worlds ?? []) {
      if (!w || typeof w.name !== "string") continue;
      if (
        snapWorlds.some((x) => x?.name === w.name && Object.keys(x.entitiesByType ?? {}).length > 0)
      )
        continue;
      const fromRaw = sumTypes([w.entitiesByType]);
      const cur = worldTypes.get(w.name) ?? dict<number>();
      for (const [k, v] of Object.entries(fromRaw)) cur[k] = Math.max(cur[k] ?? 0, v);
      worldTypes.set(w.name, cur);
      for (const k of Object.keys(w.tileEntitiesByType ?? {})) tileIds.add(normType(k));
    }
  }
  const nowTypes = dict<number>();
  for (const m of worldTypes.values())
    for (const [k, v] of Object.entries(m)) nowTypes[k] = (nowTypes[k] ?? 0) + v;

  // ---- now: chunks ----
  const chunks = new Map<string, ChunkCand>();
  const addChunk = (c: ChunkCand) => {
    if (!isNum(c.x) || !isNum(c.z) || !isNum(c.entities)) return;
    const k = chunkKey(c);
    const cur = chunks.get(k);
    if (cur?.byType && !c.byType) return; // snapshot chunk (fresh, per type) beats a raw worstChunk
    if (
      !cur ||
      c.entities > cur.entities ||
      (c.typeCount !== undefined && cur.typeCount === undefined) ||
      (c.byType && !cur.byType)
    )
      chunks.set(k, { ...cur, ...c });
  };
  for (const w of snapWorlds) {
    for (const c of Array.isArray(w?.topChunks) ? w.topChunks : []) {
      let type: string | undefined;
      let typeCount = 0;
      for (const [k, v] of Object.entries(c.byType ?? {})) {
        const n = normType(k);
        if (tileIds.has(n) || !isNum(v) || n === "other") continue;
        if (v > typeCount) {
          type = n;
          typeCount = v;
        }
      }
      addChunk({
        world: w.name,
        x: c.x,
        z: c.z,
        entities: c.entities,
        byType: sumTypes([c.byType]),
        ...(type ? { type, typeCount } : {}),
      });
    }
  }
  for (const s of raw) {
    for (const c of s.detail!.worstChunks ?? []) {
      if (!c) continue;
      addChunk({
        world: c.world,
        x: c.x,
        z: c.z,
        entities: c.entities,
        ...(c.topEntityType ? { type: normType(c.topEntityType) } : {}),
      });
    }
  }

  // ---- baseline expectation, scaled by players ----
  const base = ctx.baseline?.entitiesByType ? sumTypes([ctx.baseline.entitiesByType]) : null;
  const playersNow = median(values(samples, "players")) ?? 0;
  const basePlayers = ctx.baseline?.metrics?.players?.median ?? 0;
  const scale = Math.max(1, (playersNow + 1) / (basePlayers + 1));
  const expected = (t: string) => (base ? (base[t] ?? 0) * scale : undefined);
  const elevated = (t: string | undefined) => {
    if (!t || !base) return false;
    const e = expected(t)!;
    const n = nowTypes[t] ?? 0;
    return n >= ELEVATED_FACTOR * e && n - e >= ELEVATED_MIN;
  };

  // ---- group candidates by world:type ----
  interface Group {
    world: string;
    type: string;
    chunks: ChunkCand[];
    surge: boolean;
    load?: { now: number; usual: number; parts: { type: string; n: number }[]; chunkCount: number };
  }
  const groups = new Map<string, Group>();
  const group = (world: string, type: string) => {
    const k = `${world}:${type}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { world, type, chunks: [], surge: false }));
    return g;
  };
  for (const c of chunks.values()) {
    if (c.entities < CHUNK_MIN) continue;
    const ok = base
      ? elevated(c.type) || c.entities >= CHUNK_ALWAYS
      : c.entities >= CHUNK_MIN_NO_BASELINE;
    if (!ok) continue;
    group(c.world, c.type ?? "mixed").chunks.push(c);
  }
  if (base) {
    for (const [t, n] of Object.entries(nowTypes)) {
      const e = expected(t)!;
      if (!(n >= SURGE_FACTOR * e && n - e >= SURGE_MIN)) continue;
      // The world holding most of them.
      let world = "world";
      let best = -1;
      for (const [w, m] of worldTypes) {
        if (ownNum(m, t) > best) {
          best = ownNum(m, t);
          world = w;
        }
      }
      const g = group(world, t);
      g.surge = true;
      for (const c of chunks.values())
        if (
          c.world === world &&
          c.type === t &&
          (c.typeCount ?? c.entities) >= 50 &&
          !g.chunks.includes(c)
        )
          g.chunks.push(c);
    }
  }

  // ---- load surge: many entities spread out, weighted by cost ----
  const baseTotal = ctx.baseline?.metrics?.entities?.median;
  const usualLoad = base
    ? Object.entries(base).reduce((a, [t, n]) => a + entityWeight(t) * n, 0) * scale
    : isNum(baseTotal)
      ? baseTotal * scale // no per-type baseline: count every usual entity as a plain mob
      : undefined;
  if (usualLoad !== undefined) {
    const nowLoad = Object.entries(nowTypes).reduce((a, [t, n]) => a + entityWeight(t) * n, 0);
    if (
      nowLoad - usualLoad >= LOAD_SURGE[hardwareClass(ctx)] &&
      nowLoad >= LOAD_FACTOR * usualLoad
    ) {
      const parts = Object.entries(nowTypes)
        .map(([type, n]) => ({ type, n, extra: entityWeight(type) * (n - (expected(type) ?? 0)) }))
        .filter((x) => x.extra > 0)
        .sort((a, b) => b.extra - a.extra);
      const top = parts[0];
      if (top) {
        let world = "world";
        let best = -1;
        for (const [w, m] of worldTypes) {
          if ((m[top.type] ?? 0) > best) {
            best = m[top.type] ?? 0;
            world = w;
          }
        }
        const g = group(world, top.type);
        const typed = [...chunks.values()].some((c) => c.byType);
        const mine = [...chunks.values()].filter(
          (c) =>
            c.world === world && (typed ? (c.byType?.[top.type] ?? 0) > 0 : c.type === top.type),
        );
        g.load = {
          now: nowLoad,
          usual: usualLoad,
          parts: parts.slice(0, 3).map(({ type, n }) => ({ type, n })),
          chunkCount: mine.length,
        };
        const countIn = (c: ChunkCand) => c.byType?.[top.type] ?? c.entities;
        for (const c of mine.sort((a, b) => countIn(b) - countIn(a)).slice(0, 10))
          if (!g.chunks.includes(c)) g.chunks.push(c);
      }
    }
  }

  const ranked = [...groups.values()]
    .map((g) => ({
      ...g,
      chunks: g.chunks.sort(
        (a, b) => (b.byType?.[g.type] ?? b.entities) - (a.byType?.[g.type] ?? a.entities),
      ),
      now: nowTypes[g.type] ?? 0,
    }))
    .sort(
      (a, b) =>
        Math.max(b.now, b.chunks[0]?.entities ?? 0) - Math.max(a.now, a.chunks[0]?.entities ?? 0),
    )
    .slice(0, 3);

  const totalNow = median(values(samples, "entities"));
  const totalUsual = ctx.baseline?.metrics?.entities?.median;
  const hw = hardwareClass(ctx);
  return ranked.map((g) => {
    const top = g.chunks[0];
    // "In one chunk" wording only when the top chunk is itself a pile; for a spread-out surge the chunks are
    // just where most of them are.
    const hot = top !== undefined && top.entities >= CHUNK_MIN;
    const name = g.type === "mixed" ? "entities" : friendlyType(g.type);
    const exp = expected(g.type);
    const excess = exp !== undefined ? g.now - exp : 0;
    const loadHigh = g.load !== undefined && g.load.now - g.load.usual >= 2 * LOAD_SURGE[hw];
    const severity =
      (top?.entities ?? 0) >= HIGH_CHUNK || (g.surge && excess >= HIGH_SURGE) || loadHigh
        ? "high"
        : "medium";
    const at = (c: ChunkCand) =>
      `${theWorld(c.world)} around X ${fmtInt(blockX(c.x))}, Z ${fmtInt(blockX(c.z))} (chunk ${c.x}, ${c.z})`;
    const total = isNum(totalNow)
      ? [
          {
            label: "All entities on the server",
            value: Math.round(totalNow),
            ...(isNum(totalUsual) ? { baseline: usualOf(totalUsual) } : {}),
          },
        ]
      : [];
    const evidenceRest = {
      ...(chart(ctx, "entities") ? { chart: chart(ctx, "entities") } : {}),
      ...(g.chunks.length
        ? { chunks: g.chunks.slice(0, 10).map((c) => ({ world: c.world, x: c.x, z: c.z })) }
        : {}),
    };

    if (g.load && !hot && !g.surge) {
      // Spread out: many entities over many chunks, no single pile.
      const L = g.load;
      const list = L.parts.map((x) => `${fmtInt(x.n)} ${friendlyType(x.type)}`);
      const listText =
        list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
      // The snapshot lists at most 50 chunks per world: "50+" when the list is full.
      const spread =
        L.chunkCount > 1
          ? `, spread over ${fmtInt(L.chunkCount)}${L.chunkCount >= 50 ? "+" : ""} chunks`
          : "";
      const most = top
        ? ` (the busiest chunk is around X ${fmtInt(blockX(top.x))}, Z ${fmtInt(blockX(top.z))})`
        : "";
      const usual = isNum(totalUsual)
        ? Math.round(totalUsual) === 0
          ? " Usually your server has almost no mobs or items loaded."
          : ` Usually your server has about ${fmtInt(totalUsual)} mobs, items and the like loaded in total.`
        : "";
      const brainy = L.parts.some((x) => BRAIN4.has(x.type))
        ? " Villagers are among the most expensive mobs: each one keeps searching for a job block, a bed and a path."
        : "";
      return {
        ruleId: "entity-explosion" as const,
        dedupKey: `${g.world}:${g.type}`,
        severity,
        // Name every part: "mobs" would be wrong when dropped items or minecarts are among them.
        title: `Far more ${andList(L.parts.map((x) => friendlyType(x.type)))} than usual`,
        explanation:
          `There are ${listText} in ${theWorld(g.world)}${spread}${most}.${usual}${brainy} ` +
          `The server has to update every one of them 20 times a second (once per tick)${hw === "sbc" ? ", and a Raspberry Pi has little time to spare, so this many take up a large part of it." : ", so this many take up a large part of each tick."}`,
        evidence: {
          numbers: [
            ...L.parts.map((x) => ({
              label: `${cap(friendlyType(x.type))} on the whole server`,
              value: x.n,
              ...(expected(x.type) !== undefined
                ? { baseline: usualOf(expected(x.type)!) }
                : {}),
            })),
            ...total,
            ...(L.chunkCount > 0 ? [{ label: `Chunks with ${name}`, value: L.chunkCount }] : []),
            ...(top ? [{ label: "Entities in the busiest chunk", value: top.entities }] : []),
          ],
          ...evidenceRest,
        },
        suggestedFix: fixFor(g.type, top ?? null, L.chunkCount > 1),
      };
    }

    const usualText =
      exp !== undefined && g.type !== "mixed"
        ? Math.round(exp) === 0
          ? `; usually there are none`
          : `; usually the whole server has about ${fmtInt(exp)}`
        : "";
    const countText = hot
      ? `${fmtInt(top.typeCount ?? top.entities)} ${name} in ${at(top)}`
      : `${fmtInt(g.now)} ${name} in ${theWorld(g.world)}${top ? `, the most around X ${fmtInt(blockX(top.x))}, Z ${fmtInt(blockX(top.z))}` : ""}`;
    const numbers = [
      ...(top
        ? [
            {
              label:
                g.type === "mixed"
                  ? "Entities in the worst chunk"
                  : `${cap(name)} in the worst chunk`,
              value: top.typeCount ?? top.entities,
            },
          ]
        : []),
      ...(top && top.typeCount !== undefined && top.typeCount !== top.entities
        ? [{ label: "All entities in that chunk", value: top.entities }]
        : []),
      ...(g.type !== "mixed" && g.now > 0
        ? [
            {
              label: `${cap(name)} on the whole server`,
              value: g.now,
              ...(exp !== undefined ? { baseline: usualOf(exp) } : {}),
            },
          ]
        : []),
      ...total,
      ...(g.chunks.length > 1 ? [{ label: "Chunks affected", value: g.chunks.length }] : []),
    ];
    return {
      ruleId: "entity-explosion" as const,
      dedupKey: `${g.world}:${g.type}`,
      severity,
      title: hot ? `Too many ${name} in one chunk` : `Far more ${name} than usual`,
      explanation:
        `There are ${countText}${usualText}. ` +
        `The server updates every entity 20 times a second (once per tick), so ${hot ? "a pile like this" : "this many"} takes time out of every tick.` +
        (ITEMS.has(g.type)
          ? " Dropped items usually pile up when a farm's collection system is full or broken."
          : ""),
      evidence: { numbers, ...evidenceRest },
      suggestedFix: fixFor(g.type, top ?? null, false),
    };
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** ["a","b","c"] → "a, b and c" */
const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? "");

/**
 * How to run a /kill: `distance=` only means "near me" in-game. From the console it measures from the world
 * spawn, so it would hit the wrong entities. When we know the chunk and its dimension we also give a console
 * version that selects exactly that chunk (a 16 × 16 box, full height).
 */
function killHow(selector: string, distance: number, top: ChunkCand | null): string {
  const inGame = `in-game while standing ${top ? "in the chunk" : "next to them"}: \`/kill @e[${selector},distance=..${distance}]\``;
  // Exact default names only: "creative_nether" must not map to the main nether (the console command would
  // delete entities in the wrong world).
  const dim = top ? worldToDimension(top.world) : null;
  if (!top || !dim) return `${inGame} (only in-game: from the console \`distance\` is measured from the world spawn)`;
  const box = `x=${top.x * 16},y=-64,z=${top.z * 16},dx=15,dy=383,dz=15`;
  return `${inGame}, or from the console, which removes them in exactly that chunk: \`/execute in ${dim} run kill @e[${selector},${box}]\``;
}

function fixFor(rawType: string, top: ChunkCand | null, spread: boolean): string {
  const type = plainName(rawType);
  const go = top
    ? spread
      ? `Go to the busiest chunk: use the /tp buttons (the chunks are listed busiest first), or \`/tp @s ${blockX(top.x)} ~ ${blockX(top.z)}\`${top.world !== "world" ? ` in ${theWorld(top.world)}` : ""}.`
      : `Go to the chunk: use the /tp button next to it, or \`/tp @s ${blockX(top.x)} ~ ${blockX(top.z)}\`${top.world !== "world" ? ` in ${theWorld(top.world)}` : ""}.`
    : `Find where they are: check farms and builds made recently, or stand in a busy area in-game and run \`/execute if entity @e[type=minecraft:${type},distance=..64]\` to count them within 64 blocks of you.`;
  const id = `minecraft:${type}`;
  const restart = "Restart the server after changing these files.";
  if (type === "mixed") {
    return steps([
      go,
      "Look at what's packed in there (mobs in a farm, dropped items, minecarts) and reduce it.",
      "Remove what isn't needed with `/kill @e[distance=..24,type=!minecraft:player]`, in-game while standing in the chunk (from the console `distance` is measured from the world spawn, so it would hit the wrong place). It removes everything except players within 24 blocks, including named pets, villagers and armor stands, so look first.",
      "If it's a farm, add a limit (a kill chamber or an on/off switch) so it can't fill up again.",
    ]);
  }
  if (ITEMS.has(type)) {
    return stepsWithAdvanced(
      [
        go,
        "Find the farm or machine that drops them and fix why items aren't collected (full chests, a broken or jammed hopper line, a farm with no storage).",
        `Clear the pile: run this ${killHow(`type=${id}`, 48, top)}. This deletes the ${type === "item" ? "items" : "orbs"} for good, including anything valuable lying there.`,
        "Switch the farm off when nobody needs it, or give it more storage.",
      ],
      type === "item"
        ? [
            "In `spigot.yml` raise `merge-radius.item` (for example to `4.0`) so dropped items stack into fewer entities.",
            "In `paper-world-defaults.yml` set `entities.spawning.alt-item-despawn-rate.enabled: true` and list junk items under `items` with a shorter time in ticks (for example `cobblestone: 300`, which is 15 seconds) so they disappear sooner.",
            restart,
          ]
        : [
            "In `spigot.yml` raise `merge-radius.exp` (for example to `6.0`) so orbs merge into fewer entities.",
            restart,
          ],
    );
  }
  if (PROJECTILES.has(type)) {
    return stepsWithAdvanced(
      [
        go,
        `Clear them: run this ${killHow(`type=${id}`, 48, top)}.`,
        "Find what produces them (a dispenser clock, a skeleton farm, a broken trap) and stop it.",
      ],
      [
        `In \`paper-world-defaults.yml\` set \`chunks.entity-per-chunk-save-limit.${type}\` to a small number (for example \`16\`) so a chunk can't store hundreds of them.`,
        restart,
      ],
    );
  }
  if (VEHICLES.test(type)) {
    return steps([
      go,
      `Remove the extra ones: run this ${killHow(`type=${id}`, 32, top)}. Check first that nobody is riding one and that none hold items someone needs.`,
      "Look for a machine that keeps placing them (minecart or boat dispenser) and switch it off.",
    ]);
  }
  if (DECOR.has(type)) {
    return stepsWithAdvanced(
      [
        go,
        "Check whether a build or a contraption placed this many on purpose; remove the ones that aren't needed.",
      ],
      type === "armor_stand"
        ? [
            "In `paper-world-defaults.yml`, `entities.armor-stands.tick: false` stops armor stands from being updated every tick (fine unless a plugin needs moving armor stands).",
            restart,
          ]
        : [],
    );
  }
  if (type === "falling_block" || type === "tnt") {
    return steps([
      go,
      "Check for a sand/gravel duper, TNT cannon or a contraption stuck in a loop and switch it off.",
      `Clear them: run this ${killHow(`type=${id}`, 48, top)}.`,
    ]);
  }
  if (type === "villager") {
    return stepsWithAdvanced(
      [
        go,
        "Check what the villagers are for: a breeder that keeps running, or a trading hall with more villagers than anyone uses.",
        `Switch off the breeders (take away the beds or the food). To thin them out, run this ${killHow(`type=${id},limit=50`, 24, top)}. It removes up to 50 villagers at a time, including ones players trade with, so look around first.`,
        "Keep trading villagers in single-block cells with their job block, so they don't keep searching for paths.",
      ],
      [
        "In `spigot.yml` lower `entity-activation-range.villagers` (default 32, for example to `16`) so villagers far from players are updated less often.",
        "In `paper-world-defaults.yml` let farmer villagers look for farmland less often: under `tick-rates.sensor.villager` set `secondarypoisensor: 80` (Paper's default is 40). This is a Paper setting whose names can change between Paper versions.",
        restart,
      ],
    );
  }
  // Mobs (animals, monsters, other villager-like mobs).
  return stepsWithAdvanced(
    [
      go,
      `Check whether a farm or breeder there is overfull. Reduce the number: run this ${killHow(`type=${id},limit=100`, 24, top)}. It removes up to 100 at a time, including named pets, so look first.`,
      "Add a limit to the farm (a kill chamber, fewer breeding animals, or turn the breeder off).",
      "Optional: `/gamerule max_entity_cramming 24` (on versions before 1.21.11: `maxEntityCramming`) restores the default, so mobs packed into one block beyond 24 take damage instead of piling up; run `/gamerule max_entity_cramming` first to see whether someone set it higher.",
    ],
    [
      "In `paper-world-defaults.yml` lower `collisions.max-entity-collisions` (default 8, for example to `2`): packed mobs then cost far less.",
      restart,
    ],
  );
}

export const entityExplosion = defineRule({
  id: "entity-explosion",
  scopes: ["incident"],
  evaluate,
});
