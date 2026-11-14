// Rule 5: garbage-collection pressure because the heap is too small. Scopes "server" (it hurts continuously,
// often as stutter before a full incident) and "incident" (then it's a likely cause).
//
// "Heap too large for the host's RAM" is a static config problem visible in every hello; it is reported by
// jvm-flags (dedupKey "xmx-too-large-for-ram") so the owner gets one finding for it, not two.
//
// Signals: heap use *after* clean-ups (a low percentile of heap_used / heap_max: the sawtooth's floor) and the
// share of wall time spent in GC pauses.
import type { RuleContext, RuleFinding, RuleSample } from "./types.js";
import { ramReserve } from "./jvm-flags.js";
import {
  GB,
  chart,
  defineRule,
  fmt1,
  fmtBytes,
  hostRamBytes,
  isNum,
  lagging,
  maxOf,
  quantile,
  round,
  secondsOf,
  sizeFlag,
  steps,
  toMB,
  val,
  values,
  withDetail,
} from "./util.js";

/**
 * Floor ≥ 75 %: even right after clean-ups three quarters of the heap stays full, so the collector has
 * little room and runs constantly. Healthy G1 servers sit at 30–60 % after clean-ups. The floor is the 20th
 * percentile of heap use over the window (samples land at random points of the fill/clean-up sawtooth;
 * p20 is robust against a few samples taken right after a big clean-up).
 */
const FLOOR_LIMIT = 0.75;
const FLOOR_QUANTILE = 0.2;
/**
 * GC pause share ≥ 2 %: on a healthy Paper server G1 pauses take well under 1 % of the time (a few ms every
 * few seconds). 2 % means ≥ 200 ms of frozen server every 10 s, which players feel as stutter.
 */
const SHARE_LIMIT = 0.02;
const SHARE_HIGH = 0.05;
/** Need at least 10 minutes of samples so one big clean-up doesn't decide. */
const MIN_SECONDS = 600;
/** Rollup values are averages of the agent's per-sample totals; the default sample is 10 s. */
const ROLLUP_SAMPLE_SECONDS = 10;

/** Fraction of wall time spent in GC pauses for one sample. */
function gcShare(s: RuleSample): number | undefined {
  const gc = val(s, "gc_pause_ms");
  if (gc === undefined) return undefined;
  const isRollup = !s.detail && secondsOf(s) >= 60;
  return gc / ((isRollup ? ROLLUP_SAMPLE_SECONDS : secondsOf(s)) * 1000);
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  // The whole window (incident: from 10 min before it started), not only the incident: short incidents
  // would otherwise never have the 10 minutes of data this needs.
  const samples = (Array.isArray(ctx.samples) ? ctx.samples : []).filter((s) => isNum(val(s, "heap_used_bytes")) && (val(s, "heap_max_bytes") ?? 0) > 0);
  const secs = samples.reduce((a, s) => a + secondsOf(s), 0);
  if (secs < MIN_SECONDS || samples.length < 5) return [];

  const ratios = samples.map((s) => val(s, "heap_used_bytes")! / val(s, "heap_max_bytes")!);
  const floor = quantile(ratios, FLOOR_QUANTILE)!;
  let gcMs = 0;
  let gcSecs = 0;
  for (const s of samples) {
    const sh = gcShare(s);
    if (sh === undefined) continue;
    gcMs += sh * secondsOf(s);
    gcSecs += secondsOf(s);
  }
  if (gcSecs < MIN_SECONDS) return [];
  const share = gcMs / gcSecs;
  if (floor < FLOOR_LIMIT || share < SHARE_LIMIT) return [];

  const heapMax = val(samples[samples.length - 1]!, "heap_max_bytes")!;
  const ram = hostRamBytes(ctx);
  const longest = maxOf(withDetail(samples).flatMap((s) => (s.detail!.gcPauses ?? []).map((g) => g.maxMs)));
  const fullGcs = withDetail(samples).reduce(
    (a, s) => a + (s.detail!.gcPauses ?? []).filter((g) => /old|full|mark ?sweep/i.test(g.collector)).reduce((b, g) => b + (g.count ?? 0), 0),
    0,
  );
  const swapMed = quantile(values(samples, "swap_used_bytes"), 0.5);

  // Usual values from the baseline (healthy minutes).
  const b = ctx.baseline?.metrics;
  const usualRatio = b?.heap_used_bytes && b?.heap_max_bytes?.median ? b.heap_used_bytes.median / b.heap_max_bytes.median : undefined;
  const usualShare = b?.gc_pause_ms ? b.gc_pause_ms.median / (ROLLUP_SAMPLE_SECONDS * 1000) : undefined;

  // Suggested heap: +50 % (at least +2 GB), but only what the machine can give.
  const fitting = ram ? Math.floor((ram - ramReserve(ram)) / GB) * GB : undefined;
  const wanted = Math.ceil(Math.max(heapMax * 1.5, heapMax + 2 * GB) / GB) * GB;
  const suggested = fitting !== undefined ? Math.min(wanted, fitting) : wanted;
  const canGrow = suggested >= heapMax + GB;

  const numbers = [
    { label: "Memory still in use after a clean-up", value: round(floor * 100), unit: "%", ...(isNum(usualRatio) ? { baseline: round(usualRatio * 100) } : {}) },
    { label: "Time the server is frozen for clean-ups", value: round(share * 100, 1), unit: "%", ...(isNum(usualShare) ? { baseline: round(usualShare * 100, 1) } : {}) },
    { label: "Heap limit (-Xmx)", value: toMB(heapMax), unit: "MB" },
    ...(ram ? [{ label: "Machine memory (RAM)", value: toMB(ram), unit: "MB" }] : []),
    ...(isNum(longest) && longest > 0 ? [{ label: "Longest single pause", value: round(longest), unit: "ms" }] : []),
    ...(fullGcs > 0 ? [{ label: "Full clean-ups (these stop everything)", value: fullGcs }] : []),
    ...(isNum(swapMed) && swapMed > 0 ? [{ label: "Swap in use", value: toMB(swapMed), unit: "MB" }] : []),
  ];

  return [
    {
      ruleId: "gc-pressure",
      dedupKey: "heap-too-small",
      severity: share >= SHARE_HIGH || lagging(ctx) ? "high" : "medium",
      title: "The server is running low on memory (Java's memory limit is too small)",
      explanation:
        `Even right after Java cleans up memory, ${round(floor * 100)} % of the ${fmtBytes(heapMax)} it's allowed to use (its "heap") is still taken, so it has to clean up again and again. ` +
        `Each clean-up briefly freezes the server. Right now that adds up to ${fmt1(share * 100)} % of the time, and players can feel it as lag spikes.`,
      evidence: { numbers, ...(chart(ctx, "heap_used_bytes") ? { chart: chart(ctx, "heap_used_bytes") } : {}) },
      suggestedFix: canGrow
        ? steps([
            "Open your start script (for example `start.sh`), the `ExecStart=` line of your systemd service, or your hosting panel's memory setting.",
            `Raise the memory limit from \`-Xmx${sizeFlag(heapMax)}\` to \`-Xmx${sizeFlag(suggested)}\`, and set \`-Xms${sizeFlag(suggested)}\` to the same value.`,
            "Restart the server and check back after an hour or two of normal play. If this finding is gone, mark it as fixed.",
            "If memory fills up again after a while, something probably keeps growing (a plugin cache, many loaded chunks): restart once a day and check plugins that store a lot of data.",
          ])
        : steps([
            `This machine has no room for a bigger memory limit${ram ? ` (${fmtBytes(ram)} RAM, Java may already use ${fmtBytes(heapMax)})` : ""}.`,
            "Reduce what the server keeps in memory: lower `view-distance` in `server.properties` (for example by 2), and remove plugins you don't need.",
            "Restart the server once a day so memory starts clean.",
            "If it is still full after that, the server needs a machine (or plan) with more RAM.",
          ]),
    },
  ];
}

export const gcPressure = defineRule({ id: "gc-pressure", scopes: ["server", "incident"], evaluate });
