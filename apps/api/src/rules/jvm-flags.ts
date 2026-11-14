// Rule 11: JVM start flags. Scope "server": this is configuration, visible in every hello, independent of lag.
// Each issue has its own dedupKey, so fixing one (e.g. -Xms4G -Xmx4G) makes exactly that finding stop firing
// and lets the recheck job mark it confirmed_fixed while the others stay open.
//
// Keys: "xms-ne-xmx", "xmx-missing", "xmx-too-small", "xmx-too-large-for-ram", "aikar-flags-missing", "slow-gc-collector".
import type { RuleContext, RuleFinding } from "./types.js";
import { GB, MB, chart, defineRule, fmtBytes, heapFlags, hostRamBytes, isNum, sizeFlag, steps, toGB } from "./util.js";

/**
 * Memory the machine needs besides the Java heap: the JVM's own non-heap memory (metaspace, thread stacks,
 * GC bookkeeping, network buffers: typically 0.5–1 GB for a Paper server) plus the OS. 12 % of RAM, at least
 * 1.25 GB, at most 3 GB. On an 8 GB machine that allows -Xmx up to ~6.7 GB.
 */
export function ramReserve(ram: number): number {
  return Math.min(3 * GB, Math.max(1.25 * GB, 0.12 * ram));
}

/** True when -Xmx doesn't leave room for the rest (used by gc-pressure too, so the two rules don't overlap). */
export function xmxTooLargeForRam(heapMax: number, ram: number): boolean {
  return heapMax > ram - ramReserve(ram);
}

/**
 * "Very small heap": -Xmx under 1 GB on a machine with ≥ 4 GB RAM. Paper itself plus a few chunks and plugins
 * fill ~1 GB quickly; owners of genuinely small machines (1–2 GB VPS) never see this.
 */
const SMALL_HEAP = GB;
const SMALL_HEAP_MIN_RAM = 4 * GB;

/** Flags from Aikar's set (https://docs.papermc.io/paper/aikars-flags) that tune G1. */
const GC_TUNING = [
  /^-XX:\+UseG1GC$/,
  /^-XX:\+ParallelRefProcEnabled$/,
  /^-XX:MaxGCPauseMillis=/,
  /^-XX:\+DisableExplicitGC$/,
  /^-XX:\+AlwaysPreTouch$/,
  /^-XX:G1NewSizePercent=/,
  /^-XX:G1MaxNewSizePercent=/,
  /^-XX:G1HeapRegionSize=/,
  /^-XX:G1ReservePercent=/,
  /^-XX:G1HeapWastePercent=/,
  /^-XX:G1MixedGCCountTarget=/,
  /^-XX:InitiatingHeapOccupancyPercent=/,
  /^-XX:G1MixedGCLiveThresholdPercent=/,
  /^-XX:G1RSetUpdatingPauseTimePercent=/,
  /^-XX:SurvivorRatio=/,
  /^-XX:MaxTenuringThreshold=/,
];
/** Low-pause collectors chosen on purpose: no G1 advice then. */
const OTHER_GOOD_GC = /^-XX:\+(UseZGC|UseShenandoahGC)$/;
/** Collectors that stop the whole server for long pauses on a game server's heap. */
const SLOW_GC = /^-XX:\+(UseSerialGC|UseParallelGC)$/;

const AIKAR_URL = "https://docs.papermc.io/paper/aikars-flags";

const WHERE =
  "your start script (for example `start.sh`), the `ExecStart=` line of your systemd service (for example `/etc/systemd/system/minecraft.service`), or the memory / JVM arguments field of your hosting panel";

function evaluate(ctx: RuleContext): RuleFinding[] {
  const info = ctx.info;
  const jvm = info?.jvm;
  if (!jvm) return [];
  const flags = Array.isArray(jvm.flags) ? jvm.flags.filter((f): f is string => typeof f === "string") : [];
  const hf = heapFlags(flags);
  const heapMax = hf.xmx ?? (isNum(jvm.heapMaxBytes) && jvm.heapMaxBytes > 0 ? jvm.heapMaxBytes : undefined);
  const heapInit = hf.xms ?? (isNum(jvm.heapInitBytes) && jvm.heapInitBytes > 0 ? jvm.heapInitBytes : undefined);
  const ram = hostRamBytes(ctx);
  const ch = chart(ctx, "heap_used_bytes");
  const out: RuleFinding[] = [];
  const ramNumber = ram ? [{ label: "Machine memory (RAM)", value: toGB(ram), unit: "GB" }] : [];

  // --- Xmx larger than the machine can give (checked first: its fix also decides the right -Xms) ---
  const tooLarge = heapMax !== undefined && ram !== undefined && xmxTooLargeForRam(heapMax, ram);
  // Suggested heap: what fits, rounded down to whole GB, at least 1 GB.
  const fitting = ram ? Math.max(GB, Math.floor((ram - ramReserve(ram)) / GB) * GB) : undefined;
  if (tooLarge && heapMax !== undefined && ram !== undefined && fitting !== undefined) {
    const over = heapMax >= ram;
    out.push({
      ruleId: "jvm-flags",
      dedupKey: "xmx-too-large-for-ram",
      severity: over ? "high" : "medium",
      title: over ? "Java may use more memory than the machine has" : "Java's memory limit leaves too little for the rest of the machine",
      explanation:
        `The server is allowed to use up to ${fmtBytes(heapMax)} of memory (Java's "heap"), on a machine with ${fmtBytes(ram)} of RAM. ` +
        `Java needs some memory on top of that, and so does the operating system. When the machine runs out, it moves memory to swap (overflow space that is much slower than RAM), which slows every tick, or, without swap, Linux may shut the server down.`,
      evidence: {
        numbers: [
          { label: "Memory limit (-Xmx)", value: toGB(heapMax), unit: "GB" },
          ...ramNumber,
          { label: "Suggested memory limit", value: toGB(fitting), unit: "GB" },
        ],
        ...(ch ? { chart: { ...ch, metric: "mem_available_bytes" } } : {}),
      },
      suggestedFix: steps([
        `Open ${WHERE}.`,
        `Change ${hf.xmxFlag ? `\`${hf.xmxFlag}\`` : "the memory limit (`-Xmx`)"} to \`-Xmx${sizeFlag(fitting)}\` and set \`-Xms${sizeFlag(fitting)}\` to the same value.`,
        "Restart the server.",
        "If the server really needs more memory than that (many players, large render distance), the machine needs more RAM.",
      ]),
    });
  }

  // --- No -Xmx at all: Java picks a quarter of the RAM by default ---
  if (hf.xmx === undefined && !hf.ramPercentage && heapMax !== undefined) {
    const target = fitting !== undefined ? Math.min(fitting, Math.max(heapMax, 2 * GB)) : heapMax;
    out.push({
      ruleId: "jvm-flags",
      dedupKey: "xmx-missing",
      severity: "low",
      title: "The server's memory limit isn't set, so Java picks one",
      explanation:
        `Your start command doesn't say how much memory the server may use (the \`-Xmx\` setting), so Java chose ${fmtBytes(heapMax)} on its own${ram ? `, out of ${fmtBytes(ram)} RAM,` : ""} and grows into it step by step. ` +
        `Setting it yourself keeps memory use predictable and avoids a few extra pauses while it grows.`,
      evidence: {
        numbers: [{ label: "Memory limit Java picked", value: toGB(heapMax), unit: "GB" }, ...ramNumber],
        ...(ch ? { chart: ch } : {}),
      },
      suggestedFix: steps([
        `Open ${WHERE}.`,
        `Add \`-Xms${sizeFlag(target)} -Xmx${sizeFlag(target)}\` right after \`java\`.`,
        "Restart the server.",
      ]),
    });
  } else if (heapMax !== undefined && ram !== undefined && heapMax < SMALL_HEAP && ram >= SMALL_HEAP_MIN_RAM) {
    // --- Very small heap on a machine with plenty of RAM (replaces xms-ne-xmx: the fix sets both) ---
    // Same "comfortable" size as the xms-ne-xmx hint (~60 % of RAM), capped at 4 GB, at least 2 GB.
    const target = Math.min(4 * GB, Math.max(2 * GB, Math.floor((0.6 * ram) / GB) * GB), fitting ?? 4 * GB);
    out.push({
      ruleId: "jvm-flags",
      dedupKey: "xmx-too-small",
      severity: "low",
      title: "The server gets very little memory on a machine that has plenty",
      explanation:
        `Java may use at most ${fmtBytes(heapMax)} for the server, while the machine has ${fmtBytes(ram)} of RAM. ` +
        "A Paper server with a few players usually needs about 2–4 GB; with less, Java has to clean up memory constantly and the server can stall under load.",
      evidence: {
        numbers: [
          { label: "Memory limit (-Xmx)", value: Math.round(heapMax / MB), unit: "MB" },
          ...(heapInit !== undefined ? [{ label: "Starting memory (-Xms)", value: Math.round(heapInit / MB), unit: "MB" }] : []),
          ...ramNumber,
          { label: "Suggested memory limit", value: toGB(target), unit: "GB" },
        ],
        ...(ch ? { chart: ch } : {}),
      },
      suggestedFix: steps([
        `Open ${WHERE}.`,
        `Change ${hf.xmxFlag ? `\`${hf.xmxFlag}\`` : "the memory limit (`-Xmx`)"}${hf.xmsFlag ? ` and \`${hf.xmsFlag}\`` : ""} to \`-Xms${sizeFlag(target)} -Xmx${sizeFlag(target)}\`.`,
        "Restart the server.",
      ]),
    });
  } else if (heapMax !== undefined && heapInit !== undefined && !tooLarge) {
    // --- Xms ≠ Xmx (2 % tolerance for rounding in what the JVM reports) ---
    if (Math.abs(heapMax - heapInit) > Math.max(16 * MB, 0.02 * heapMax)) {
      const target = heapMax;
      // A comfortable size for the optional hint: ~60 % of RAM (never above what fits), whole GB.
      const comfy = ram && fitting !== undefined ? Math.min(fitting, Math.floor((0.6 * ram) / GB) * GB) : undefined;
      out.push({
        ruleId: "jvm-flags",
        dedupKey: "xms-ne-xmx",
        // Lead decision (review M6): a tuning tip, not a lag cause.
        severity: "info",
        title: "Tuning tip: starting memory and maximum memory are different",
        explanation:
          `The server starts with ${fmtBytes(heapInit)} of memory (\`-Xms\`) and may grow to ${fmtBytes(heapMax)} (\`-Xmx\`). ` +
          `This isn't why your server lags. Paper recommends setting both to the same value: Java then doesn't have to grow and shrink its memory, which avoids a few small pauses, and the memory is reserved up front.`,
        evidence: {
          numbers: [
            { label: "Starting memory (-Xms)", value: toGB(heapInit), unit: "GB" },
            { label: "Memory limit (-Xmx)", value: toGB(heapMax), unit: "GB" },
            ...ramNumber,
          ],
          ...(ch ? { chart: ch } : {}),
        },
        suggestedFix: steps([
          `Open ${WHERE}.`,
          `Change ${hf.xmsFlag ? `\`${hf.xmsFlag}\`` : "the starting memory (`-Xms`)"} to \`-Xms${sizeFlag(target)}\` so it matches \`-Xmx${sizeFlag(target)}\`${hf.xmsFlag ? "" : " (add it if it's missing)"}.`,
          comfy !== undefined && comfy > target
            ? `Optional: if the server needs more memory, this machine has comfortable room for \`-Xms${sizeFlag(comfy)} -Xmx${sizeFlag(comfy)}\`.`
            : null,
          "Restart the server: the new values only take effect after a restart. This finding clears by itself once the restarted server reports them.",
        ]),
      });
    }
  }

  // --- Garbage collector choice / tuning ---
  const slow = flags.find((f) => SLOW_GC.test(f));
  if (slow) {
    out.push({
      ruleId: "jvm-flags",
      dedupKey: "slow-gc-collector",
      severity: "low",
      title: "The server is set to a memory clean-up mode that freezes it for long stretches",
      explanation:
        `The flag \`${slow}\` makes Java freeze the whole server every time it cleans up memory. ` +
        `Paper recommends Java's G1 clean-up mode with "Aikar's flags", a set of Java options the Paper community tested to keep those freezes short.`,
      evidence: { numbers: [{ label: "Clean-up mode flag", value: slow }], ...(ch ? { chart: { ...ch, metric: "gc_pause_ms" } } : {}) },
      suggestedFix: steps([
        `Open ${WHERE}.`,
        `Remove \`${slow}\` and add Aikar's flags from ${AIKAR_URL} (the page generates the full line for your memory size).`,
        "Restart the server.",
      ]),
    });
  } else {
    const tuned = flags.filter((f) => GC_TUNING.some((r) => r.test(f))).length;
    const aikarMarker = flags.some((f) => /^-Dusing\.aikars\.flags=/.test(f));
    const otherGc = flags.some((f) => OTHER_GOOD_GC.test(f));
    // Only when there is no GC tuning at all: an owner who already picked some flags made a choice we don't second-guess.
    if (tuned === 0 && !aikarMarker && !otherGc) {
      const size = heapMax ? sizeFlag(tooLarge && fitting ? fitting : heapMax) : null;
      out.push({
        ruleId: "jvm-flags",
        dedupKey: "aikar-flags-missing",
        // Lead decision (review M6): a tuning tip, not a lag cause.
        severity: "info",
        title: "Tuning tip: your server doesn't use the Java settings Paper recommends",
        explanation:
          "The server uses Java's default memory clean-up settings, which are meant for general-purpose programs rather than games. " +
          "This isn't why your server lags. Paper recommends \"Aikar's flags\", a set of options that keeps the clean-up freezes shorter and less frequent, which avoids small spikes.",
        evidence: {
          numbers: [{ label: "Clean-up tuning options in use (the recommended set has 17)", value: 0 }],
          ...(ch ? { chart: { ...ch, metric: "gc_pause_ms" } } : {}),
        },
        suggestedFix: steps([
          `Go to ${AIKAR_URL}${size ? ` and enter your memory size (${size})` : ""}; it generates the complete start command.`,
          `Copy the generated flags into ${WHERE}, keeping your own \`-jar\` line.`,
          "Restart the server.",
        ]),
      });
    }
  }
  return out;
}

export const jvmFlags = defineRule({ id: "jvm-flags", scopes: ["server"], evaluate });
