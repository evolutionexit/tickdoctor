import {
  finding as findingSchema,
  incidentDetail as incidentDetailSchema,
  type Finding,
  type IncidentDetail,
  type IncidentListItem,
  type MetricName,
  type MetricsResponse,
  type ServerDetail,
  isTuningTip,
  SEVERITY_RANK,
} from "@tickdoctor/shared";
import { ApiError } from "./api";
import type { DemoDataset, DemoPoint } from "./demo-types";
import type { ServerApi } from "./server-env";

export const DEMO_SERVER_ID = "00000000-0000-4000-8000-000000000001";

/** Keys whose numeric value is "seconds before the anchor". */
const TIME_KEYS = new Set([
  "startedAt", "endedAt", "lastSeenAt", "firstSeenAt", "firstSampleAt", "createdAt", "updatedAt", "capturedAt", "markedFixedAt",
  "confirmedFixedAt", "since", "ts", "from", "to", "baselineFrom", "baselineTo", "keyCreatedAt",
]);
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** Deep copy with every time converted to an ISO string where the anchor (latest sample) = `now`. */
function shiftTimes<T>(value: T, now: number, deltaMs: number | null, keys: Set<string> = TIME_KEYS, key = ""): T {
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, now, deltaMs, keys, key)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftTimes(v, now, deltaMs, keys, k);
    return out as T;
  }
  if (keys.has(key)) {
    if (typeof value === "number") return new Date(now - value * 1000).toISOString() as T;
    if (typeof value === "string" && ISO.test(value) && deltaMs !== null) return new Date(Date.parse(value) + deltaMs).toISOString() as T;
  }
  return value;
}

function ms(t: number | string, now: number, deltaMs: number | null): number {
  return typeof t === "number" ? now - t * 1000 : Date.parse(t) + (deltaMs ?? 0);
}

function typed<T>(schema: { safeParse: (v: unknown) => { success: boolean } }, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (!r.success && process.env.NODE_ENV !== "production") console.warn(`Demo dataset: ${what} doesn't match the contract`, r);
  return raw as T;
}

function p90Step(ts: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < ts.length; i++) diffs.push((ts[i]! - ts[i - 1]!) / 1000);
  if (!diffs.length) return 60;
  diffs.sort((a, b) => a - b);
  return Math.max(60, Math.round(diffs[Math.floor(diffs.length * 0.9)] ?? 60));
}

/** Builds a read-only API (same signatures as `api`) over the static dataset, with times shifted so the anchor = now. */
export function createDemoApi(ds: DemoDataset, now = Date.now()): { api: ServerApi; serverName: string } {
  const deltaMs = ds.meta.anchorAt ? now - Date.parse(ds.meta.anchorAt) : null;
  const keys = new Set([...TIME_KEYS, ...(ds.timeKeys ?? [])]);
  const incidents = ds.incidents.map((i) => typed<IncidentDetail>(incidentDetailSchema, shiftTimes(i, now, deltaMs, keys), "incident"));
  const findings = ds.findings.map((f) => typed<Finding>(findingSchema, shiftTimes(f, now, deltaMs, keys), "finding"));
  const metrics = new Map<MetricName, { t: number; p: [number | null, number | null, number | null] }[]>();
  for (const [name, pts] of Object.entries(ds.series.metrics) as [MetricName, DemoPoint[]][]) {
    metrics.set(name, pts.map((p) => ({ t: ms(p[0], now, deltaMs), p: [p[1], p[2], p[3]] as [number | null, number | null, number | null] })).sort((a, b) => a.t - b.t));
  }

  const listItem = (i: IncidentDetail): IncidentListItem & { findingCount: number; topFindingTitle: string | null } => ({
    id: i.incident.id,
    startedAt: i.incident.startedAt,
    endedAt: i.incident.endedAt,
    severity: i.incident.severity,
    peakMsptP95: i.incident.peakMsptP95,
    minTps1m: i.incident.minTps1m,
    trigger: i.incident.trigger,
    findingCount: i.findings.length,
    topFindingTitle: i.findings[0]?.title ?? null,
  });
  const items = incidents.map(listItem);
  const notFound = () => new ApiError(404, "not_found", "Not found in the demo.");

  const detail = { ...shiftTimes(ds.server, now, deltaMs, keys), name: ds.meta.serverName } as unknown as ServerDetail;

  const api: ServerApi = {
    server: async () => detail,
    metricsBatch: async (_id, names, from, to) =>
      names.map((metric): MetricsResponse => {
        const pts = (metrics.get(metric) ?? []).filter((x) => x.t >= from.getTime() && x.t <= to.getTime());
        const step = p90Step(pts.map((x) => x.t));
        return {
          metric,
          resolution: step >= 3600 ? "1h" : step >= 120 ? "1m" : "raw",
          bucketSeconds: step,
          from: from.toISOString(),
          to: to.toISOString(),
          points: pts.map((x) => [new Date(x.t).toISOString(), ...x.p]),
        };
      }),
    incidents: async (_id, from, to) =>
      items.filter((i) => Date.parse(i.startedAt) <= to.getTime() && (i.endedAt === null || Date.parse(i.endedAt) >= from.getTime())),
    incidentList: async (_id, status) => items.filter((i) => (status === "open" ? i.endedAt === null : status === "closed" ? i.endedAt !== null : true)),
    incidentDetail: async (incidentId) => {
      const d = incidents.find((i) => i.incident.id === incidentId);
      if (!d) throw notFound();
      return d;
    },
    findings: async (_id, q) => {
      const statusOk = (f: Finding) =>
        q.status === "all" ? true : q.status === "active" ? f.status !== "confirmed_fixed" : f.status === q.status;
      const min = q.severity ? SEVERITY_RANK[q.severity as keyof typeof SEVERITY_RANK] : 0;
      const order = (a: Finding, b: Finding) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Number(b.status === "open") - Number(a.status === "open") ||
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      return {
        findings: findings.filter((f) => !isTuningTip(f) && statusOk(f) && SEVERITY_RANK[f.severity] >= min && (!q.ruleId || f.ruleId === q.ruleId)).sort(order),
        tuningTips: findings.filter((f) => isTuningTip(f) && statusOk(f)).sort(order),
      };
    },
    finding: async (findingId) => {
      const f = findings.find((x) => x.id === findingId);
      if (!f) throw notFound();
      return { finding: f, incidents: items.filter((i) => f.incidentIds.includes(i.id)).reverse() };
    },
    setFindingStatus: async () => {
      throw new ApiError(400, "invalid_request", "This is a demo");
    },
  };
  return { api, serverName: ds.meta.serverName };
}
