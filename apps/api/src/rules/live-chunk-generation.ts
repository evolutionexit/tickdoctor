// Rule 9: lag while new chunks are generated (players exploring new land, or forceloading fresh land). Scope
// "incident": generating terrain is normal; it only needs pre-generation when it coincides with lag.
//
// Real Pi run (2026-11-09): generation shows up as *stalls*, not as a high p95. Single ticks of 1.6–21 s every
// ~30 s, TPS down to 11.8, p95 under 10 ms. The agent's per-minute rate also arrives in bursts (994, 0, 575, 0,
// 383, …), so we average it over the incident instead of taking a median, and we report freezes (mspt_max)
// and TPS next to it. Incidents opened by low TPS (DETECTOR.openTps1m) are how these reach this rule.
import type { RuleContext, RuleFinding } from "./types.js";
import {
  FREEZE_MS,
  chart,
  defineRule,
  fmt1,
  fmtInt,
  focusSamples,
  hardwareClass,
  isLagSample,
  isNum,
  mean,
  median,
  peak,
  round,
  steps,
  val,
  values,
  plainName,
  withDetail,
  dict,
} from "./util.js";

/**
 * Average new chunks per minute over the incident. A walking player creates roughly 10–20 new chunks a minute,
 * a player flying with elytra 100+. Terrain generation is heavy CPU work; a Raspberry Pi struggles from
 * ~20/min, a normal server from ~40/min. Below that we stay quiet.
 */
const MIN_RATE = { sbc: 20, small: 40, large: 60 } as const;
const HIGH_RATE = { sbc: 80, small: 150, large: 250 } as const;
/** …and at least 3× what the server usually generates (baseline p90), so normal exploring doesn't count. */
const BASELINE_FACTOR = 3;
/** Generation must show up in at least 2 samples: one burst is not a pattern. */
const MIN_ACTIVE_SAMPLES = 2;
/** A freeze of ≥ 3 s or TPS below 15 makes it high. */
const HIGH_FREEZE_MS = 3000;
const HIGH_TPS = 15;

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope !== "incident") return [];
  const samples = focusSamples(ctx).filter((s) => isNum(val(s, "chunk_gen_per_min")));
  if (samples.length < 3) return [];
  const hw = hardwareClass(ctx);
  const usualP90 = ctx.baseline?.metrics?.chunk_gen_per_min?.p90;
  const usualMed = ctx.baseline?.metrics?.chunk_gen_per_min?.median;
  const line = Math.max(MIN_RATE[hw], isNum(usualP90) ? BASELINE_FACTOR * usualP90 : 0);
  const rates = values(samples, "chunk_gen_per_min");
  const rate = mean(rates)!;
  const active = rates.filter((r) => r > 0).length;
  if (rate < line || active < MIN_ACTIVE_SAMPLES) return [];
  // Generation must coincide with the trouble: a freeze in the same or a neighbouring sample as generation,
  // or high generation during the lag samples themselves.
  const genAt = (i: number) => (val(samples[i]!, "chunk_gen_per_min") ?? 0) > 0;
  const freezeWithGen = samples.some((s, i) => (peak(s, "mspt_max") ?? 0) >= FREEZE_MS && (genAt(i) || (i > 0 && genAt(i - 1)) || (i + 1 < samples.length && genAt(i + 1))));
  const lagRates = values(samples.filter(isLagSample), "chunk_gen_per_min");
  if (!freezeWithGen && !(lagRates.length >= 3 && (mean(lagRates) ?? 0) >= line)) return [];

  const longest = Math.max(0, ...samples.map((s) => peak(s, "mspt_max") ?? 0));
  const freezes = samples.filter((s) => (peak(s, "mspt_max") ?? 0) >= FREEZE_MS).length;
  const tpsVals = values(samples, "tps_1m");
  const minTps = tpsVals.length ? Math.min(...tpsVals) : null;
  const peakRate = Math.max(...rates);

  // Which worlds (from raw detail).
  const perWorld = dict<number[]>();
  for (const s of withDetail(samples)) for (const w of s.detail!.worlds ?? []) if (isNum(w?.chunkGenPerMinute)) (perWorld[w.name] ??= []).push(w.chunkGenPerMinute);
  const worlds = Object.entries(perWorld)
    .map(([name, v]) => ({ name, rate: mean(v) ?? 0 }))
    .filter((w) => w.rate >= 1)
    .sort((a, b) => b.rate - a.rate);
  const playersMed = median(values(samples, "players"));
  const severity = rate >= HIGH_RATE[hw] || longest >= HIGH_FREEZE_MS || (minTps !== null && minTps < HIGH_TPS) ? "high" : "medium";

  const numbers = [
    { label: "New chunks generated per minute (average)", value: round(rate), unit: "/min", ...(isNum(usualMed) ? { baseline: round(usualMed, 1) } : {}) },
    { label: "Highest rate", value: round(peakRate), unit: "/min" },
    ...(longest >= FREEZE_MS ? [{ label: "Longest single tick (server frozen)", value: round(longest / 1000, 1), unit: "s" }] : []),
    ...(freezes > 0 ? [{ label: "Freezes of 1 second or more", value: freezes }] : []),
    ...(minTps !== null ? [{ label: "Lowest TPS", value: round(minTps, 1), baseline: 20 }] : []),
    // Per world only when several worlds generate (one world would just repeat the total).
    ...(worlds.length > 1
      ? worlds.slice(0, 3).map((w) => ({ label: `New chunks per minute in the world ${plainName(w.name)}`, value: round(w.rate), unit: "/min" }))
      : []),
    ...(isNum(playersMed) ? [{ label: "Players online", value: round(playersMed) }] : []),
  ];
  const freezeText =
    longest >= FREEZE_MS
      ? ` The server froze for up to ${fmt1(longest / 1000)} seconds at a time${minTps !== null ? ` and TPS fell to ${fmt1(minTps)}` : ""}.`
      : minTps !== null && minTps < 19
        ? ` TPS fell to ${fmt1(minTps)}.`
        : "";
  const main = plainName(worlds[0]?.name ?? "world");
  // Nobody online during the lag (player count reported, 0 throughout): players can't have explored new land,
  // so something on the server loads chunks by itself (real Pi runs: /forceload with 0 players).
  const playerVals = values(samples, "players");
  const noPlayers = playerVals.length > 0 && Math.max(...playerVals) < 0.5;
  const rateText = `During the lag the server created about ${fmtInt(rate)} new chunks per minute${isNum(usualMed) ? ` (usually ${fmtInt(usualMed)})` : ""}`;
  // The agent doesn't report where chunks are generated, so the centre comes from what the owner finds in the
  // earlier steps (a force-loaded area, where players explored), with spawn only as the fallback. Spawn can be
  // far off: in the real Pi run generation happened around X 3,000.
  const centre = noPlayers
    ? "the area that was being generated (a force-loaded area you found above, or where the plugin sends players; only if you can't tell, your spawn)"
    : "the area that was being generated, where players were exploring (only if you can't tell, your spawn)";
  const chunky = `Pre-generate that land at a quiet time: \`/chunky world ${main}\`, \`/chunky center <x> <z>\` with the coordinates of ${centre}, \`/chunky radius 3000\`, then \`/chunky start\`. ${hw === "sbc" ? "On a Raspberry Pi this can take many hours; `/chunky pause` and `/chunky continue` let you split it up." : "`/chunky pause` and `/chunky continue` let you split it up."}`;
  const border =
    "Optional, and only if nobody has built outside it: set a world border around the same centre so no new land is created while people play: `/worldborder center <x> <z>` (the same coordinates), then `/worldborder set 6000` (twice the radius). Players can't go past the border, so first check that the spawn and everyone's bases lie inside it.";
  const findForceloads =
    "Find what loads the chunks: run `/forceload query` in each world (for example `/execute in minecraft:overworld run forceload query`) and remove areas you don't need with `/forceload remove <x> <z>` or `/forceload remove all`.";
  return [
    {
      ruleId: "live-chunk-generation",
      dedupKey: "chunk-generation",
      severity,
      title: "Lag while new land is being generated",
      explanation: noPlayers
        ? `${rateText} while no players were online. That probably means something on the server was loading new land by itself: an area kept loaded with \`/forceload\`, a pre-generation tool (like Chunky) running at the wrong time, or a plugin that loads far-away land (random teleport, map or world-border plugins).${freezeText} ` +
          "Creating new terrain is heavy work for the CPU, and the server waits until it's done."
        : `${rateText}, which happens when players explore land nobody has visited before.${freezeText} ` +
          "Creating new terrain is heavy work for the CPU, and the server waits until it's done. Generating the world in advance removes that cost.",
      evidence: { numbers, ...(chart(ctx, "chunk_gen_per_min") ? { chart: chart(ctx, "chunk_gen_per_min") } : {}) },
      suggestedFix: noPlayers
        ? steps([
            findForceloads,
            "Check whether a pre-generation tool (Chunky, a map renderer) was running during this time; schedule it for hours when the server isn't needed, or pause it while people play.",
            "Look for plugins that load chunks far away (random teleport, map or world-border plugins): limit their range or let them only use land that already exists.",
            "If none of that explains it, or the land is needed anyway: install the Chunky plugin (from Hangar or Modrinth) if you don't have it yet, and restart.",
            chunky,
            border,
          ])
        : steps([
            "First rule out the server itself: run `/forceload query` in each world and remove force-loaded areas you don't need, and check for plugins that load far-away land (random teleport, map plugins).",
            "Install the Chunky plugin (from Hangar or Modrinth) and restart.",
            chunky,
            "Do the same for the Nether if players travel there a lot (`/chunky world world_nether`, with about an eighth of the radius).",
            border,
          ]),
    },
  ];
}

export const liveChunkGeneration = defineRule({ id: "live-chunk-generation", scopes: ["incident"], evaluate });
