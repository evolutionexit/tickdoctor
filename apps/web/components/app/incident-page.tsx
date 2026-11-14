"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { FindingView, IncidentDetail, MetricName } from "@tickdoctor/shared";
import { ApiError, friendlyError } from "@/lib/api";
import { align, type Aligned } from "@/lib/chart-data";
import { chunkTp } from "@/lib/tp";
import { dateTime, duration, num, ratioWords } from "@/lib/format";
import { useServerEnv } from "@/lib/server-env";
import { usePolled } from "@/lib/hooks";
import { Card, CopyButton, EmptyState, ErrorState, Skeleton } from "../ui";
import { FindingCard } from "../finding-card";
import { TimeChart, type ChartBand, type ChartSeries } from "../charts/time-chart";
import { NotFoundState, OpenClosedBadge, SeverityBadge } from "./bits";
import { FindingActions } from "./finding-actions";
import { FindingStatusChip } from "./bits";
import { LockedPanel } from "./locked";

const METRICS: MetricName[] = ["mspt_p95", "mspt_avg", "tps_1m"];
const PAD = 30 * 60_000;
const msptY = (m: number): [number, number] => [0, Math.max(60, Math.ceil((m * 1.1) / 10) * 10)];
const tpsY = (): [number, number] => [0, 22];

type WhatChangedData = NonNullable<IncidentDetail["whatChanged"]>;
type Item = WhatChangedData["items"][number];

const tm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function IncidentPage({ serverId, incidentId }: { serverId: string; incidentId: string }) {
  const { api, base, demo, serverName } = useServerEnv();
  const [closed, setClosed] = useState(false);
  // Poll only while the incident is open.
  const detail = usePolled(() => api.incidentDetail(incidentId), `incident-${incidentId}`, closed ? undefined : 30_000);
  const d = detail.data;
  useEffect(() => {
    if (d) setClosed(d.incident.endedAt !== null);
  }, [d]);
  const [findings, setFindings] = useState<FindingView[]>([]);
  useEffect(() => {
    if (d) setFindings(d.findings);
  }, [d]);

  const back = (
    <span className="flex flex-wrap items-center gap-x-3">
      {demo && serverName ? <span className="text-sm font-semibold text-muted">{serverName}</span> : null}
      <Link href={`${base(serverId)}/incidents`} className="text-sm text-muted hover:text-fg">
        ← All incidents
      </Link>
    </span>
  );

  if (!d && detail.loading)
    return (
      <div role="status" aria-label="Loading incident" className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-72" />
        <Skeleton className="h-40" />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-3">
        {back}
        {detail.error instanceof ApiError && detail.error.code === "not_found" ? (
          <NotFoundState error={detail.error} what="incident" />
        ) : (
          <ErrorState title="Couldn't load this incident" message={friendlyError(detail.error)} onRetry={detail.reload} />
        )}
      </div>
    );

  const inc = d.incident;
  const open = inc.endedAt === null;
  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SeverityBadge severity={inc.severity} />
          <OpenClosedBadge open={open} />
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          {open ? `Lag in progress since ${tm(inc.startedAt)}` : `Lag on ${new Date(inc.startedAt).toLocaleDateString([], { month: "short", day: "numeric" })}, ${tm(inc.startedAt)}`}
        </h1>
        <p className="mt-1 text-sm">
          <strong>{open ? "Still happening." : inc.endReason === "offline" ? `Over. The server went offline at ${tm(inc.endedAt!)}.` : `Over. The server recovered at ${tm(inc.endedAt!)}.`}</strong>{" "}
          <span className="text-muted">{open ? "Lasting" : "Lasted"} {duration(inc.durationSeconds)}.</span>
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          <span className="font-semibold text-fg">What triggered it. </span>
          {inc.trigger === "mspt"
            ? "Ticks were too slow. The slowest 5 % of ticks took longer than 50 ms for a while. The server only has 50 ms per tick, so anything above that means it can't keep up."
            : "The server fell behind. TPS stayed under 18 for 90 seconds, even though individual ticks may not have looked slow. This usually means short, heavy freezes, for example while the world is being generated."}
        </p>
        {inc.source === "rollup_1m" ? <p className="mt-2 text-xs text-muted">Detailed data from this time has already been summarised, so some numbers are rougher than usual.</p> : null}
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div><dt className="text-xs uppercase tracking-wide text-muted" title="The slowest 5 % of ticks. A healthy server stays under 50 ms.">Slowest ticks</dt><dd className="font-mono font-semibold">{num(inc.peakMsptP95, 0)} ms</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted" title="20 is perfect. Below 18 players start to notice.">Lowest TPS</dt><dd className="font-mono font-semibold">{num(inc.minTps1m)}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted">Findings</dt><dd className="font-mono font-semibold">{findings.length}</dd></div>
        </dl>
      </div>

      <IncidentGraph serverId={serverId} inc={inc} />
      <WhatChanged w={d.whatChanged} locked={d.locked === true} />

      <section aria-labelledby="findings-h">
        <h2 id="findings-h" className="text-lg font-semibold">What we found</h2>
        <p className="mb-3 text-sm text-muted">
          {d.locked ? "Most likely cause first. On the Free plan you see what was found and how serious it is." : "Most likely cause first. Each finding says what\u2019s wrong, the evidence, and what to do."}
        </p>
        {findings.length === 0 ? (
          <EmptyState title="We didn't find a clear cause">
            <p>The server lagged, but nothing in the data points at one thing we can name with confidence. We&apos;d rather say that than guess.</p>
            <p className="mt-3 font-semibold text-fg">What you can try</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-left">
              <li>Look at &quot;What changed?&quot; below. A plugin that was updated or a number that jumped is often the lead.</li>
              <li>Check the timeline for a restart or a config change just before the lag.</li>
              <li>If it keeps coming back, run a spark profile during the next lag. spark shows exactly which code is slow.</li>
            </ul>
            {!d.snapshot ? <p className="mt-3">We didn&apos;t get a snapshot of this moment (the plugin may have been busy or offline), so there was less to go on.</p> : null}
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {findings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                badges={<FindingStatusChip f={f} />}
                actions={<FindingActions finding={f} onChange={(nf) => setFindings((all) => all.map((x) => (x.id === nf.id ? nf : x)))} />}
              />
            ))}
          </div>
        )}
      </section>

      <WorstChunks snapshot={d.snapshot} locked={d.locked === true} />

      <Card>
        <h2 className="text-lg font-semibold">Timeline</h2>
        <p className="mt-1 text-sm text-muted">What happened from 30 minutes before the lag until it ended, oldest first.</p>
        {d.timeline.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing else was recorded around this time.</p>
        ) : (
          <ol className="mt-3 space-y-2 border-l border-line pl-4 text-sm">
            {d.timeline.map((t, i) => (
              <li key={i} className="relative">
                <span aria-hidden="true" className="absolute -left-[1.3rem] top-1.5 h-2 w-2 bg-[var(--accent)]" />
                <time dateTime={t.ts} className="mr-3 font-mono text-xs text-muted">{new Date(t.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                {t.label}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function IncidentGraph({ serverId, inc }: { serverId: string; inc: IncidentDetail["incident"] }) {
  const { api } = useServerEnv();
  const start = Date.parse(inc.startedAt);
  const end = inc.endedAt ? Date.parse(inc.endedAt) : null;
  const graph = usePolled(
    async () => {
      const to = new Date(Math.min((end ?? Date.now()) + PAD, Date.now()));
      const from = new Date(start - PAD);
      const series = await api.metricsBatch(serverId, METRICS, from, to);
      return { series, from: from.getTime() / 1000, to: to.getTime() / 1000 };
    },
    `inc-graph-${inc.id}-${end ?? "open"}`,
    end ? undefined : 60_000,
  );
  const aligned = useMemo<Aligned | null>(() => (graph.data ? align(graph.data.series, { mspt_p95: "max", tps_1m: "min" }) : null), [graph.data]);
  const range = useMemo<[number, number]>(() => [graph.data?.from ?? 0, graph.data?.to ?? 1], [graph.data]);
  const bands = useMemo<ChartBand[]>(
    () => [{ from: start / 1000, to: (end ?? Date.now()) / 1000, label: `Incident (${inc.severity})${end ? "" : ", still open"}` }],
    [start, end, inc.severity],
  );
  const mspt = useMemo<ChartSeries[]>(
    () =>
      aligned
        ? [
            { label: "MSPT p95", values: aligned.values.mspt_p95 ?? [], color: { dark: "#56B4E9", light: "#0072B2" }, width: 2, unit: "ms" },
            { label: "MSPT avg", values: aligned.values.mspt_avg ?? [], color: { dark: "#E69F00", light: "#B35900" }, width: 1.5, dash: [5, 3], unit: "ms" },
          ]
        : [],
    [aligned],
  );
  const tps = useMemo<ChartSeries[]>(
    () => (aligned ? [{ label: "TPS", values: aligned.values.tps_1m ?? [], color: { dark: "#56B4E9", light: "#0072B2" }, width: 2 }] : []),
    [aligned],
  );
  const thresholds = useMemo(() => [{ value: 50, label: "50 ms: one full tick" }], []);
  const none = useMemo(() => [], []);

  if (!graph.data && graph.loading) return <div role="status" aria-label="Loading graphs"><Skeleton className="h-72" /></div>;
  if (!graph.data) return <ErrorState title="Couldn't load the graph" message={friendlyError(graph.error)} onRetry={graph.reload} />;
  if (!aligned || aligned.present.size === 0)
    return (
      <EmptyState title="No graph data for this time">
        <p>Detailed data from this period has been cleaned up, or the server sent nothing. The numbers above still apply.</p>
      </EmptyState>
    );
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-semibold">Tick time (MSPT)</h2>
        <p className="mb-3 text-sm text-muted">Half an hour before and after. The shaded bar is the incident.</p>
        <TimeChart xs={aligned.xs} series={mspt} range={range} bands={bands} thresholds={thresholds} yRange={msptY} clipSpikes ariaLabel="Tick time around this incident" />
      </Card>
      <Card>
        <h2 className="font-semibold">TPS</h2>
        <p className="mb-3 text-sm text-muted">20 is perfect. Lower means the game runs in slow motion.</p>
        <TimeChart xs={aligned.xs} series={tps} range={range} bands={bands} thresholds={none} yRange={tpsY} ariaLabel="TPS around this incident" />
      </Card>
    </div>
  );
}

function fmt(v: Item["during"], unit?: string) {
  if (v === null) return "–";
  const n = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : v;
  return unit ? `${n} ${unit}` : n;
}

function WhatChanged({ w, locked }: { w: IncidentDetail["whatChanged"]; locked: boolean }) {
  const [all, setAll] = useState(false);
  if (!w) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">What changed?</h2>
        {locked ? <LockedPanel className="mt-3" what="Upgrade to Pro to see what changed: how your server looked during the lag compared with when it is healthy, and which plugin or setting changed." /> : null}
      </Card>
    );
  }
  const notable = w.items.filter((i) => i.notable);
  const shown = all ? w.items : notable;
  return (
    <Card>
      <h2 className="text-lg font-semibold">What changed?</h2>
      <p className="mt-1 text-sm text-muted">
        We compare the lag with how your server looks when it&apos;s healthy. Numbers marked &quot;notable&quot; are at least 1.5 times higher than usual, or are a plugin or setting change.
        {w.baselineAvailable && w.baselineFrom && w.baselineTo
          ? ` Compared with ${w.healthyMinutes >= 120 ? `${Math.round(w.healthyMinutes / 60)} hours` : `${w.healthyMinutes} minutes`} of healthy time, ${dateTime(w.baselineFrom)} to ${dateTime(w.baselineTo)}.`
          : ""}
      </p>
      {!w.baselineAvailable ? (
        <p className="mt-2 rounded-md border border-line bg-surface-2 p-3 text-sm">
          <strong>No healthy baseline yet.</strong> TickDoctor needs some time with your server running well before it can say what&apos;s different. Until then we can only show the numbers during the lag, without a &quot;usual&quot; to compare to. The more normal hours it sees, the more useful this gets.
        </p>
      ) : null}
      {w.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing to compare yet.</p>
      ) : (
        <>
          {shown.length === 0 ? <p className="mt-3 text-sm text-muted">Nothing stood out. Show everything to see all numbers.</p> : <ChangeTable items={shown} />}
          {w.items.length > notable.length ? (
            <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setAll(!all)} aria-expanded={all}>
              {all ? "Only notable changes" : "Show everything"}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ChangeTable({ items }: { items: Item[] }) {
  return (
    <div className="relative mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Values during the incident compared with usual">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <caption className="sr-only">Values during the incident compared with usual</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-3 font-semibold">What</th>
            <th scope="col" className="py-2 pr-3 font-semibold">During the lag</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Usually</th>
            <th scope="col" className="py-2 font-semibold">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((i, n) => (
            <tr key={`${i.kind}-${i.key}-${n}`}>
              <th scope="row" className="py-2 pr-3 font-medium">
                {i.label}
                {i.notable ? <span className="ml-2 rounded-sm border border-[var(--accent)] px-1 text-[10px] font-semibold uppercase text-accent-text">Notable</span> : null}
              </th>
              <td className="py-2 pr-3 font-mono">{i.kind === "plugin" || i.kind === "config" || i.kind === "jvm" ? fmt(i.during, i.unit) : fmt(i.during, i.unit)}</td>
              <td className="py-2 pr-3 font-mono text-muted">{i.usual === null && i.kind !== "plugin" ? "not enough data" : fmt(i.usual, i.unit)}</td>
              <td className="py-2">{changeWords(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function changeWords(i: Item): string {
  switch (i.change) {
    case "added": return "Installed";
    case "removed": return "Removed";
    case "updated": return i.usual !== null && i.during !== null ? `Updated ${i.usual} → ${i.during}` : "Updated";
    case "changed": return i.usual !== null && i.during !== null ? `Changed from ${i.usual} to ${i.during}` : "Changed";
    case "same": return "about usual";
    default: return i.key === "tps_1m" ? `${fmt(i.during)} TPS (usually ${fmt(i.usual)})` : ratioWords(i.ratio, i.usual);
  }
}

function WorstChunks({ snapshot, locked }: { snapshot: IncidentDetail["snapshot"]; locked: boolean }) {
  const chunks = snapshot?.worstChunks ?? [];
  return (
    <Card>
      <h2 className="text-lg font-semibold">Worst chunks</h2>
      {locked ? (
        <LockedPanel className="mt-3" what="Upgrade to Pro to see the busiest chunks with their coordinates and a copy-paste teleport command." />
      ) : !snapshot ? (
        <p className="mt-2 text-sm text-muted">No chunk details for this incident. They come from the snapshot, and this incident doesn&apos;t have one.</p>
      ) : chunks.length === 0 ? (
        <p className="mt-2 text-sm text-muted">The snapshot didn&apos;t list any busy chunks.</p>
      ) : (
        <>
          <p id="tp-help" className="mt-1 text-sm text-muted">
            The busiest spots in the world when the snapshot was taken, ranked by how many entities and block entities (hoppers, furnaces, chests…) they hold. Lag often hides in one of these. Walk there and look.
          </p>
          <div className="relative mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Chunks with the most entities in the snapshot">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Chunks with the most entities in the snapshot</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">World</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Chunk</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Entities</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Block entities</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Mostly</th>
                  <th scope="col" className="py-2 font-semibold"><span className="sr-only">Teleport</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {chunks.map((c, i) => {
                  const { command: cmd, note } = chunkTp(c.world, c.x, c.z);
                  return (
                    <tr key={i}>
                      <td className="py-2 pr-3 font-mono">{c.world}</td>
                      <td className="py-2 pr-3 font-mono">{c.x}, {c.z}</td>
                      <td className="py-2 pr-3 font-mono">{c.entities}</td>
                      <td className="py-2 pr-3 font-mono">{c.tileEntities}</td>
                      <td className="py-2 pr-3 text-muted">{c.topTypes.map((t) => `${t.type.replace(/^minecraft:/, "")} ×${t.count}`).join(", ") || "–"}</td>
                      <td className="py-2 text-right" title="Copies a teleport command. Paste it into the game chat or the server console. It puts you at the middle of this chunk, at your current height (the ~ keeps it). You need operator rights, and in another world you have to be in that world first.">
                        <CopyButton text={cmd} label="Copy /tp" />
                        {note ? <span className="mt-1 block text-left text-xs text-muted">{note}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
