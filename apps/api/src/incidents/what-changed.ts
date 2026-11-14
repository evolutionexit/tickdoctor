import type { z } from "zod";
import { friendlyType, ownNum } from "../rules/util.js";
import type { Baseline, MetricName, whatChanged as whatChangedSchema, whatChangedItem } from "@tickdoctor/shared";

// "What changed?" (contract app-phase6.ts whatChanged). PURE: no DB, no clock. The loader (incidents/detail.ts)
// collects the inputs; this file decides the items, the "notable" flag and the order.
//
// - metric: median over the incident window per metric (TPS: the minimum — lower is worse), vs the baseline median.
//   Bytes are shown in MB, CPU shares in %.
// - entityType / tileEntityType: snapshot (or raw-sample medians) vs baseline medians; only types with during ≥ 50
//   or usual ≥ 50.
// - world: per world loaded chunks / entities.
// - plugin: added / removed / updated (baseline end → incident start; without a baseline: the plugin history).
// - config: view / simulation distance; jvm: heap max / init (needs a baseline: its state at the window end).
// notable = during/usual ≥ 1.5 (TPS: ≤ 0.67) AND the absolute change is at least the item's minimum (e.g. 5 ms, 1 TPS,
// 100 chunks: 0.2 → 0.4 ms is not "notable"), or usual 0 and during ≥ that minimum, or any plugin/config/jvm change.
// The ratio is computed on the unrounded values.
// Order: notable first, then by distance of the ratio from 1 (log scale, so 2× and ½ weigh the same; changes and
// "new" values count as infinitely far), then kind, then label. At most 40 items.

export type WhatChanged = z.infer<typeof whatChangedSchema>;
export type WhatChangedItem = z.infer<typeof whatChangedItem>;
type Metrics = Partial<Record<MetricName, number>>;

export const MAX_ITEMS = 40;
export const NOTABLE_UP = 1.5;
export const NOTABLE_DOWN = 0.67;
export const TYPE_MIN_COUNT = 50;

export interface PluginRef {
  name: string;
  version: string;
}

export interface WhatChangedInput {
  baseline: Baseline | null;
  /** Hot values per sample in the incident window: raw samples, or 1-min rollups (with tps_1m = the bucket's min). */
  samples: Metrics[];
  /** Per-type counts during the incident, summed over worlds (snapshot, or raw-sample medians); undefined = none. */
  entitiesByType?: Record<string, number>;
  tileEntitiesByType?: Record<string, number>;
  worlds?: { name: string; loadedChunks: number | null; entities: number }[];
  /** Server state at incident start (server_info_history). */
  plugins?: PluginRef[];
  config?: { viewDistance: number; simulationDistance: number };
  jvm?: { heapMaxBytes: number; heapInitBytes: number };
  /** Only used without a baseline: plugin changes from plugin_inventory_history shortly before the incident. */
  pluginHistory?: { name: string; from: string | null; to: string | null }[];
}

interface MetricDef {
  key: MetricName;
  label: string;
  unit?: string;
  scale?: (v: number) => number;
  /** Lower is worse (TPS): during = min, notable when it drops. */
  lowerIsWorse?: boolean;
  /** Minimum absolute change (in display units) before it can be notable. */
  minDelta: number;
}

const MB = (v: number) => v / 1_048_576;
const PCT = (v: number) => v * 100;

export const METRIC_DEFS: MetricDef[] = [
  { key: "mspt_p95", label: "Tick time (slowest 5 %)", unit: "ms", minDelta: 5 },
  { key: "mspt_avg", label: "Tick time (average)", unit: "ms", minDelta: 5 },
  { key: "tps_1m", label: "TPS", lowerIsWorse: true, minDelta: 1 },
  { key: "players", label: "Players online", minDelta: 3 },
  { key: "loaded_chunks", label: "Loaded chunks", minDelta: 100 },
  { key: "entities", label: "Entities", minDelta: 100 },
  { key: "tile_entities", label: "Block entities", minDelta: 50 },
  { key: "heap_used_bytes", label: "Java memory used", unit: "MB", scale: MB, minDelta: 256 },
  { key: "gc_pause_ms", label: "Garbage collection time", unit: "ms", minDelta: 50 },
  { key: "process_cpu", label: "Server CPU", unit: "%", scale: PCT, minDelta: 10 },
  { key: "host_cpu", label: "Machine CPU", unit: "%", scale: PCT, minDelta: 10 },
  { key: "cpu_temp_c", label: "CPU temperature", unit: "°C", minDelta: 5 },
  { key: "swap_used_bytes", label: "Swap in use", unit: "MB", scale: MB, minDelta: 64 },
];
/** Minimum change for per-type and per-world counts. */
export const COUNT_MIN_DELTA = 50;
export const CHUNK_MIN_DELTA = 100;

const KIND_ORDER: Record<WhatChangedItem["kind"], number> = {
  plugin: 0, config: 1, jvm: 2, metric: 3, entityType: 4, tileEntityType: 5, world: 6,
};

const round1 = (v: number) => Math.round(v * 10) / 10;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)]! + s[Math.ceil(mid)]!) / 2;
}

/**
 * Plain-words label for an entity / block entity type, from the rules' own names (rules/util friendlyType:
 * "minecraft:item" → "dropped items"; fallback: no namespace, spaces, naive plural), capitalised.
 */
export function typeLabel(type: string): string {
  const words = friendlyType(type.replace(/^[^:]+:/, ""));
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Numeric item: change / ratio / notable. */
export function numericItem(
  kind: WhatChangedItem["kind"],
  key: string,
  label: string,
  during: number | null,
  usual: number | null,
  opts: { unit?: string; lowerIsWorse?: boolean; minDelta?: number } = {},
): WhatChangedItem {
  const d = during === null ? null : round1(during);
  const u = usual === null ? null : round1(usual);
  const minDelta = opts.minDelta ?? 0;
  let ratio: number | null = null;
  let change: WhatChangedItem["change"] = "same";
  let notable = false;
  if (during !== null && usual !== null) {
    const big = Math.abs(during - usual) >= minDelta;
    if (usual > 0) {
      const exact = during / usual;
      ratio = Math.round(exact * 1000) / 1000;
      change = exact >= 1.1 ? "up" : exact <= 0.9 ? "down" : "same";
      notable = big && (opts.lowerIsWorse ? exact <= NOTABLE_DOWN : exact >= NOTABLE_UP);
    } else if (during > 0) {
      change = "up";
      notable = !opts.lowerIsWorse && big;
    }
  }
  return { kind, key, label, during: d, usual: u, ...(opts.unit ? { unit: opts.unit } : {}), change, ratio, notable };
}

function distance(i: WhatChangedItem): number {
  if (["added", "removed", "updated", "changed"].includes(i.change)) return Infinity;
  if (i.ratio !== null && i.ratio > 0) return Math.abs(Math.log(i.ratio));
  if (i.ratio === 0) return Infinity;
  if (typeof i.during === "number" && i.during > 0 && i.usual === 0) return Infinity;
  return -1; // no comparison possible
}

export function sortItems(items: WhatChangedItem[]): WhatChangedItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.notable) - Number(a.notable) ||
      distance(b) - distance(a) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.label.localeCompare(b.label),
  );
}

function pluginItems(before: PluginRef[], after: PluginRef[]): WhatChangedItem[] {
  const b = new Map(before.map((p) => [p.name, p.version]));
  const a = new Map(after.map((p) => [p.name, p.version]));
  const out: WhatChangedItem[] = [];
  const item = (name: string, from: string | null, to: string | null, change: WhatChangedItem["change"]): WhatChangedItem => ({
    kind: "plugin", key: name.slice(0, 200), label: name.slice(0, 200), during: to?.slice(0, 100) ?? null, usual: from?.slice(0, 100) ?? null,
    change, ratio: null, notable: true,
  });
  for (const [name, v] of a) {
    if (!b.has(name)) out.push(item(name, null, v, "added"));
    else if (b.get(name) !== v) out.push(item(name, b.get(name)!, v, "updated"));
  }
  for (const [name, v] of b) if (!a.has(name)) out.push(item(name, v, null, "removed"));
  return out;
}

function changedItem(kind: "config" | "jvm", key: string, label: string, from: number, to: number, unit?: string): WhatChangedItem | null {
  if (from === to) return null;
  return { kind, key, label, during: to, usual: from, ...(unit ? { unit } : {}), change: "changed", ratio: null, notable: true };
}

export function computeWhatChanged(input: WhatChangedInput): WhatChanged {
  const b = input.baseline;
  const items: WhatChangedItem[] = [];

  // Metrics
  for (const def of METRIC_DEFS) {
    const vals = input.samples.map((s) => s[def.key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const raw = vals.length === 0 ? null : def.lowerIsWorse ? Math.min(...vals) : median(vals);
    const base = b?.metrics[def.key]?.median ?? null;
    if (raw === null && base === null) continue;
    const scale = def.scale ?? ((v: number) => v);
    items.push(numericItem("metric", def.key, def.label, raw === null ? null : scale(raw), base === null ? null : scale(base), def));
  }

  // Entity / tile entity types
  const types = (kind: "entityType" | "tileEntityType", during?: Record<string, number>, usual?: Record<string, number>) => {
    if (!during && !usual) return;
    const keys = new Set([...Object.keys(during ?? {}), ...Object.keys(usual ?? {})]);
    for (const t of keys) {
      if (t === "other") continue;
      const d = during ? ownNum(during, t) : null;
      const u = b && usual ? ownNum(usual, t) : null;
      if (!((d ?? 0) >= TYPE_MIN_COUNT || (u ?? 0) >= TYPE_MIN_COUNT)) continue;
      items.push(numericItem(kind, t.slice(0, 200), typeLabel(t).slice(0, 200), d, u, { minDelta: COUNT_MIN_DELTA }));
    }
  };
  types("entityType", input.entitiesByType, b?.entitiesByType);
  types("tileEntityType", input.tileEntitiesByType, b?.tileEntitiesByType);

  // Worlds
  if (input.worlds || b?.worlds) {
    const names = new Set([...(input.worlds ?? []).map((w) => w.name), ...(b?.worlds ?? []).map((w) => w.name)]);
    for (const name of [...names].sort()) {
      const d = input.worlds?.find((w) => w.name === name);
      const u = b?.worlds?.find((w) => w.name === name);
      const chunksD = d ? d.loadedChunks : null;
      if (chunksD !== null || u) items.push(numericItem("world", `${name}:loaded_chunks`.slice(0, 200), `${name}: loaded chunks`.slice(0, 200), chunksD, u ? u.loadedChunks : null, { minDelta: CHUNK_MIN_DELTA }));
      items.push(numericItem("world", `${name}:entities`.slice(0, 200), `${name}: entities`.slice(0, 200), d ? d.entities : null, u ? u.entities : null, { minDelta: COUNT_MIN_DELTA }));
    }
  }

  // Plugins, config, JVM
  if (b) {
    if (input.plugins) items.push(...pluginItems(b.plugins, input.plugins));
    if (b.config && input.config) {
      const v = changedItem("config", "view_distance", "View distance", b.config.viewDistance, input.config.viewDistance);
      const s = changedItem("config", "simulation_distance", "Simulation distance", b.config.simulationDistance, input.config.simulationDistance);
      if (v) items.push(v);
      if (s) items.push(s);
    }
    if (b.jvm && input.jvm) {
      const mx = changedItem("jvm", "heap_max", "Max Java memory", Math.round(MB(b.jvm.heapMaxBytes)), Math.round(MB(input.jvm.heapMaxBytes)), "MB");
      const ini = changedItem("jvm", "heap_init", "Starting Java memory", Math.round(MB(b.jvm.heapInitBytes)), Math.round(MB(input.jvm.heapInitBytes)), "MB");
      if (mx) items.push(mx);
      if (ini) items.push(ini);
    }
  } else {
    for (const p of input.pluginHistory ?? []) {
      const change = p.from === null ? "added" : p.to === null ? "removed" : "updated";
      items.push({
        kind: "plugin", key: p.name.slice(0, 200), label: p.name.slice(0, 200), during: p.to?.slice(0, 100) ?? null,
        usual: p.from?.slice(0, 100) ?? null, change, ratio: null, notable: true,
      });
    }
  }

  return {
    baselineAvailable: b !== null,
    healthyMinutes: b?.healthyMinutes ?? 0,
    baselineFrom: b?.from ?? null,
    baselineTo: b?.to ?? null,
    items: sortItems(items).slice(0, MAX_ITEMS),
  };
}
