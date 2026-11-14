import type { MetricName, MetricsResponse } from "@tickdoctor/shared";

export type Pick = "avg" | "min" | "max";
const COL: Record<Pick, 1 | 2 | 3> = { avg: 1, min: 2, max: 3 };

export interface Aligned {
  /** unix seconds, with extra all-null rows inserted where the server sent nothing (shown as gaps) */
  xs: number[];
  values: Partial<Record<MetricName, (number | null)[]>>;
  /** metrics that have at least one real value in the range */
  present: Set<MetricName>;
}

/** Merges separately-bucketed series onto one time axis. Missing buckets become gaps, never zeros. */
export function align(series: MetricsResponse[], pick: Partial<Record<MetricName, Pick>>): Aligned {
  const maps = new Map<MetricName, Map<number, number | null>>();
  const all = new Set<number>();
  let bucket = 0;
  for (const s of series) {
    const m = new Map<number, number | null>();
    const col = COL[pick[s.metric] ?? "avg"];
    for (const p of s.points) {
      const t = Math.floor(Date.parse(p[0]) / 1000);
      m.set(t, p[col]);
      all.add(t);
    }
    bucket = Math.max(bucket, s.bucketSeconds);
    maps.set(s.metric, m);
  }
  const sorted = [...all].sort((a, b) => a - b);
  const xs: number[] = [];
  const gaps = new Set<number>();
  sorted.forEach((t, i) => {
    xs.push(t);
    const next = sorted[i + 1];
    if (next !== undefined && next - t > bucket * 2.5) {
      xs.push(t + bucket);
      gaps.add(t + bucket);
    }
  });
  const values: Aligned["values"] = {};
  const present = new Set<MetricName>();
  for (const [metric, m] of maps) {
    const arr = xs.map((t) => (gaps.has(t) ? null : (m.get(t) ?? null)));
    values[metric] = arr;
    if (arr.some((v) => v !== null)) present.add(metric);
  }
  return { xs, values, present };
}

export function lastValue(arr: (number | null)[] | undefined): number | null {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] ?? null;
  return null;
}
