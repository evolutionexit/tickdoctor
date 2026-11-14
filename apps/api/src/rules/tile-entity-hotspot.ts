// Rule 2: block-entity hotspot (hoppers, furnaces, ...). Scope "incident": a big sorting system becomes a
// problem when the server lags. Scope "server" (lead decision after the real Pi hopper run): an early warning
// at severity "low" for extreme concentrations only (≥ 500 hoppers or ≥ 1,000 ticking block entities in one
// chunk) AND only when their cost is measurable (average tick ≥ 2 ms above usual, or ≥ 5 % of the 50 ms
// budget). A normal server with a few hopper farms stays silent.
//
// Only block entities that the server updates every tick count ("ticking"): hoppers above all, furnaces,
// brewing stands, beacons, spawners, sculk blocks... Chests, barrels and signs don't tick on the server, so a
// storage room with 500 chests is fine and never fires this rule.
//
// Sources: snapshot topChunks (byType merges entity and block-entity ids, see agent ScanTally), else the raw
// samples' worstChunks (block-entity total per chunk only, no types) plus per-world type counts.
import type { RuleContext, RuleFinding } from "./types.js";
import {
  theWorld,
  type Chunk,
  blockX,
  chart,
  chunkKey,
  defineRule,
  fmt1,
  fmtInt,
  focusSamples,
  median,
  round,
  values,
  friendlyType,
  isNum,
  normType,
  steps,
  stepsWithAdvanced,
  sumTypes,
  plainName,
  withDetail,
  dict,
  ownNum,
} from "./util.js";

const TICKING = new Set([
  "hopper",
  "furnace",
  "blast_furnace",
  "smoker",
  "brewing_stand",
  "beacon",
  "spawner",
  "mob_spawner",
  "trial_spawner",
  "campfire",
  "soul_campfire",
  "sculk_sensor",
  "calibrated_sculk_sensor",
  "sculk_shrieker",
  "sculk_catalyst",
  "conduit",
  "end_gateway",
  "bell",
  "crafter",
  "vault",
  "piston",
  "moving_piston",
]);
/**
 * ≥ 100 hoppers in one chunk: each hopper looks for items above it and tries to push items every few ticks;
 * a few hundred in one place is a well-known Paper lag source. Typical bases have a few dozen.
 */
const CHUNK_HOPPERS = 100;
const CHUNK_HOPPERS_HIGH = 300;
/** ≥ 300 ticking block entities of any kind in one chunk (furnace arrays, spawner rooms). */
const CHUNK_TICKING = 300;
const CHUNK_TICKING_HIGH = 600;
/** Without type info we only know the total, which may be mostly chests: require ≥ 800. */
const CHUNK_UNTYPED = 800;
/** World-wide surge vs baseline for a ticking type: ≥ 2× and +300. */
const SURGE_FACTOR = 2;
const SURGE_MIN = 300;
/** Server-scope early warning (see top). */
const EARLY_HOPPERS = 500;
const EARLY_TICKING = 1000;
const EARLY_COST_MS = 2;
const EARLY_BUDGET_MS = 2.5; // 5 % of 50 ms
/** Server scope looks at the last 5 minutes and wants the concentration in ≥ half of those samples. */
const EARLY_RECENT_MS = 5 * 60_000;

interface Cand extends Chunk {
  total: number;
  hoppers?: number;
  ticking?: number;
  /** hoppers/ticking estimated from the world's mix (raw worstChunks carry only a total). */
  estimated?: boolean;
  topType?: string;
  topCount?: number;
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope === "server") return early(ctx);
  if (ctx.scope !== "incident") return [];
  const samples = focusSamples(ctx);
  const raw = withDetail(samples);
  const snapWorlds = Array.isArray(ctx.snapshot?.worldsDetail) ? ctx.snapshot!.worldsDetail : [];

  // Per-world block-entity counts: snapshot, else the latest raw sample.
  const worldTiles = new Map<string, Record<string, number>>();
  for (const w of snapWorlds)
    if (w && typeof w.name === "string") worldTiles.set(w.name, sumTypes([w.tileEntitiesByType]));
  const last = raw[raw.length - 1];
  for (const w of last?.detail?.worlds ?? []) {
    if (!w || typeof w.name !== "string" || worldTiles.has(w.name)) continue;
    worldTiles.set(w.name, sumTypes([w.tileEntitiesByType]));
  }
  const nowTiles = dict<number>();
  for (const m of worldTiles.values())
    for (const [k, v] of Object.entries(m)) nowTiles[k] = (nowTiles[k] ?? 0) + v;

  const cands = new Map<string, Cand>();
  for (const w of snapWorlds) {
    for (const c of Array.isArray(w?.topChunks) ? w.topChunks : []) {
      if (!isNum(c?.x) || !isNum(c?.z)) continue;
      let ticking = 0;
      let topType: string | undefined;
      let topCount = 0;
      for (const [k, v] of Object.entries(c.byType ?? {})) {
        const n = normType(k);
        if (!isNum(v) || !TICKING.has(n)) continue;
        ticking += v;
        if (v > topCount) {
          topType = n;
          topCount = v;
        }
      }
      const hoppers = (c.byType?.["hopper"] ?? 0) + (c.byType?.["minecraft:hopper"] ?? 0);
      cands.set(chunkKey({ world: w.name, x: c.x, z: c.z }), {
        world: w.name,
        x: c.x,
        z: c.z,
        total: c.tileEntities ?? 0,
        hoppers,
        ticking,
        ...(topType ? { topType, topCount } : {}),
      });
    }
  }
  for (const s of raw) addEstimated(cands, s, worldTiles);

  interface Group {
    world: string;
    type: string;
    chunks: Cand[];
    surge?: { now: number; usual: number };
  }
  const groups = new Map<string, Group>();
  const add = (world: string, type: string, c?: Cand) => {
    const k = `${world}:${type}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { world, type, chunks: [] }));
    if (c && !g.chunks.includes(c)) g.chunks.push(c);
    return g;
  };
  for (const c of cands.values()) {
    if (c.ticking !== undefined) {
      if ((c.hoppers ?? 0) >= CHUNK_HOPPERS) add(c.world, "hopper", c);
      else if (c.ticking >= CHUNK_TICKING)
        add(c.world, c.estimated ? "mixed" : (c.topType ?? "mixed"), c);
    } else if (c.total >= CHUNK_UNTYPED) {
      add(c.world, "mixed", c);
    }
  }
  const base = ctx.baseline?.tileEntitiesByType
    ? sumTypes([ctx.baseline.tileEntitiesByType])
    : null;
  if (base) {
    for (const [t, n] of Object.entries(nowTiles)) {
      if (!TICKING.has(t)) continue;
      const usual = base[t] ?? 0;
      if (!(n >= SURGE_FACTOR * usual && n - usual >= SURGE_MIN)) continue;
      let world = "world";
      let best = -1;
      for (const [w, m] of worldTiles) {
        if (ownNum(m, t) > best) {
          best = ownNum(m, t);
          world = w;
        }
      }
      const g = add(world, t);
      g.surge = { now: n, usual };
      for (const c of cands.values())
        if (c.world === world && c.topType === t && (c.topCount ?? 0) >= 20) add(world, t, c);
    }
  }

  const countOf = (c: Cand, type: string) =>
    type === "hopper"
      ? (c.hoppers ?? 0)
      : type === "mixed"
        ? (c.ticking ?? c.total)
        : (c.topCount ?? c.ticking ?? 0);
  const ranked = [...groups.values()]
    .map((g) => ({
      ...g,
      chunks: g.chunks.sort((a, b) => countOf(b, g.type) - countOf(a, g.type)),
    }))
    .sort(
      (a, b) =>
        (b.chunks[0] ? countOf(b.chunks[0], b.type) : (b.surge?.now ?? 0)) -
        (a.chunks[0] ? countOf(a.chunks[0], a.type) : (a.surge?.now ?? 0)),
    )
    .slice(0, 3);

  return ranked.map((g) => {
    const top = g.chunks[0];
    const name =
      g.type === "mixed"
        ? "block entities (hoppers, furnaces, chests and similar)"
        : friendlyType(g.type);
    const n = top ? countOf(top, g.type) : (g.surge?.now ?? 0);
    const high =
      g.type === "hopper" ? n >= CHUNK_HOPPERS_HIGH : (top?.ticking ?? 0) >= CHUNK_TICKING_HIGH;
    const where = top
      ? ` in one chunk in ${theWorld(top.world)} around X ${fmtInt(blockX(top.x))}, Z ${fmtInt(blockX(top.z))} (chunk ${top.x}, ${top.z})`
      : ` in ${theWorld(g.world)}`;
    const usual = g.surge ? `; usually the server has about ${fmtInt(g.surge.usual)} in total` : "";
    const numbers = [
      ...(top
        ? [
            {
              label: `${cap(g.type === "mixed" ? "block entities" : name)} in the worst chunk`,
              value: n,
            },
          ]
        : []),
      ...(top && top.total > n
        ? [{ label: "All block entities in that chunk", value: top.total }]
        : []),
      ...(g.type !== "mixed" && nowTiles[g.type]
        ? [
            {
              label: `${cap(name)} on the whole server`,
              value: nowTiles[g.type]!,
              ...(base ? { baseline: base[g.type] ?? 0 } : {}),
            },
          ]
        : []),
      ...(g.chunks.length > 1 ? [{ label: "Chunks affected", value: g.chunks.length }] : []),
    ];
    return {
      ruleId: "tile-entity-hotspot" as const,
      dedupKey: `${g.world}:${g.type}`,
      severity: high ? ("high" as const) : ("medium" as const),
      title: top
        ? `Too many ${g.type === "mixed" ? "machines and storage blocks" : name} packed into one chunk`
        : `Far more ${name} than usual`,
      explanation:
        `There are ${fmtInt(n)} ${name}${where}${usual}. ` +
        (g.type === "hopper"
          ? "Every hopper checks for items above it and tries to move items several times per second, so hundreds of them in one place take a noticeable part of every tick."
          : "These blocks are updated on every tick, so hundreds of them in one place take a noticeable part of every tick."),
      evidence: {
        numbers,
        ...(chart(ctx, "tile_entities") ? { chart: chart(ctx, "tile_entities") } : {}),
        ...(g.chunks.length
          ? { chunks: g.chunks.slice(0, 10).map((c) => ({ world: c.world, x: c.x, z: c.z })) }
          : {}),
      },
      suggestedFix: fixFor(g.type, top ?? null),
    };
  });
}

/** Share of hoppers / ticking block entities in a world's mix, for estimating raw worstChunks. */
function shares(m: Record<string, number> | undefined) {
  if (!m) return undefined;
  let all = 0;
  let ticking = 0;
  for (const [k, v] of Object.entries(m)) {
    all += v;
    if (TICKING.has(k)) ticking += v;
  }
  if (all <= 0) return undefined;
  return {
    hopper: (m["hopper"] ?? 0) / all,
    ticking: ticking / all,
    worldHoppers: m["hopper"] ?? 0,
    worldTicking: ticking,
  };
}

/** Adds a raw sample's worstChunks, estimating hoppers/ticking from the chunk's world mix (never above the world's count). */
function addEstimated(
  cands: Map<string, Cand>,
  s: RuleContext["samples"][number],
  worldTiles: Map<string, Record<string, number>>,
) {
  const own = new Map<string, Record<string, number>>();
  for (const w of s.detail?.worlds ?? [])
    if (w && typeof w.name === "string") own.set(w.name, sumTypes([w.tileEntitiesByType]));
  // Estimates handed out so far per world: their sum never exceeds the world's real count.
  const used = new Map<string, { hoppers: number; ticking: number }>();
  const worst = [...(s.detail?.worstChunks ?? [])].sort((a, b) => (b?.tileEntities ?? 0) - (a?.tileEntities ?? 0));
  for (const c of worst) {
    if (!c || !isNum(c.x) || !isNum(c.z) || !isNum(c.tileEntities)) continue;
    const k = chunkKey(c);
    const cur = cands.get(k);
    if (cur && cur.estimated === undefined && cur.ticking !== undefined) {
      cur.total = Math.max(cur.total, c.tileEntities);
      continue;
    }
    const sh = shares(own.get(c.world) ?? worldTiles.get(c.world));
    const u = used.get(c.world) ?? { hoppers: 0, ticking: 0 };
    const est = sh
      ? {
          hoppers: Math.max(0, Math.min(sh.worldHoppers - u.hoppers, Math.round(c.tileEntities * sh.hopper))),
          ticking: Math.max(0, Math.min(sh.worldTicking - u.ticking, Math.round(c.tileEntities * sh.ticking))),
          estimated: true,
        }
      : {};
    if (sh && "hoppers" in est) used.set(c.world, { hoppers: u.hoppers + est.hoppers!, ticking: u.ticking + est.ticking! });
    if (!cur || c.tileEntities > cur.total)
      cands.set(k, { world: c.world, x: c.x, z: c.z, total: c.tileEntities, ...est });
  }
}

/** Server scope: extreme concentration whose cost is measurable → low-severity early warning. */
function early(ctx: RuleContext): RuleFinding[] {
  const all = withDetail(Array.isArray(ctx.samples) ? ctx.samples : []);
  if (all.length === 0) return [];
  const lastT = Date.parse(all[all.length - 1]!.ts);
  const recent = all.filter((s) => Date.parse(s.ts) >= lastT - EARLY_RECENT_MS);
  if (recent.length < 3) return [];
  // Per chunk: in how many recent samples is it extreme?
  const hits = new Map<string, { c: Cand; n: number }>();
  for (const s of recent) {
    const cands = new Map<string, Cand>();
    addEstimated(cands, s, new Map());
    for (const [k, c] of cands) {
      if (!((c.hoppers ?? 0) >= EARLY_HOPPERS || (c.ticking ?? 0) >= EARLY_TICKING)) continue;
      const h = hits.get(k);
      if (h) {
        h.n += 1;
        h.c = c;
      } else hits.set(k, { c, n: 1 });
    }
  }
  const chunks = [...hits.values()]
    .filter((h) => h.n >= recent.length / 2)
    .map((h) => h.c)
    .sort((a, b) => (b.hoppers ?? 0) - (a.hoppers ?? 0));
  if (chunks.length === 0) return [];
  // Cost: average tick now vs usual.
  const now = median(values(recent, "mspt_avg"));
  const usual = median(values(Array.isArray(ctx.history) ? ctx.history : [], "mspt_avg"));
  if (now === null) return [];
  const up = usual !== null ? now - usual : 0;
  // Measurable: ≥ 2 ms above the usual average tick; without history, ≥ 5 % of the tick budget.
  if (!(usual !== null ? up >= EARLY_COST_MS : now >= EARLY_BUDGET_MS)) return [];
  const hopperLed = chunks.some((c) => (c.hoppers ?? 0) >= EARLY_HOPPERS);
  const type = hopperLed ? "hopper" : "mixed";
  const top = chunks[0]!;
  const world = top.world;
  const n = hopperLed ? (top.hoppers ?? 0) : (top.ticking ?? top.total);
  const totalHoppers = chunks.reduce((a, c) => a + (c.hoppers ?? 0), 0);
  // The world's real hopper count (latest sample), so the owner can see how the numbers add up.
  const lastWorlds = recent[recent.length - 1]!.detail?.worlds ?? [];
  const worldHoppers = sumTypes([lastWorlds.find((w) => w?.name === world)?.tileEntitiesByType])["hopper"];
  const name = hopperLed
    ? "hoppers"
    : "block entities that update every tick (hoppers, furnaces and similar)";
  return [
    {
      ruleId: "tile-entity-hotspot",
      dedupKey: `${world}:${type}`,
      severity: "low",
      title: hopperLed
        ? "Early warning: a very large hopper build is slowing the server a little"
        : "Early warning: a very large machine build is slowing the server a little",
      explanation:
        `About ${fmtInt(n)} ${name} sit in a single chunk of ${theWorld(world)}, around X ${fmtInt(blockX(top.x))}, Z ${fmtInt(blockX(top.z))}.` +
        (chunks.length > 1
          ? ` ${cap(numberWord(chunks.length))} chunks there hold ${hopperLed ? `${EARLY_HOPPERS}` : `${EARLY_TICKING}`} or more each (about ${fmtInt(hopperLed ? totalHoppers : chunks.reduce((a, c) => a + (c.ticking ?? 0), 0))} together)${hopperLed && isNum(worldHoppers) ? `, and the world has ${fmtInt(worldHoppers)} hoppers in total` : ""}.`
          : "") +
        " " +
        (usual !== null
          ? `The server isn't lagging yet, but each tick now takes about ${fmt1(up)} ms longer than usual (${fmt1(now)} ms instead of ${fmt1(usual)} ms; a tick has 50 ms). That is probably because of ${hopperLed ? "these hoppers" : "this build"}.`
          : `The server isn't lagging yet, but each tick takes ${fmt1(now)} ms (a tick has 50 ms), probably partly because of ${hopperLed ? "these hoppers" : "this build"}.`) +
        " With more players or more builds like this, it adds up to lag.",
      evidence: {
        numbers: [
          {
            label: hopperLed
              ? "Hoppers in the busiest chunk (estimated)"
              : "Ticking block entities in the busiest chunk (estimated)",
            value: n,
          },
          {
            label: hopperLed ? `Chunks with ${EARLY_HOPPERS} or more hoppers` : `Chunks with ${EARLY_TICKING} or more ticking block entities`,
            value: chunks.length,
          },
          ...(hopperLed && chunks.length > 1
            ? [{ label: "Hoppers in those chunks together (estimated)", value: totalHoppers }]
            : []),
          ...(hopperLed && isNum(worldHoppers) ? [{ label: `All hoppers in "${plainName(world)}"`, value: worldHoppers }] : []),
          {
            label: "Average tick time",
            value: round(now, 1),
            unit: "ms",
            ...(usual !== null ? { baseline: round(usual, 1) } : {}),
          },
        ],
        ...(chart(ctx, "mspt_avg") ? { chart: chart(ctx, "mspt_avg") } : {}),
        chunks: chunks.slice(0, 10).map((c) => ({ world: c.world, x: c.x, z: c.z })),
      },
      suggestedFix: fixFor(type, top),
    },
  ];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** 5 → "five" (a sentence may start with it), 12 → "12". */
const numberWord = (n: number) => WORDS[n] ?? fmtInt(n);

function fixFor(type: string, top: Cand | null): string {
  const go = top
    ? `Go to the chunk: use the /tp button next to it, or \`/tp @s ${blockX(top.x)} ~ ${blockX(top.z)}\`${top.world !== "world" ? ` in ${theWorld(top.world)}` : ""}.`
    : "Find the build: look at large sorting systems, furnace arrays and farms built recently.";
  if (type === "hopper" || type === "mixed") {
    return stepsWithAdvanced(
      [
        go,
        "Replace long hopper chains with water streams or ice item elevators where possible, and remove hoppers that no longer do anything.",
      ],
      [
        "In `paper-world-defaults.yml` set `hopper.ignore-occluding-blocks: true`: a hopper pointing into a solid block (like stone or sand) then no longer checks for a hopper or chest minecart hidden inside it. Only builds that feed items into a minecart buried in a block notice the difference.",
        "With care: in `spigot.yml` set `world-settings.default.ticks-per.hopper-check: 8` (instead of 1) so hoppers look for items less often. This can break redstone that depends on exact hopper timing (some item sorters, clocks and counters), so test your farms afterwards and go back to 1 if something misbehaves.",
        "If no plugin needs it (some protection and logging plugins do), set `hopper.disable-move-event: true` in `paper-world-defaults.yml`.",
        "Restart the server after changing the config files.",
      ],
    );
  }
  return steps([
    go,
    `Check whether all those ${friendlyType(type)} are needed; switch off or remove the ones that are idle or part of a farm nobody uses.`,
    "Spread large arrays over several chunks or replace them with fewer, faster machines.",
    "If players keep building these, agree on a size limit for farms.",
  ]);
}

export const tileEntityHotspot = defineRule({
  id: "tile-entity-hotspot",
  scopes: ["incident", "server"],
  evaluate,
});
