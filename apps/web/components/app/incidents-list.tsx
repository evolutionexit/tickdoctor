"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, friendlyError } from "@/lib/api";
import { useServerEnv } from "@/lib/server-env";
import { dateTime, duration, num } from "@/lib/format";
import { usePolled } from "@/lib/hooks";
import { EmptyState, ErrorState, Skeleton } from "../ui";
import { NotFoundState, OpenClosedBadge, SeverityBadge } from "./bits";

type Filter = "all" | "open" | "closed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Still happening" },
  { id: "closed", label: "Over" },
];

export function IncidentsList({ id }: { id: string }) {
  const { api, base, demo, serverName } = useServerEnv();
  const [filter, setFilter] = useState<Filter>("all");
  const list = usePolled(() => api.incidentList(id, filter === "all" ? undefined : filter), `incidents-${id}-${filter}`, 30_000);

  const items = list.data
    ? [...list.data].sort((a, b) => {
        if ((a.endedAt === null) !== (b.endedAt === null)) return a.endedAt === null ? -1 : 1;
        return Date.parse(b.startedAt) - Date.parse(a.startedAt);
      })
    : [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          {demo && serverName ? <p className="text-sm font-semibold text-muted">{serverName}</p> : null}
          <h1 className="text-2xl font-bold tracking-tight">Incidents</h1>
          <p className="mt-1 text-sm text-muted">An incident is a stretch of time when your server lagged. TickDoctor opens one when the server falls behind, saves a snapshot of that moment, and closes it when things are back to normal.</p>
        </div>
        <div role="group" aria-label="Filter incidents" className="inline-flex overflow-hidden rounded-md border border-line">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-9 px-3 text-sm font-medium ${filter === f.id ? "bg-accent text-accent-fg" : "bg-surface hover:bg-surface-2"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {!list.data && list.loading ? (
        <div role="status" aria-label="Loading incidents" className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : !list.data ? (
        list.error instanceof ApiError && list.error.code === "not_found" ? (
          <NotFoundState error={list.error} what="server" />
        ) : (
          <ErrorState title="Couldn't load incidents" message={friendlyError(list.error)} onRetry={list.reload} />
        )
      ) : items.length === 0 ? (
        <EmptyState title={filter === "all" ? "No incidents yet. That's good news." : "No incidents match this filter"}
          action={filter === "all" ? undefined : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilter("all")}>Show all incidents</button>}>
          <p>{filter === "all" ? "Your server hasn't lagged since TickDoctor started watching. If it does, you'll find it here, with what changed and what to try." : "Try \"All\" to see everything."}</p>
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {items.map((i) => {
            const open = i.endedAt === null;
            const secs = ((open ? Date.now() : Date.parse(i.endedAt!)) - Date.parse(i.startedAt)) / 1000;
            return (
              <li key={i.id} className="relative rounded-lg border border-line bg-surface p-4 transition-colors hover:border-[var(--accent)] sm:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={i.severity} />
                  <OpenClosedBadge open={open} />
                  <Link href={`${base(id)}/incidents/${i.id}`} className="font-semibold after:absolute after:inset-0 hover:underline">
                    {dateTime(i.startedAt)}
                  </Link>
                </div>
                <p className="mt-2 text-sm">
                  {i.topFindingTitle ? <span className="font-medium">{i.topFindingTitle}</span> : <span className="text-muted">No clear cause found</span>}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Lasted" value={open ? `${duration(secs)} so far` : duration(secs)} />
                  <Stat label="Slowest ticks" value={`${num(i.peakMsptP95, 0)} ms`} />
                  <Stat label="Lowest TPS" value={num(i.minTps1m)} />
                  <Stat label="Findings" value={`${i.findingCount}`} />
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono font-semibold">{value}</dd>
    </div>
  );
}
