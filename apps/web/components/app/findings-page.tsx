"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RULE_IDS, type FindingView, type RuleId } from "@tickdoctor/shared";
import { ApiError, friendlyError } from "@/lib/api";
import { useServerEnv } from "@/lib/server-env";
import { usePolled } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { EmptyState, ErrorState, Skeleton } from "../ui";
import { FindingCard } from "../finding-card";
import { FindingStatusChip, NotFoundState, SeverityBadge } from "./bits";
import { FindingActions } from "./finding-actions";
import { TuningTipsSection } from "./tuning-tips";

const RULE_LABEL: Record<RuleId, string> = {
  "entity-explosion": "Too many entities",
  "tile-entity-hotspot": "Tile entity hotspot",
  "plugin-change-before-lag": "Plugin change before lag",
  "player-count-threshold": "Player count limit",
  "gc-pressure": "Memory (garbage collection) pressure",
  "thermal-throttling": "CPU overheating",
  "swap-in-use": "Swap in use",
  "view-distance-too-high": "View distance too high",
  "live-chunk-generation": "Chunks generated live",
  "plugin-exceptions": "Plugin errors",
  "jvm-flags": "Java startup flags",
};
const STATUSES = [
  ["active", "Needs attention"],
  ["marked_fixed", "Marked fixed (watching)"],
  ["confirmed_fixed", "Confirmed fixed"],
  ["all", "All"],
] as const;
const SEVERITIES = [
  ["", "Any severity"],
  ["medium", "Medium or higher"],
  ["high", "High or higher"],
  ["critical", "Critical only"],
] as const;

export function FindingsPage({ id }: { id: string }) {
  const { api } = useServerEnv();
  const [status, setStatus] = useState<string>("active");
  const [severity, setSeverity] = useState("");
  const [ruleId, setRuleId] = useState("");
  const res = usePolled(() => api.findings(id, { status, severity: severity || undefined, ruleId: ruleId || undefined }), `findings-${id}-${status}-${severity}-${ruleId}`, 60_000);

  const [findings, setFindings] = useState<FindingView[]>([]);
  const [tips, setTips] = useState<FindingView[]>([]);
  useEffect(() => {
    if (res.data) {
      setFindings(res.data.findings);
      setTips(res.data.tuningTips);
    }
  }, [res.data]);

  const select = "input min-h-10 w-full";
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Findings</h1>
      <p className="mt-1 text-sm text-muted">
        Things TickDoctor found that are slowing your server down, most serious first.{" "}
        {findings.some((f) => f.locked) ? "On the Free plan you see what was found and how serious it is. Pro adds why it happens, the evidence and the fix." : "Each one says what\u2019s wrong, the evidence, and what to do."}
      </p>

      <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()} aria-label="Filter findings">
        <label className="text-sm font-medium">
          Status
          <select className={`${select} mt-1`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">
          Severity
          <select className={`${select} mt-1`} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">
          Type
          <select className={`${select} mt-1`} value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">All types</option>
            {RULE_IDS.map((r) => <option key={r} value={r}>{RULE_LABEL[r]}</option>)}
          </select>
        </label>
      </form>

      <div className="mt-6">
        {!res.data && res.loading ? (
          <div role="status" aria-label="Loading findings" className="space-y-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : !res.data ? (
          res.error instanceof ApiError && res.error.code === "not_found" ? (
            <NotFoundState error={res.error} what="server" />
          ) : (
            <ErrorState title="Couldn't load the findings" message={friendlyError(res.error)} onRetry={res.reload} />
          )
        ) : null}
        {res.data ? (
          findings.length === 0 ? (
            <EmptyState
              title={severity || ruleId ? "No findings match these filters" : status === "active" ? "Nothing needs attention" : status === "confirmed_fixed" ? "Nothing confirmed fixed yet" : status === "all" ? "No findings. Nothing slowing your server down." : "No findings match these filters"}
              action={severity || ruleId ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSeverity(""); setRuleId(""); }}>Clear filters</button> : undefined}
            >
              <p>
                {severity || ruleId
                  ? "Try different filters."
                  : status === "active"
                    ? "Every finding is either confirmed fixed or being watched. Change the status filter to see them."
                    : status === "confirmed_fixed"
                      ? "Findings you fix show up here once they've stayed away long enough."
                      : "TickDoctor checks your server's setup every few minutes and looks into every incident. When it finds something, it appears here."}
              </p>
            </EmptyState>
          ) : (
            <ul className="space-y-4">
              {findings.map((f) => (
                <li key={f.id}>
                  <FindingCard
                    finding={f}
                    badges={<FindingStatusChip f={f} />}
                    actions={<FindingActions finding={f} onChange={(nf) => setFindings((all) => all.map((x) => (x.id === nf.id ? nf : x)))} />}
                  />
                  <SeenIn f={f} />
                </li>
              ))}
            </ul>
          )
        ) : null}
        {res.data ? <TuningTipsSection tips={tips} onChange={(nf) => setTips((t) => t.map((x) => (x.id === nf.id ? nf : x)))} /> : null}
      </div>
    </div>
  );
}

function SeenIn({ f }: { f: FindingView }) {
  const { api, base } = useServerEnv();
  const [open, setOpen] = useState(false);
  const detail = usePolled(() => (open ? api.finding(f.id) : Promise.resolve(null)), `finding-${f.id}-${open}`);
  return (
    <div className="mt-2 px-1 text-sm text-muted">
      <p>
        Seen {f.occurrenceCount} time{f.occurrenceCount === 1 ? "" : "s"}. First seen {dateTime(f.firstSeenAt)}, last seen {dateTime(f.lastSeenAt)}.
        {f.incidentIds.length === 0 ? " Found by checking the server's setup, not tied to one incident." : null}
      </p>
      {f.incidentIds.length > 0 ? (
        <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="mt-1">
          <summary className="cursor-pointer">In {f.incidentIds.length} incident{f.incidentIds.length === 1 ? "" : "s"}</summary>
          {detail.data ? (
            <ul className="mt-1 space-y-1">
              {detail.data.incidents.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base(f.serverId)}/incidents/${i.id}`} className="text-accent-text underline underline-offset-2">{dateTime(i.startedAt)}</Link>
                  <SeverityBadge severity={i.severity} />
                </li>
              ))}
            </ul>
          ) : detail.error ? (
            <p className="mt-1">Couldn&apos;t load the incidents. <button type="button" className="underline" onClick={detail.reload}>Try again</button></p>
          ) : (
            <p className="mt-1">Loading…</p>
          )}
        </details>
      ) : null}
    </div>
  );
}
