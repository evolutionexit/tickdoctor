// Rule 7: the machine is short on memory and swapping. Scopes "server" (memory pressure hurts before an incident
// opens) and "incident" (then severity high: swapped-out server memory makes ticks and garbage collection slow).
//
// "Swap used" alone is not a problem: Linux moves memory nobody touches to swap and leaves it there, and a Pi's
// zram swap often holds a few MB. We fire only when swap use is meaningful AND the machine is actually under
// memory pressure right now (little memory available) or swap keeps growing during the window.
import type { RuleContext, RuleFinding } from "./types.js";
import { xmxTooLargeForRam, ramReserve } from "./jvm-flags.js";
import {
  GB,
  MB,
  chart,
  defineRule,
  fmtBytes,
  focusSamples,
  hostRamBytes,
  isNum,
  lagging,
  latestHost,
  median,
  sizeFlag,
  steps,
  toMB,
  val,
  values,
} from "./util.js";

/** 256 MB: below that, swap holds idle leftovers and costs nothing noticeable. */
const MIN_SWAP_BYTES = 256 * MB;
/** …and at least 5 % of the swap space, so a huge swap file with a little in it doesn't count. */
const MIN_SWAP_SHARE = 0.05;
/** Memory pressure: less than 10 % of RAM (at least 512 MB) available. Linux then reclaims and swaps actively. */
const PRESSURE_SHARE = 0.1;
const PRESSURE_MIN_BYTES = 512 * MB;
/** Growth: swap median of the last third of the window ≥ first third + 256 MB (needs ≥ 10 min of data). */
const GROWTH_BYTES = 256 * MB;
const GROWTH_MIN_MS = 10 * 60_000;

function evaluate(ctx: RuleContext): RuleFinding[] {
  const samples = focusSamples(ctx).filter((s) => isNum(val(s, "swap_used_bytes")));
  if (samples.length < 3) return [];
  const swap = values(samples, "swap_used_bytes");
  const swapMed = median(swap)!;
  const host = latestHost(ctx.samples ?? []);
  const swapTotal = isNum(host?.swapTotalBytes) && host!.swapTotalBytes! > 0 ? host!.swapTotalBytes : undefined;
  if (swapMed < MIN_SWAP_BYTES) return [];
  if (swapTotal !== undefined && swapMed < MIN_SWAP_SHARE * swapTotal) return [];

  const ram = hostRamBytes(ctx);
  const avail = median(values(samples, "mem_available_bytes"));
  const pressureLine = ram ? Math.max(PRESSURE_MIN_BYTES, PRESSURE_SHARE * ram) : PRESSURE_MIN_BYTES;
  const pressure = avail !== null && avail < pressureLine;

  const t0 = Date.parse(samples[0]!.ts);
  const t1 = Date.parse(samples[samples.length - 1]!.ts);
  let growth = 0;
  if (t1 - t0 >= GROWTH_MIN_MS) {
    const third = Math.max(1, Math.floor(samples.length / 3));
    const first = median(swap.slice(0, third))!;
    const last = median(swap.slice(-third))!;
    growth = last - first;
  }
  const growing = growth >= GROWTH_BYTES;
  if (!pressure && !growing) return [];

  const lag = lagging(ctx);
  const usualSwap = ctx.baseline?.metrics?.swap_used_bytes?.median;
  const heapMax = ctx.info?.jvm?.heapMaxBytes ?? val(samples[samples.length - 1]!, "heap_max_bytes");
  const fitting = ram ? Math.max(GB, Math.floor((ram - ramReserve(ram)) / GB) * GB) : undefined;
  const heapTooBig = isNum(heapMax) && ram !== undefined && xmxTooLargeForRam(heapMax, ram);

  const numbers = [
    { label: "Swap in use", value: toMB(swapMed), unit: "MB", ...(isNum(usualSwap) ? { baseline: toMB(usualSwap) } : {}) },
    ...(swapTotal ? [{ label: "Swap size", value: toMB(swapTotal), unit: "MB" }] : []),
    ...(avail !== null ? [{ label: "Memory still available", value: toMB(avail), unit: "MB" }] : []),
    ...(ram ? [{ label: "Machine memory (RAM)", value: toMB(ram), unit: "MB" }] : []),
    ...(growing ? [{ label: "Swap growth in this period", value: toMB(growth), unit: "MB" }] : []),
    ...(isNum(heapMax) ? [{ label: "Java memory limit (-Xmx)", value: toMB(heapMax), unit: "MB" }] : []),
  ];
  const why = pressure
    ? `only ${fmtBytes(avail!)}${ram ? ` of ${fmtBytes(ram)}` : ""} of memory is still available`
    : `swap use grew by ${fmtBytes(growth)} during this period`;
  return [
    {
      ruleId: "swap-in-use",
      dedupKey: "memory-pressure",
      severity: lag ? "high" : "medium",
      title: "The machine is low on memory and moving some of it to swap",
      explanation:
        `${fmtBytes(swapMed)} of memory has been moved to swap and ${why}. ` +
        "Swap is overflow space for when RAM is full, usually on the disk or SD card (on Raspberry Pi OS often compressed memory instead). " +
        `It is far slower than RAM, so whenever the server needs something that was moved there it has to wait, which ${lag ? "shows" : "can show"} up as lag spikes.`,
      evidence: { numbers, ...(chart(ctx, "swap_used_bytes") ? { chart: chart(ctx, "swap_used_bytes") } : {}) },
      suggestedFix: steps([
        "See what uses the memory: run `free -h` and `top` (press `Shift+M` to sort by memory) on the machine.",
        heapTooBig && fitting
          ? `Java's memory limit is too large for this machine: in your start script set \`-Xms${sizeFlag(fitting)} -Xmx${sizeFlag(fitting)}\` and restart.`
          : "If Java is the biggest user, don't raise `-Xmx` further: that limit plus about 1 GB for Java itself must fit in RAM next to everything else.",
        "Stop other programs on the machine that you don't need (other servers, databases, a desktop session).",
        "Check what kind of swap it is with `swapon --show`.",
        "If it lists `/dev/zram0`: that is compressed memory, normal on Raspberry Pi OS. Leave `vm.swappiness` alone (a high value is normal there) and use the steps above.",
        "If it lists a swap file or a partition on a disk or SD card: `sudo sysctl vm.swappiness=10` makes Linux prefer RAM. Add `vm.swappiness=10` to `/etc/sysctl.conf` to keep it after a reboot.",
        "If it keeps swapping after that, the machine needs more RAM.",
      ]),
    },
  ];
}

export const swapInUse = defineRule({ id: "swap-in-use", scopes: ["server", "incident"], evaluate });
