import type { Finding, IncidentDetail, MetricName } from "@tickdoctor/shared";

/**
 * Shape of apps/web/content/demo/dataset.json (written by apps/api/src/demo/export.ts, contract: app-phase7.ts).
 * `lib/demo.ts` turns the offsets into ISO strings relative to the render time.
 */
/** [offsetSeconds, avg, min, max] like the metrics API points. */
export type DemoPoint = [number | string, number | null, number | null, number | null];

/** The API's own shapes, with every timestamp (see `timeKeys`) as seconds before the anchor. */
export interface DemoDataset {
  meta: { schemaVersion: 1; serverName: string; exportedFrom: "pi-test-history" | "seed"; anchorNote: string; anchorAt?: string };
  /** Names of every object key whose numeric value is a relative time. */
  timeKeys?: string[];
  /** A serverDetail (id, name, plan, health, latest, info, ...). */
  server: Record<string, unknown> & { info: unknown };
  /** Per metric: points oldest to newest (1-min for the last day, 5-min before). */
  series: { recentSeconds: number; recentBucketSeconds: number; olderBucketSeconds: number; metrics: Partial<Record<MetricName, DemoPoint[]>> };
  incidents: IncidentDetail[];
  findings: Finding[];
}
