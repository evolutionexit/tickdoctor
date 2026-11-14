// Rule 6: CPU thermal throttling / under-voltage. Scopes "server" (it's a host state worth knowing about before
// it causes an incident) and "incident" (then it's a likely cause, severity high).
//
// Signals: `throttled` from `vcgencmd get_throttled` (Raspberry Pi, raw samples only) and cpu_temp_c (any host
// that reports it; also in 1-min rollups). Only *current* throttling counts; "since boot" alone is history.
import type { RuleContext, RuleFinding } from "./types.js";
import {
  chart,
  defineRule,
  fmt1,
  focusSamples,
  hardwareClass,
  isNum,
  lagging,
  median,
  quantile,
  round,
  secondsOf,
  steps,
  values,
  withDetail,
} from "./util.js";

/**
 * Temperature at which the CPU slows itself down. Raspberry Pi firmware starts throttling at 80 °C (soft
 * limit) and throttles hard at 85 °C. Desktop/server x86 CPUs run safely into the 90s and throttle near
 * 95–100 °C, so we use 95 there; lower would flag healthy machines under load.
 */
const LIMIT_SBC_C = 80;
const LIMIT_OTHER_C = 95;
/** Throttling must be active in ≥ 20 % of raw samples (and ≥ 3 of them): one blip is not a finding. */
const MIN_THROTTLED_SHARE = 0.2;
const MIN_THROTTLED_SAMPLES = 3;
/** Temperature-only trigger needs ≥ 5 min of readings with the median at/above the limit. */
const MIN_TEMP_SECONDS = 300;

/** vcgencmd get_throttled bits that mean "right now". */
function rawBits(raw: string | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /0x([0-9a-f]+)/i.exec(raw);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  return Number.isFinite(n) ? n : undefined;
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  const samples = focusSamples(ctx);
  if (samples.length === 0) return [];
  const sbc = hardwareClass(ctx) === "sbc" || /raspberry/i.test(ctx.info?.host?.model ?? "");
  const limit = sbc ? LIMIT_SBC_C : LIMIT_OTHER_C;

  // Throttle flags from raw detail.
  const withFlag = withDetail(samples).filter((s) => s.detail!.host?.throttled && typeof s.detail!.host.throttled.now === "boolean");
  const throttledNow = withFlag.filter((s) => s.detail!.host!.throttled!.now);
  const underVolt = withFlag.filter((s) => {
    const b = rawBits(s.detail!.host!.throttled!.raw);
    return b !== undefined && (b & 0x1) !== 0;
  });
  const share = withFlag.length ? throttledNow.length / withFlag.length : 0;
  const throttleActive = throttledNow.length >= MIN_THROTTLED_SAMPLES && share >= MIN_THROTTLED_SHARE;
  const underVoltActive = underVolt.length >= MIN_THROTTLED_SAMPLES && underVolt.length / withFlag.length >= MIN_THROTTLED_SHARE;

  // Temperatures.
  const temps = values(samples, "cpu_temp_c");
  const tempSeconds = samples.reduce((a, s) => a + (isNum(s.m?.cpu_temp_c) ? secondsOf(s) : 0), 0);
  const tempMed = median(temps);
  const tempPeak = quantile(temps, 0.95);
  const hot = tempMed !== null && tempSeconds >= MIN_TEMP_SECONDS && tempMed >= limit;
  // Throttling with a cool CPU and an under-voltage bit is a power problem, not heat.
  const thermal = hot || (throttleActive && !(underVoltActive && (tempMed ?? 0) < limit - 5));

  const lag = lagging(ctx);
  const usual = ctx.baseline?.metrics?.cpu_temp_c?.median ?? median(values(ctx.history ?? [], "cpu_temp_c"));
  const out: RuleFinding[] = [];
  const throttledPct = withFlag.length ? round(share * 100) : undefined;

  if (thermal) {
    const numbers = [
      ...(tempMed !== null
        ? [{ label: "CPU temperature", value: round(tempMed, 1), unit: "°C", ...(isNum(usual) ? { baseline: round(usual, 1) } : {}) }]
        : []),
      ...(tempPeak !== null ? [{ label: "Hottest readings", value: round(tempPeak, 1), unit: "°C" }] : []),
      { label: "Temperature where the CPU slows down", value: limit, unit: "°C" },
      ...(throttledPct !== undefined ? [{ label: "Time the CPU was slowed down", value: throttledPct, unit: "%" }] : []),
    ];
    const tempText = tempMed !== null ? `The CPU is at ${fmt1(tempMed)} °C${isNum(usual) ? ` (usually ${fmt1(usual)} °C)` : ""}` : "The CPU reports that it is overheating";
    out.push({
      ruleId: "thermal-throttling",
      dedupKey: "throttling",
      severity: lag ? "high" : "medium",
      title: "The CPU is overheating and slowing itself down",
      explanation:
        `${tempText} and is running at reduced speed to cool off (thermal throttling). ` +
        `A slower CPU needs longer for every tick, so the server ${lag ? "lags" : "can lag"} even though nothing in the game changed.`,
      evidence: { numbers, ...(chart(ctx, "cpu_temp_c") ? { chart: chart(ctx, "cpu_temp_c") } : {}) },
      suggestedFix: sbc
        ? steps([
            "Check the cooling: on a Raspberry Pi 5 use the official Active Cooler (or a case with a fan) and make sure the fan actually spins.",
            "Give it air: don't put it in a closed cupboard or a case without vents, and keep it out of direct sun and away from other warm devices.",
            "Check the result over SSH: `vcgencmd measure_temp` should stay well below 80 °C under load, and `vcgencmd get_throttled` should print `throttled=0x0` after a reboot.",
            "If you overclocked it, remove `arm_freq` / `over_voltage` lines from `/boot/firmware/config.txt` and reboot.",
            "Until it's fixed, lower `simulation-distance` in `server.properties` by 1–2 to reduce CPU load.",
          ])
        : steps([
            "Check the machine's cooling: clean dust out of fans and heatsinks, and make sure the fans run.",
            "Make sure the machine has free airflow and isn't next to a heat source.",
            "If it's a rented server or VPS, ask the host whether the machine is overheating.",
            "Until it's fixed, lower `simulation-distance` in `server.properties` by 1–2 to reduce CPU load.",
          ]),
    });
  }

  if (underVoltActive) {
    const pct = round((underVolt.length / withFlag.length) * 100);
    out.push({
      ruleId: "thermal-throttling",
      dedupKey: "under-voltage",
      severity: lag ? "high" : "medium",
      title: "The power supply is probably too weak, so the CPU slows down",
      explanation:
        "The board reports under-voltage: the power supply (or its cable) probably can't deliver enough current, so the CPU runs at reduced speed to stay stable. " +
        "Every tick then takes longer, and under-voltage can also corrupt the SD card or SSD.",
      evidence: {
        numbers: [
          { label: "Time with too little power", value: pct, unit: "%" },
          ...(tempMed !== null ? [{ label: "CPU temperature", value: round(tempMed, 1), unit: "°C" }] : []),
        ],
        ...(chart(ctx, "mspt_avg") ? { chart: chart(ctx, "mspt_avg") } : {}),
      },
      suggestedFix: steps([
        "Use the official power supply for your board (Raspberry Pi 5: the 27 W USB-C supply, 5.1 V / 5 A) with its own cable, not a phone charger.",
        "Don't power an SSD or other drives from the Pi's USB ports without enough power; use a powered USB hub if needed.",
        "Check over SSH after a reboot: `vcgencmd get_throttled` should print `throttled=0x0`.",
      ]),
    });
  }
  return out;
}

export const thermalThrottling = defineRule({ id: "thermal-throttling", scopes: ["server", "incident"], evaluate });

