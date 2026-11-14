// Rule 4: the server lags once more than ~N players are online. Scope "incident" (it explains why this
// incident happened: capacity), using the 7-day minute history to find the player count where it tips over.
//
// Guards against false positives:
// - "Lagging" here means clearly lagging (p95 ≥ 60 ms or average ≥ 45 ms, see util.isClearLagSample). Tick
//   times that rise gently with players but stay under that line are just a busy, healthy server.
// - The pattern must hold: at ≥ N players most minutes lag (≥ 60 %), below N almost none do (≤ 5 %), seen in at
//   least two separate sessions ≥ 12 h apart, so one bad evening (a farm, a heat wave) isn't called capacity.
// - If capacity dropped after a plugin/config change (the server handled N players fine before it), this is
//   the change's fault, not capacity: plugin-change-before-lag covers that, this rule stays quiet.
import type { RuleContext, RuleFinding, RuleSample } from "./types.js";
import { H_MS, chart, defineRule, focusSamples, isClearLagSample, isNum, median, ms, round, stepsWithAdvanced, val, values } from "./util.js";

const MIN_ABOVE_MINUTES = 30;
const MIN_BELOW_MINUTES = 60;
const ABOVE_LAG_SHARE = 0.6;
const BELOW_LAG_SHARE = 0.05;
const SESSION_GAP_MS = 12 * H_MS;
/** Per player count: ≥ 5 minutes of data, and "lags most of the time" = ≥ 50 % of its minutes. */
const MIN_BUCKET_MINUTES = 5;
const BUCKET_LAG_SHARE = 0.5;
/** Before a change the server handled ≥ N players with ≤ 20 % lagging minutes → capacity changed, not reached. */
const PRE_CHANGE_OK_SHARE = 0.2;

interface Pt { t: number; players: number; lag: boolean; p95?: number }

function points(samples: RuleSample[]): Pt[] {
  const out: Pt[] = [];
  for (const s of samples) {
    const p = val(s, "players");
    if (p === undefined || val(s, "mspt_p95") === undefined) continue;
    out.push({ t: ms(s.ts), players: Math.round(p), lag: isClearLagSample(s), p95: val(s, "mspt_p95") });
  }
  return out.filter((p) => isNum(p.t));
}

function sessions(ts: number[]): number {
  const s = [...ts].sort((a, b) => a - b);
  let n = s.length ? 1 : 0;
  for (let i = 1; i < s.length; i++) if (s[i]! - s[i - 1]! >= SESSION_GAP_MS) n++;
  return n;
}

/**
 * N = the lowest player count from which every count (with ≥ 5 minutes of data) lags in most of its minutes.
 * Looking per count avoids calling 8 "the limit" when 8–11 are fine and only 12+ lag.
 */
function threshold(pts: Pt[]): { n: number; aboveShare: number; belowShare: number; above: Pt[] } | null {
  const byCount = new Map<number, Pt[]>();
  for (const p of pts) (byCount.get(p.players) ?? byCount.set(p.players, []).get(p.players)!).push(p);
  const counts = [...byCount.keys()].filter((c) => byCount.get(c)!.length >= MIN_BUCKET_MINUTES).sort((a, b) => a - b);
  const share = (xs: Pt[]) => (xs.length ? xs.filter((p) => p.lag).length / xs.length : 0);
  for (const n of counts) {
    if (n < 1) continue;
    if (!counts.filter((c) => c >= n).every((c) => share(byCount.get(c)!) >= BUCKET_LAG_SHARE)) continue;
    const above = pts.filter((p) => p.players >= n);
    const below = pts.filter((p) => p.players < n);
    if (above.length < MIN_ABOVE_MINUTES || below.length < MIN_BELOW_MINUTES) return null;
    const aboveShare = share(above);
    const belowShare = share(below);
    if (aboveShare < ABOVE_LAG_SHARE || belowShare > BELOW_LAG_SHARE) return null;
    if (sessions(above.filter((p) => p.lag).map((p) => p.t)) < 2) return null;
    return { n, aboveShare, belowShare, above };
  }
  return null;
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope !== "incident" || !ctx.incident) return [];
  const hist = points(Array.isArray(ctx.history) ? ctx.history : []);
  if (hist.length < MIN_ABOVE_MINUTES + MIN_BELOW_MINUTES) return [];
  const th = threshold(hist);
  if (!th) return [];

  // This incident must have happened at/above N players.
  const playersNow = median(values(focusSamples(ctx), "players"));
  if (playersNow === null || playersNow < th.n) return [];

  // Capacity changed after a plugin/config change? Then it's not a capacity limit.
  const changeTimes = [
    ...(ctx.events ?? []).filter((e) => e?.type === "plugins_changed").map((e) => ms(e.ts)),
    ...(ctx.infoHistory ?? []).slice(1).map((h) => ms(h.validFrom)),
  ].filter((t) => isNum(t) && t > hist[0]!.t && t < hist[hist.length - 1]!.t);
  for (const t of changeTimes) {
    const pre = hist.filter((p) => p.t < t && p.players >= th.n);
    if (pre.length >= MIN_ABOVE_MINUTES && pre.filter((p) => p.lag).length / pre.length <= PRE_CHANGE_OK_SHARE) return [];
  }

  const above = th.above;
  const belowPts = hist.filter((p) => p.players < th.n && p.players >= Math.max(0, th.n - 3));
  const p95Above = median(above.map((p) => p.p95!).filter(isNum));
  const p95Below = median(belowPts.map((p) => p.p95!).filter(isNum));
  const maxPlayers = ctx.info?.server?.maxPlayers;
  const severity = (p95Above ?? 0) >= 100 ? "high" : "medium";
  const safe = Math.max(1, th.n - 1);
  const sim = ctx.info?.config?.simulationDistance;

  return [
    {
      ruleId: "player-count-threshold",
      dedupKey: "capacity",
      severity,
      title: `The server starts lagging above about ${safe} players`,
      explanation:
        `Over the last week the server kept up well with up to ${safe} players. With ${th.n} or more, it lagged in ${round(th.aboveShare * 100)} % of the minutes. ` +
        "Every extra player means more chunks, mobs and redstone to update, and around this number your machine probably can't finish all of it in time.",
      evidence: {
        numbers: [
          { label: "Player count where lag starts", value: th.n },
          { label: `Minutes lagging with ${th.n}+ players`, value: round(th.aboveShare * 100), unit: "%", baseline: round(th.belowShare * 100) },
          ...(isNum(p95Above) ? [{ label: `Slowest ticks with ${th.n}+ players (the worst 5 %)`, value: round(p95Above, 1), unit: "ms", ...(isNum(p95Below) ? { baseline: round(p95Below, 1) } : {}) }] : []),
          { label: "Players during this incident", value: round(playersNow) },
          ...(isNum(maxPlayers) ? [{ label: "Your max-players setting", value: maxPlayers }] : []),
        ],
        ...(chart(ctx, "players") ? { chart: chart(ctx, "players") } : {}),
      },
      suggestedFix: stepsWithAdvanced([
        "Check the other findings for this incident first: they may show which part of the load grows with players (an entity farm, chunk generation).",
        isNum(sim) && sim > 4
          ? `Lower \`simulation-distance\` in \`server.properties\` (now ${sim}, for example to ${Math.max(4, sim - 2)}): this cuts the work per player the most, and players still see as far as before.`
          : "Lower `view-distance` in `server.properties` by 1–2.",
        `If it still lags at that size, set \`max-players=${safe}\` in \`server.properties\`. It caps how many people can join, so it's a stop-gap until you move to faster hardware.`,
      ], [
        "In `paper-world-defaults.yml`, keep `entities.spawning.per-player-mob-spawns: true` and consider setting `entities.spawning.spawn-limits.monster` to a lower value, for example `50` (the default `-1` uses the limit from `bukkit.yml`, normally 70), so mob numbers don't grow so fast with players.",
        "In `spigot.yml`, lower `entity-activation-range` (default 32; for example animals 16, monsters 24) so mobs far from players are updated less often.",
        "Restart the server after changing these files.",
      ]),
    },
  ];
}

export const playerCountThreshold = defineRule({ id: "player-count-threshold", scopes: ["incident"], evaluate });
