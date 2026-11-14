// Shared helpers for the rules. Pure functions only (no DB, clock or network).
import { DETECTOR, type FindingEvidence, type MetricName } from "@tickdoctor/shared";
import type { Rule, RuleContext, RuleFinding, RuleSample } from "./types.js";

export const KB = 1024;
export const MB = 1024 ** 2;
export const GB = 1024 ** 3;
export const MIN_MS = 60_000;
export const H_MS = 3_600_000;

// ---------- safety ----------

/**
 * Wraps a rule so it can never throw and never returns output that breaks the findings contract
 * (lengths from contracts/findings.ts). A rule that hits unexpected data returns [] instead.
 */
export function defineRule(rule: Rule): Rule {
  return {
    id: rule.id,
    scopes: rule.scopes,
    evaluate(ctx: RuleContext): RuleFinding[] {
      try {
        if (!ctx || typeof ctx !== "object") return [];
        const out = rule.evaluate(ctx);
        if (!Array.isArray(out)) return [];
        return out.map(clampFinding);
      } catch {
        return [];
      }
    },
  };
}

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

function clampFinding(f: RuleFinding): RuleFinding {
  return {
    ...f,
    dedupKey: cut(f.dedupKey, 200),
    title: cut(f.title, 200),
    explanation: cut(f.explanation, 2000),
    suggestedFix: cut(f.suggestedFix, 4000),
    evidence: {
      ...f.evidence,
      numbers: f.evidence.numbers.slice(0, 12).map((n) => ({
        ...n,
        label: cut(n.label, 200),
        value: typeof n.value === "string" ? cut(n.value, 100) : n.value,
        ...(n.unit !== undefined ? { unit: cut(n.unit, 20) } : {}),
        ...(typeof n.baseline === "string" ? { baseline: cut(n.baseline, 100) } : {}),
      })),
      ...(f.evidence.chunks ? { chunks: f.evidence.chunks.slice(0, 10) } : {}),
    },
  };
}

// ---------- numbers ----------

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function quantile(values: number[], q: number): number | null {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}
export const median = (values: number[]) => quantile(values, 0.5);
export function mean(values: number[]): number | null {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
export function maxOf(values: number[]): number | null {
  const v = values.filter(isNum);
  return v.length ? Math.max(...v) : null;
}
export const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
/** 4812 → "4,812" */
export const fmtInt = (v: number) => intFmt.format(Math.round(v));
/** 12.345 → "12.3" */
export const fmt1 = (v: number) => oneFmt.format(v);
/** bytes → "2.5 GB" / "340 MB" */
export function fmtBytes(b: number): string {
  if (b >= GB) return `${oneFmt.format(b / GB)} GB`;
  return `${intFmt.format(b / MB)} MB`;
}
/** bytes → GB number with 1 decimal (for evidence values) */
export const toGB = (b: number) => round(b / GB, 1);
export const toMB = (b: number) => Math.round(b / MB);

export const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
export const iso = (t: number) => new Date(t).toISOString();

// ---------- samples ----------

/** The metric value of a sample (raw value or the rollup's average). */
export const val = (s: RuleSample, m: MetricName): number | undefined => {
  const v = s.m?.[m];
  return isNum(v) ? v : undefined;
};
/** The worst value inside the sample (rollup max when present, else the value). */
export const peak = (s: RuleSample, m: MetricName): number | undefined => {
  const v = s.max?.[m];
  return isNum(v) ? v : val(s, m);
};
export function values(samples: RuleSample[], m: MetricName): number[] {
  const out: number[] = [];
  for (const s of samples) {
    const v = val(s, m);
    if (v !== undefined) out.push(v);
  }
  return out;
}
export const secondsOf = (s: RuleSample) => (isNum(s.seconds) && s.seconds > 0 ? s.seconds : 10);

/** Samples whose ts lies in [fromMs, toMs]. */
export function between(samples: RuleSample[], fromMs: number, toMs: number): RuleSample[] {
  return samples.filter((s) => {
    const t = ms(s.ts);
    return t >= fromMs && t <= toMs;
  });
}

/** Raw samples that carry detail, newest last. */
export const withDetail = (samples: RuleSample[]) =>
  samples.filter((s) => s.detail && typeof s.detail === "object");

/** The incident's own period, or the analysis window for server scope. */
export function focusPeriod(ctx: RuleContext): { from: number; to: number } {
  if (ctx.scope === "incident" && ctx.incident) {
    const from = ms(ctx.incident.startedAt);
    const to = ctx.incident.endedAt ? ms(ctx.incident.endedAt) : ms(ctx.window?.to ?? ctx.now);
    if (isNum(from) && isNum(to)) return { from, to: Math.max(from, to) };
  }
  return { from: ms(ctx.window?.from), to: ms(ctx.window?.to ?? ctx.now) };
}
export const focusSamples = (ctx: RuleContext) => {
  const p = focusPeriod(ctx);
  const s = Array.isArray(ctx.samples) ? ctx.samples : [];
  if (!isNum(p.from) || !isNum(p.to)) return s;
  const inside = between(s, p.from, p.to);
  return inside.length ? inside : s;
};

/**
 * Lag as the incident detector sees it: MSPT p95 ≥ 50 ms (DETECTOR.openMsptP95), i.e. the slowest 5 % of ticks
 * no longer fit in the 50 ms a tick may take at 20 TPS; or TPS below 18 (DETECTOR.openTps1m), which catches
 * "stalls": single multi-second ticks (chunk generation, forceloads) that p95 doesn't see.
 */
export const isLagSample = (s: RuleSample) =>
  (val(s, "mspt_p95") ?? 0) >= DETECTOR.openMsptP95 ||
  (val(s, "tps_1m") ?? 20) < DETECTOR.openTps1m;

/**
 * "Clearly lagging": players notice. p95 ≥ 60 ms (well past the 50 ms budget), average ≥ 45 ms (TPS about to
 * drop below 20), or TPS actually below 18. A p95 of 50–60 with a ~35 ms average still runs at 20 TPS with an
 * occasional stutter, so rules that give capacity advice use this stricter line.
 */
export const isClearLagSample = (s: RuleSample) =>
  (val(s, "mspt_p95") ?? 0) >= 60 ||
  (val(s, "mspt_avg") ?? 0) >= 45 ||
  (val(s, "tps_1m") ?? 20) < DETECTOR.openTps1m;

/** A single tick of ≥ 1 s in the sample: the server froze (players see everything stop, then jump). */
export const FREEZE_MS = 1000;

/** Seconds of the given samples that satisfy pred. */
export const secondsWhere = (samples: RuleSample[], pred: (s: RuleSample) => boolean) =>
  samples.reduce((a, s) => a + (pred(s) ? secondsOf(s) : 0), 0);

/**
 * Is the server lagging in the period we look at? Incident scope: yes by definition (the detector opened
 * an incident). Server scope: at least `minSeconds` of lag samples in the window.
 */
export function lagging(ctx: RuleContext, minSeconds = 300, pred = isLagSample): boolean {
  if (ctx.scope === "incident" && ctx.incident) return true;
  return secondsWhere(Array.isArray(ctx.samples) ? ctx.samples : [], pred) >= minSeconds;
}

/** Chart for the finding: the window, with the incident (or the given period) highlighted. */
export function chart(
  ctx: RuleContext,
  metric: MetricName,
  highlight?: { from: number; to: number },
): FindingEvidence["chart"] {
  const from = ctx.window?.from ?? ctx.now;
  const to = ctx.window?.to ?? ctx.now;
  if (!from || !to) return undefined;
  let hl = highlight;
  if (!hl && ctx.scope === "incident" && ctx.incident) {
    const p = focusPeriod(ctx);
    hl = p;
  }
  return {
    metric,
    from,
    to,
    ...(hl && isNum(hl.from) && isNum(hl.to)
      ? { highlight: { from: iso(hl.from), to: iso(hl.to) } }
      : {}),
  };
}

// ---------- host / hardware ----------

/** Latest host sample from raw detail, if any. */
export function latestHost(samples: RuleSample[]) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const h = samples[i]?.detail?.host;
    if (h && typeof h === "object") return h;
  }
  return undefined;
}

export function hostRamBytes(ctx: RuleContext): number | undefined {
  const h = latestHost(Array.isArray(ctx.samples) ? ctx.samples : []);
  if (isNum(h?.memTotalBytes) && h!.memTotalBytes! > 0) return h!.memTotalBytes;
  const i = ctx.info?.host?.totalMemoryBytes;
  return isNum(i) && i > 0 ? i : undefined;
}

export type HardwareClass = "sbc" | "small" | "large";
/**
 * Rough CPU class. "sbc" = Raspberry Pi-like board (ARM, ≤ 4 cores, ≤ 8 GB): roughly a third of the
 * single-core speed of a modern desktop/VPS core. "small" = ≤ 4 cores elsewhere. Everything else "large".
 */
export function hardwareClass(ctx: RuleContext): HardwareClass {
  const model = ctx.info?.host?.model ?? "";
  const arch = (ctx.info?.host?.arch ?? "").toLowerCase();
  const cores = ctx.info?.jvm?.availableProcessors ?? 0;
  const ram = hostRamBytes(ctx) ?? 0;
  if (/raspberry pi|orange pi|rock ?pi|odroid|jetson/i.test(model)) return "sbc";
  if (/^(aarch64|arm)/.test(arch) && cores > 0 && cores <= 4 && ram > 0 && ram <= 8.5 * GB)
    return "sbc";
  if (cores > 0 && cores <= 4) return "small";
  return "large";
}
export const hardwareLabel = (ctx: RuleContext) => {
  const model = ctx.info?.host?.model;
  if (model) return model.replace(/\s+Rev\s+[\d.]+$/i, "");
  const cores = ctx.info?.jvm?.availableProcessors;
  const ram = hostRamBytes(ctx);
  return (
    [cores ? `${cores} CPU cores` : null, ram ? `${fmtBytes(ram)} RAM` : null]
      .filter(Boolean)
      .join(", ") || "this machine"
  );
};

// ---------- entities ----------

/** "minecraft:item" → "item" */
export const normType = (t: string) => t.replace(/^minecraft:/, "").toLowerCase();
export const isOther = (t: string) => normType(t) === "other";

const NAMES: Record<string, string> = {
  item: "dropped items",
  experience_orb: "experience orbs",
  arrow: "arrows",
  spectral_arrow: "arrows",
  trident: "tridents",
  armor_stand: "armor stands",
  item_frame: "item frames",
  glow_item_frame: "glow item frames",
  falling_block: "falling blocks",
  tnt: "lit TNT",
  hopper: "hoppers",
  hopper_minecart: "hopper minecarts",
  chest_minecart: "chest minecarts",
  furnace: "furnaces",
  blast_furnace: "blast furnaces",
  smoker: "smokers",
  brewing_stand: "brewing stands",
  mob_spawner: "mob spawners",
  spawner: "mob spawners",
  sheep: "sheep",
  fish: "fish",
  cod: "cod",
  salmon: "salmon",
  axolotl: "axolotls",
};
/** Plain plural name for an entity / block entity id. */
export function friendlyType(t: string): string {
  const n = normType(t);
  if (Object.hasOwn(NAMES, n)) return NAMES[n]!;
  const words = plainName(n.replace(/_/g, " "));
  if (/(s|sh|ch|x)$/.test(words)) return words + "es";
  if (/[^aeiou]y$/.test(words)) return words.slice(0, -1) + "ies";
  return words + "s";
}

export type Chunk = { world: string; x: number; z: number };
export const chunkKey = (c: Chunk) => `${c.world}:${c.x}:${c.z}`;
/** Block coordinates of the chunk centre, for text like "/tp @s 1288 ~ -632". */
export const blockX = (cx: number) => cx * 16 + 8;

/**
 * Agent-supplied names (entity / block-entity types, world names) are used as object keys: `constructor`,
 * `toString` or `__proto__` must behave like any other name. Accumulators are prototype-less (dict), and lookups
 * into maps that came from JSON go through ownNum / Object.hasOwn.
 */
export function dict<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}
/** m[k] when it is an OWN numeric property, else 0. */
export function ownNum(m: Record<string, unknown> | null | undefined, k: string): number {
  if (!m || !Object.hasOwn(m, k)) return 0;
  const v = m[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sum count maps over worlds (keys normalised, "other" dropped). */
export function sumTypes(maps: (Record<string, number> | undefined)[]): Record<string, number> {
  const out = dict<number>();
  for (const m of maps) {
    if (!m || typeof m !== "object") continue;
    for (const [k, v] of Object.entries(m)) {
      if (!isNum(v) || isOther(k)) continue;
      const n = normType(k);
      out[n] = (out[n] ?? 0) + v;
    }
  }
  return out;
}

// ---------- JVM ----------

/** "-Xmx3G" → bytes. Accepts k/m/g/t suffixes (any case) or plain bytes. */
export function parseSize(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kKmMgGtT]?)$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = { "": 1, k: KB, m: MB, g: GB, t: 1024 * GB }[
    m[2]!.toLowerCase() as "" | "k" | "m" | "g" | "t"
  ];
  return n * mult;
}

export interface HeapFlags {
  xms?: number;
  xmx?: number;
  xmsFlag?: string;
  xmxFlag?: string;
  /** -XX:MaxRAMPercentage / InitialRAMPercentage style sizing. */
  ramPercentage: boolean;
}
export function heapFlags(flags: string[] | undefined): HeapFlags {
  const out: HeapFlags = { ramPercentage: false };
  for (const f of Array.isArray(flags) ? flags : []) {
    if (typeof f !== "string") continue;
    let m: RegExpExecArray | null;
    if ((m = /^-Xms(.+)$/.exec(f)) || (m = /^-XX:InitialHeapSize=(.+)$/.exec(f))) {
      const v = parseSize(m[1]!);
      if (v !== undefined) {
        out.xms = v;
        out.xmsFlag = f;
      }
    } else if ((m = /^-Xmx(.+)$/.exec(f)) || (m = /^-XX:MaxHeapSize=(.+)$/.exec(f))) {
      const v = parseSize(m[1]!);
      if (v !== undefined) {
        out.xmx = v;
        out.xmxFlag = f;
      }
    } else if (/^-XX:(Max|Initial|Min)RAMPercentage=/.test(f)) {
      out.ramPercentage = true;
    }
  }
  return out;
}
/** 3 GiB → "3G", 1.5 GiB → "1536M" (as you'd write it in a start script). */
export function sizeFlag(bytes: number): string {
  const g = bytes / GB;
  if (Math.abs(g - Math.round(g)) < 0.01) return `${Math.round(g)}G`;
  return `${Math.round(bytes / MB)}M`;
}

// ---------- text ----------

/** Numbered Markdown steps. */
export const steps = (lines: (string | null | undefined | false)[]) =>
  lines
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");

export function ago(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / MIN_MS));
  if (min < 90) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** World name in prose: "the world `world_nether`" (a bare "in world" reads like a typo). */
export const theWorld = (name: string) => `the world \`${plainName(name)}\``;

export const PLAIN_NAME_MAX = 64;
/**
 * Every agent-supplied string (plugin / world / entity names, versions, exception classes) placed in finding
 * text goes through this. Collapses whitespace and control characters to single spaces, trims, caps at
 * PLAIN_NAME_MAX chars with an ellipsis, and neutralises Markdown syntax by SUBSTITUTION, not backslash
 * escaping: the web renderer (apps/web/components/markdown.tsx) has no backslash escapes, so `\[x](url)` would
 * still render as a link there. `[` `]` → `(` `)` (no link syntax), backtick → `'` (no code spans / fences),
 * `*` → `∗` (no bold/italics), `<` `>` → `‹` `›` (no HTML / Discord mentions). `_` is kept: real plugin and
 * folder names use it and our renderer has no underscore emphasis (Discord alerts escape it themselves).
 */
export function plainName(s: unknown): string {
  const flat = String(s ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim()
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/`/g, "'")
    .replace(/\*/g, "\u2217")
    .replace(/</g, "\u2039")
    .replace(/>/g, "\u203a");
  const chars = [...flat];
  return chars.length > PLAIN_NAME_MAX ? `${chars.slice(0, PLAIN_NAME_MAX - 1).join("").trimEnd()}\u2026` : flat;
}
/** Evidence baseline: "none" instead of a bare 0, which reads oddly ("usually 0"). */
export const usualOf = (n: number): number | string => (Math.round(n) === 0 ? "none" : Math.round(n));

/**
 * Heading in front of fix steps that edit config files (.yml). The UI collapses everything below it, so keep
 * it exactly as is. The advanced steps are numbered from 1 again.
 */
export const ADVANCED_HEADING = "#### Optional, for when the simple steps aren't enough";
/** Numbered simple steps, then (if any) the config-file steps under ADVANCED_HEADING. */
export function stepsWithAdvanced(
  simple: (string | null | undefined | false)[],
  advanced: (string | null | undefined | false)[],
): string {
  const a = steps(advanced);
  return a ? `${steps(simple)}\n\n${ADVANCED_HEADING}\n\n${a}` : steps(simple);
}
