"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { IncidentListItem, MetricName, MetricsResponse } from "@tickdoctor/shared";
import { ApiError, friendlyError } from "@/lib/api";
import { useServerEnv } from "@/lib/server-env";
import { align, type Aligned } from "@/lib/chart-data";
import { ago, bytes, msptTone, num } from "@/lib/format";
import { useLive, usePolled, type LiveState } from "@/lib/hooks";
import { Card, EmptyState, ErrorState, Skeleton } from "../ui";
import { HealthBadge } from "../health-badge";
import { TimeChart, type ChartBand, type ChartSeries, type ChartThreshold } from "../charts/time-chart";
import { HostPanel } from "./host-panel";
import { LiveIndicator } from "./live-indicator";
import { WaitingForData } from "./waiting-for-data";
import { TuningTipsCollapsed } from "./tuning-tips";

const RANGES = [
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "24h", label: "24 hours", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const DEMO_LIVE: LiveState = { connection: "live", health: null, lastSeenAt: null, openIncidentId: null, sample: null };

const GRAPH_METRICS: MetricName[] = ["mspt_p95", "mspt_avg", "tps_1m", "players"];
const HOST_METRICS: MetricName[] = ["host_cpu", "cpu_temp_c", "mem_available_bytes", "swap_used_bytes", "disk_used_bytes"];

const msptYRange = (m: number): [number, number] => [0, Math.max(60, Math.ceil((m * 1.1) / 10) * 10)];
const tpsYRange = (): [number, number] => [0, 22];
const playersYRange = (m: number): [number, number] => [0, Math.max(4, Math.ceil(m * 1.25))];
const THRESHOLDS: ChartThreshold[] = [{ value: 50, label: "50 ms: one full tick" }];
const TPS_THRESHOLDS: ChartThreshold[] = [];

function Tile({ label, value, unit, hint, badge, stale }: { label: string; value: string; unit?: string; hint: string; badge?: React.ReactNode; stale?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 font-mono text-3xl font-semibold ${stale ? "opacity-60" : ""}`}>
        {value}
        {unit && value !== "–" ? <span className="ml-1 text-sm font-normal text-muted">{unit}</span> : null}
      </dd>
      {badge ? <dd className="mt-2">{badge}</dd> : null}
      <dd className="mt-2 text-xs leading-snug text-muted">{hint}</dd>
    </div>
  );
}

type ServerDetail = NonNullable<ReturnType<typeof usePolled<Awaited<ReturnType<ReturnType<typeof useServerEnv>["api"]["server"]>>>>["data"]>;
type GraphsState = ReturnType<typeof useGraphs>;

function useGraphs(id: string, range: RangeId) {
  const { api, base } = useServerEnv();
  const rangeMs = RANGES.find((r) => r.id === range)!.ms;
  const graphs = usePolled(
    async () => {
      const to = new Date();
      const from = new Date(to.getTime() - rangeMs);
      const [series, incidents, host] = await Promise.all([
        api.metricsBatch(id, GRAPH_METRICS, from, to),
        api.incidents(id, from, to).catch(() => [] as IncidentListItem[]),
        api.metricsBatch(id, HOST_METRICS, from, to).catch(() => [] as MetricsResponse[]),
      ]);
      return { series, incidents, host, from: from.getTime() / 1000, to: to.getTime() / 1000 };
    },
    `graphs-${id}-${range}`,
    60_000,
  );

  const aligned = useMemo<Aligned | null>(
    () => (graphs.data ? align(graphs.data.series, { mspt_p95: "max", tps_1m: "min", players: "max" }) : null),
    [graphs.data],
  );
  const hostAligned = useMemo<Aligned | null>(() => (graphs.data ? align(graphs.data.host, {}) : null), [graphs.data]);

  const chartRange = useMemo<[number, number]>(() => [graphs.data?.from ?? 0, graphs.data?.to ?? 1], [graphs.data]);
  const bands = useMemo<ChartBand[]>(
    () =>
      (graphs.data?.incidents ?? []).map((i) => ({
        from: Date.parse(i.startedAt) / 1000,
        to: i.endedAt ? Date.parse(i.endedAt) / 1000 : (graphs.data?.to ?? 0),
        href: `${base(id)}/incidents/${i.id}`,
        label: `Incident (${i.severity}): peak ${num(i.peakMsptP95, 0)} ms${i.endedAt ? "" : ", still open"}`,
      })),
    [graphs.data, id, base],
  );
  const msptSeries = useMemo<ChartSeries[]>(
    () =>
      aligned
        ? [
            { label: "MSPT p95", values: aligned.values.mspt_p95 ?? [], color: { dark: "#56B4E9", light: "#0072B2" }, width: 2, unit: "ms" },
            { label: "MSPT avg", values: aligned.values.mspt_avg ?? [], color: { dark: "#E69F00", light: "#B35900" }, width: 1.5, dash: [5, 3], unit: "ms" },
          ]
        : [],
    [aligned],
  );
  const tpsSeries = useMemo<ChartSeries[]>(
    () =>
      aligned
        ? [
            { label: "TPS", values: aligned.values.tps_1m ?? [], color: { dark: "#56B4E9", light: "#0072B2" }, width: 2 },
            { label: "Players", values: aligned.values.players ?? [], color: { dark: "#E69F00", light: "#B35900" }, width: 1.5, scale: "y2", step: true, digits: 0 },
          ]
        : [],
    [aligned],
  );
  return { graphs, aligned, hostAligned, chartRange, bands, msptSeries, tpsSeries };
}

function LoadingServer() {
  return (
    <div role="status" aria-label="Loading server" className="space-y-4">
      <Skeleton className="h-10 w-64" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function ServerLoadFailed({ error, reload }: { error: unknown; reload: () => void }) {
  if (error instanceof ApiError && error.code === "not_found")
    return (
      <EmptyState title="We can't find that server" action={<Link href="/app" className="btn btn-primary">Back to your servers</Link>}>
        <p>It may have been deleted, or the link is wrong.</p>
      </EmptyState>
    );
  return <ErrorState title="Couldn't load this server" message={friendlyError(error)} onRetry={reload} />;
}

function ServerHeader({ s, health, live, demo }: { s: ServerDetail; health: ServerDetail["health"]; live: LiveState; demo: boolean }) {
  return (
    <div className="mb-6">
      {demo ? null : (
        <Link href="/app" className="text-sm text-muted hover:text-fg">
          ← All servers
        </Link>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">{s.name}</h1>
          <HealthBadge state={health} />
        </div>
        <div className="flex items-center gap-3">
          {demo ? <span className="text-xs text-muted">Sample data, moved to today</span> : <LiveIndicator connection={live.connection} />}
        </div>
      </div>
      {health === "offline" ? <p className="mt-2 text-sm text-muted">No data since {ago(s.lastSeenAt)}. Is the server running?</p> : null}
    </div>
  );
}

function WaitingView({ id, header, live, onConnected }: { id: string; header: React.ReactNode; live: LiveState; onConnected: () => void }) {
  return (
    <div>
      {header}
      <div className="mx-auto max-w-2xl space-y-4">
        <WaitingForData serverId={id} live={live} onConnected={onConnected} />
        <Card>
          <h2 className="font-semibold">Lost your API key?</h2>
          <p className="mt-1 text-sm text-muted">We only show it once. You can make a new one (and a fresh config snippet) in the settings.</p>
          <Link href={`/app/servers/${id}/settings`} className="btn btn-ghost btn-sm mt-3">
            Make a new key
          </Link>
        </Card>
      </div>
    </div>
  );
}

function StatTiles({ sample, stale }: { sample: ServerDetail["latest"]; stale: boolean }) {
  const tpsTone = sample?.tps1m === null || sample?.tps1m === undefined ? "waiting" : sample.tps1m < 18 ? "lagging" : sample.tps1m < 19 ? "degraded" : "healthy";
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="TPS" value={num(sample?.tps1m)} hint="Ticks per second. A healthy server runs 20." stale={stale} badge={sample?.tps1m != null && !stale ? <HealthBadge state={tpsTone} className="!text-[10px]" /> : null} />
      <Tile label="MSPT p95" value={num(sample?.msptP95)} unit="ms" hint="How long the slowest 5% of ticks take. Under 50 ms is healthy." stale={stale} badge={sample?.msptP95 != null && !stale ? <HealthBadge state={msptTone(sample.msptP95)} className="!text-[10px]" /> : null} />
      <Tile label="MSPT avg" value={num(sample?.msptAvg)} unit="ms" hint="Average tick time. MSPT is milliseconds per tick." stale={stale} />
      <Tile label="Players" value={sample?.players == null ? "–" : String(sample.players)} hint="Online right now." stale={stale} />
    </dl>
  );
}

function RangePicker({ ranges, range, setRange }: { ranges: readonly (typeof RANGES)[number][]; range: RangeId; setRange: (r: RangeId) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">History</h2>
      <div role="group" aria-label="Time range" className="inline-flex overflow-hidden rounded-md border border-line">
        {ranges.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={range === r.id}
            onClick={() => setRange(r.id)}
            className={`min-h-9 px-3 text-sm font-medium ${range === r.id ? "bg-accent text-accent-fg" : "bg-surface hover:bg-surface-2"}`}
            aria-label={r.label}
          >
            {r.id}
          </button>
        ))}
      </div>
    </div>
  );
}

function IncidentsCard({ incidents, href }: { incidents: IncidentListItem[]; href: (incidentId: string) => string }) {
  return (
    <Card>
      <h3 className="font-semibold">Incidents in this range</h3>
      {incidents.length === 0 ? (
        <p className="mt-1 text-sm text-muted">None. Nice.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-sm">
          {incidents.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <Link href={href(i.id)} className="font-mono text-accent-text underline underline-offset-2">{new Date(i.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Link>
              <span className="font-semibold capitalize">{i.severity}</span>
              <span className="text-muted">peak {num(i.peakMsptP95, 0)} ms{i.minTps1m != null ? `, TPS down to ${num(i.minTps1m)}` : ""}</span>
              {i.endedAt ? null : <span className="font-semibold">Still open</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GraphsSection({ id, s, range, setRange, g }: { id: string; s: ServerDetail; range: RangeId; setRange: (r: RangeId) => void; g: GraphsState }) {
  const router = useRouter();
  const { base } = useServerEnv();
  const { graphs, aligned, chartRange, bands, msptSeries, tpsSeries } = g;
  const incidents = graphs.data?.incidents ?? [];
  const noPoints = aligned && aligned.present.size === 0;

  if (!graphs.data && graphs.loading)
    return (
      <div role="status" aria-label="Loading graphs" className="space-y-4">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    );
  if (!graphs.data) return <ErrorState title="Couldn't load the graphs" message={friendlyError(graphs.error)} onRetry={graphs.reload} />;
  if (noPoints && range !== "1h" && s.latest && Date.now() - Date.parse(s.latest.ts) < 3_600_000)
    return (
      <EmptyState
        title="Graphs are filling in"
        action={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setRange("1h")}>
            Show the last hour
          </button>
        }
      >
        <p>Data is arriving. Longer ranges are built from minute summaries, so they show up within a couple of minutes.</p>
      </EmptyState>
    );
  if (noPoints)
    return (
      <EmptyState title="No data in this time range">
        <p>The server didn&apos;t report anything in the last {RANGES.find((r) => r.id === range)!.label.toLowerCase()}. Try a longer range, or check that it&apos;s running.</p>
      </EmptyState>
    );
  return (
    <>
      <Card>
        <h3 className="font-semibold">Tick time (MSPT)</h3>
        <p className="mb-3 text-sm text-muted">How long each tick takes. Staying under the dashed 50 ms line keeps the game smooth. Shaded bars are lag incidents.</p>
        <TimeChart xs={aligned!.xs} series={msptSeries} range={chartRange} bands={bands} thresholds={THRESHOLDS} yRange={msptYRange} clipSpikes ariaLabel={`Tick time over the last ${range}`} onBandClick={(b) => b.href && router.push(b.href)} />
        <Legend items={[["MSPT p95 (slowest 5%)", "solid", "#56B4E9", "#0072B2"], ["MSPT avg", "dash", "#E69F00", "#B35900"]]} incident />
      </Card>
      <Card>
        <h3 className="font-semibold">TPS and players</h3>
        <p className="mb-3 text-sm text-muted">TPS on the left (20 is perfect), players online on the right. Gaps mean the server sent no data.</p>
        <TimeChart xs={aligned!.xs} series={tpsSeries} range={chartRange} bands={bands} thresholds={TPS_THRESHOLDS} yRange={tpsYRange} y2Range={playersYRange} ariaLabel={`TPS and players over the last ${range}`} onBandClick={(b) => b.href && router.push(b.href)} />
        <Legend items={[["TPS (lowest in each bucket)", "solid", "#56B4E9", "#0072B2"], ["Players (right axis)", "step", "#E69F00", "#B35900"]]} incident />
      </Card>
      {range !== "1h" ? <p className="-mt-2 text-xs text-muted">On longer ranges each point is a bucket of time. We show the worst value in the bucket (highest MSPT, lowest TPS).</p> : null}

      <IncidentsCard incidents={incidents} href={(incidentId) => `${base(id)}/incidents/${incidentId}`} />
    </>
  );
}

function ServerInfoCard({ info }: { info: ServerDetail["info"] }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold">Server info</h2>
      {info ? (
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Software", info.software],
            ["Minecraft version", info.minecraftVersion],
            ["Java", info.javaVersion],
            ["View / simulation distance", `${info.viewDistance} / ${info.simulationDistance} chunks`],
            ["Heap (max memory for Java)", bytes(info.heapMaxBytes)],
            ["Plugins", String(info.plugins)],
            ["Machine", `${info.host.os} ${info.host.arch}, ${info.host.cores} cores${info.host.cpuModel ? `, ${info.host.cpuModel}` : ""}`],
            ["TickDoctor plugin", `v${info.agentVersion}`],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase tracking-wide text-muted">{k}</dt>
              <dd className="mt-0.5 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted">We haven&apos;t received the server&apos;s details yet. They show up after the plugin says hello.</p>
      )}
    </Card>
  );
}

export function ServerDashboard({ id }: { id: string }) {
  const { api, demo, maxRangeMs } = useServerEnv();
  const ranges = RANGES.filter((r) => r.ms <= maxRangeMs);
  const [range, setRange] = useState<RangeId>("24h");
  const tips = usePolled(() => api.findings(id, { status: "active" }).then((r) => r.tuningTips).catch(() => []), `tips-${id}`, 60_000);
  const detail = usePolled(() => api.server(id), `detail-${id}`, 15_000);
  const liveReal = useLive(demo ? null : id);
  const live = demo ? DEMO_LIVE : liveReal;
  const g = useGraphs(id, range);

  if (!detail.data && detail.loading) return <LoadingServer />;
  if (!detail.data) return <ServerLoadFailed error={detail.error} reload={detail.reload} />;

  const s = detail.data;
  const health = live.health ?? s.health;
  const sample = live.sample ?? s.latest;
  const stale = health === "offline";
  const header = <ServerHeader s={s} health={health} live={live} demo={demo} />;

  if (health === "waiting") return <WaitingView id={id} header={header} live={live} onConnected={detail.reload} />;

  return (
    <div className="space-y-6">
      {header}
      <StatTiles sample={sample} stale={stale} />
      <RangePicker ranges={ranges} range={range} setRange={setRange} />
      <GraphsSection id={id} s={s} range={range} setRange={setRange} g={g} />

      <TuningTipsCollapsed serverId={id} tips={tips.data ?? []} />

      {g.graphs.data ? <HostPanel data={g.hostAligned} live={live.sample} memTotal={s.info?.host.memTotalBytes} /> : null}

      <ServerInfoCard info={s.info} />
    </div>
  );
}

function Legend({ items, incident }: { items: [string, "solid" | "dash" | "step", string, string][]; incident?: boolean }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {items.map(([label, kind, dark, light]) => (
        <li key={label} className="flex items-center gap-1.5">
          <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true" fill="none" style={{ stroke: `light-dark(${light}, ${dark})` }} strokeWidth="2">
            {kind === "step" ? <path d="M0 6H8V2H22" /> : <line x1="0" y1="4" x2="22" y2="4" strokeWidth={kind === "solid" ? 2.5 : 2} strokeDasharray={kind === "dash" ? "5 3" : undefined} />}
          </svg>
          {label}
        </li>
      ))}
      {incident ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-4" style={{ borderTop: "3px solid light-dark(#a21caf, #e879f9)", background: "light-dark(rgba(162,28,175,.12), rgba(217,70,239,.16))" }} />
          Incident
        </li>
      ) : null}
    </ul>
  );
}
