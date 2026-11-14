// Rule 8: view/simulation distance too high for the hardware. Scope "incident": a high distance on a server
// that keeps up is the owner's choice, not a problem. It becomes a finding when the server clearly lags, the
// settings are above what the hardware class handles, many chunks are loaded, and the lag isn't better
// explained by an entity pile or chunk generation (those rules cover it).
import type { RuleContext, RuleFinding } from "./types.js";
import {
  type HardwareClass,
  chart,
  defineRule,
  fmtInt,
  focusSamples,
  hardwareClass,
  hardwareLabel,
  isClearLagSample,
  isNum,
  mean,
  median,
  round,
  secondsWhere,
  stepsWithAdvanced,
  values,
  withDetail,
} from "./util.js";

/**
 * What each hardware class handles comfortably (Paper community experience). Simulation distance (chunks
 * where mobs, crops and redstone are updated) costs CPU every tick; view distance (chunks sent to players)
 * costs memory and loading work. Paper's defaults are view 10 / sim 10 on decent hardware.
 * - sbc (Raspberry Pi class): sim ≤ 6, view ≤ 8.  - small (≤ 4 cores): sim ≤ 8, view ≤ 10.  - large: sim ≤ 10, view ≤ 12.
 */
const MAX: Record<HardwareClass, { sim: number; view: number }> = {
  sbc: { sim: 6, view: 8 },
  small: { sim: 8, view: 10 },
  large: { sim: 10, view: 12 },
};
/** Loaded chunks (all worlds) above which the chunk count itself is a load for that class. */
const CHUNK_BUDGET: Record<HardwareClass, number> = { sbc: 1500, small: 4000, large: 8000 };
/** At least 2 minutes of clear lag in the incident. */
const MIN_LAG_SECONDS = 120;

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope !== "incident") return [];
  const cfg = ctx.info?.config;
  if (!cfg || !isNum(cfg.viewDistance) || !isNum(cfg.simulationDistance)) return [];
  const hw = hardwareClass(ctx);
  const max = MAX[hw];
  const simOver = cfg.simulationDistance > max.sim;
  const viewOver = cfg.viewDistance > max.view;
  if (!simOver && !viewOver) return [];

  const samples = focusSamples(ctx);
  if (secondsWhere(samples, isClearLagSample) < MIN_LAG_SECONDS) return [];
  const lagSamples = samples.filter(isClearLagSample);
  const chunks = median(values(lagSamples, "loaded_chunks"));
  if (chunks === null || chunks < CHUNK_BUDGET[hw]) return [];

  // Better explained elsewhere? Chunk generation (rule 9) or an entity pile (rule 1).
  // Mean, not median: the agent reports generation in bursts (see live-chunk-generation).
  const gen = mean(values(samples, "chunk_gen_per_min")) ?? 0;
  if (gen >= (hw === "sbc" ? 20 : 40)) return [];
  const pile = withDetail(samples).some((s) => (s.detail!.worstChunks ?? []).some((c) => (c?.entities ?? 0) >= 250));
  const snapPile = (ctx.snapshot?.worldsDetail ?? []).some((w) => (w?.topChunks ?? []).some((c) => (c?.entities ?? 0) >= 250));
  if (pile || snapPile) return [];
  const usualEntities = ctx.baseline?.metrics?.entities?.median;
  const entities = median(values(lagSamples, "entities"));
  const usualPlayers = ctx.baseline?.metrics?.players?.median ?? 0;
  const players = median(values(lagSamples, "players")) ?? 0;
  if (isNum(usualEntities) && isNum(entities) && entities > 3 * usualEntities * Math.max(1, (players + 1) / (usualPlayers + 1))) return [];

  const usualChunks = ctx.baseline?.metrics?.loaded_chunks?.median;
  const newSim = Math.min(cfg.simulationDistance, max.sim);
  const newView = Math.min(cfg.viewDistance, max.view);
  const p95 = median(values(lagSamples, "mspt_p95"));
  const severity = chunks >= 2 * CHUNK_BUDGET[hw] ? "high" : "medium";
  const hwName = hardwareLabel(ctx);
  return [
    {
      ruleId: "view-distance-too-high",
      dedupKey: "distance-settings",
      severity,
      title: "View or simulation distance is probably too high for this hardware",
      explanation:
        `The server keeps ${fmtInt(chunks)} chunks loaded (view distance ${cfg.viewDistance}, simulation distance ${cfg.simulationDistance}). ` +
        `That is more than ${hwName} usually handles comfortably (around view distance ${max.view} and simulation distance ${max.sim}). ` +
        "View distance is how far players can see; simulation distance is how far away mobs, crops and redstone keep running. " +
        "The further they reach, the more the server has to update, and it grows quickly with every player.",
      evidence: {
        numbers: [
          { label: "Loaded chunks during the lag", value: round(chunks), ...(isNum(usualChunks) ? { baseline: round(usualChunks) } : {}) },
          { label: `View distance (recommended here: ${max.view} or less)`, value: cfg.viewDistance },
          { label: `Simulation distance (recommended here: ${max.sim} or less)`, value: cfg.simulationDistance },
          ...(isNum(p95) ? [{ label: "Slowest ticks during the lag (healthy: under 50 ms)", value: round(p95, 1), unit: "ms" }] : []),
          { label: "Players online", value: round(players) },
        ],
        ...(chart(ctx, "loaded_chunks") ? { chart: chart(ctx, "loaded_chunks") } : {}),
      },
      suggestedFix: stepsWithAdvanced([
        `In \`server.properties\` set ${simOver ? `\`simulation-distance=${newSim}\`` : ""}${simOver && viewOver ? " and " : ""}${viewOver ? `\`view-distance=${newView}\`` : ""}.${viewOver ? " Players will see a bit less far, and" : " Players still see as far as before;"} mobs, crops and redstone further away just pause.`,
        "Restart the server (these settings are read at startup).",
        "Watch the next busy evening: loaded chunks and tick times should drop. If they do, mark this finding as fixed. If the server keeps up easily, you can raise view distance again by 1.",
      ], [
        "If you use per-world overrides, check `view-distance` / `simulation-distance` in `spigot.yml` (under `world-settings`) too: a number there overrides `server.properties`. Restart after changing it.",
      ]),
    },
  ];
}

export const viewDistanceTooHigh = defineRule({ id: "view-distance-too-high", scopes: ["incident"], evaluate });
