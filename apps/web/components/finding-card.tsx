"use client";

import type { FindingView, HealthState, Severity } from "@tickdoctor/shared";
import { useState } from "react";
import { Inline, Markdown } from "./markdown";
import { chunkTp } from "@/lib/tp";
import { HealthBadge } from "./health-badge";
import { LOCKED_FINDING_COPY, LockedPanel } from "./app/locked";

export interface FindingCardProps {
  finding: FindingView;
  /** Exact teleport target. Defaults to the centre of the first chunk in evidence.chunks. */
  tp?: { world?: string; x: number; y: number; z: number };
  /** Optional header strip, as in the dashboard (health + MSPT + sparkline). */
  header?: { health: HealthState; detail?: string; sparkline?: number[] };
  footnote?: string;
  onMarkFixed?: (id: string) => void;
  /** App pages: replaces the built-in "Mark as fixed" button (buttons for the real API). */
  actions?: React.ReactNode;
  /** Small chips next to the severity badge (status, "seen in N incidents"...). */
  badges?: React.ReactNode;
  /** Tuning tips: no severity badge, calmer look. */
  calm?: boolean;
  className?: string;
}

const severityLabel: Record<Severity, string> = {
  info: "Info",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const severityHealth: Record<Severity, HealthState> = {
  info: "offline",
  low: "healthy",
  medium: "degraded",
  high: "lagging",
  critical: "lagging",
};

const OPTIONAL_RE = /^#{1,6}\s+(Optional, for when the simple steps aren't enough\.?)\s*$/m;

/** Everything from the "Optional, for when the simple steps aren't enough" heading on is collapsed. */
function FixBody({ md }: { md: string }) {
  const m = OPTIONAL_RE.exec(md);
  if (!m) return <Markdown md={md} />;
  const head = md.slice(0, m.index);
  const rest = md.slice(m.index + m[0].length);
  return (
    <div className="space-y-3">
      {head.trim() ? <Markdown md={head} /> : null}
      <details className="rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-semibold">{m[1]}</summary>
        <div className="mt-3"><Markdown md={rest} /></div>
      </details>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values);
  const w = 120;
  const h = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 3) - 1}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="text-accent-text">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function FindingCard({ finding, tp, header, footnote, onMarkFixed, actions, badges, calm, className = "" }: FindingCardProps) {
  const [copied, setCopied] = useState(false);
  const [fixed, setFixed] = useState(finding.status !== "open");

  const locked = finding.locked === true;
  const chunk = finding.evidence?.chunks?.[0];
  const target =
    tp ?? (chunk ? { world: chunk.world, x: chunk.x * 16 + 8, y: 70, z: chunk.z * 16 + 8 } : undefined);
  // Chunk coordinates only: "~" keeps the player's own height. An explicit tp (landing example) keeps its y.
  const command = tp
    ? `/tp @s ${tp.x} ${tp.y} ${tp.z}`
    : chunk
      ? chunkTp(chunk.world, chunk.x, chunk.z).command
      : undefined;
  const tpNote = !tp && chunk ? chunkTp(chunk.world, chunk.x, chunk.z).note : null;

  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback for insecure contexts / older browsers.
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <article
      aria-labelledby={`finding-${finding.id}`}
      className={`overflow-hidden rounded-lg border border-line bg-surface text-left shadow-lg shadow-black/10 ${className}`}
    >
      {header ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <HealthBadge state={header.health} detail={header.detail} />
          {header.sparkline ? <Sparkline values={header.sparkline} /> : null}
        </div>
      ) : null}

      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {calm ? (
              <span className="rounded-sm border border-line px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted">Tuning tip</span>
            ) : (
              <HealthBadge state={severityHealth[finding.severity]} label={`${severityLabel[finding.severity]} severity`} />
            )}
            {badges}
          </div>
          <h3 id={`finding-${finding.id}`} className="mt-3 text-lg font-semibold leading-snug">
            {finding.title}
          </h3>
        </div>

        {locked ? (
          <LockedPanel what={LOCKED_FINDING_COPY} />
        ) : (
          <>
        {finding.explanation ? <p className="text-sm leading-relaxed text-muted"><Inline text={finding.explanation} /></p> : null}

        {chunk || target ? (
          <p className="font-mono text-sm">
            <span className="text-muted">Location </span>
            {target ? `${target.world ?? chunk?.world ?? "world"}, ${target.x}, ${target.z}` : null}
          </p>
        ) : null}

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence</h4>
          <dl className="mt-2 divide-y divide-line rounded-md border border-line text-sm">
            {(finding.evidence?.numbers ?? []).map((n) => (
              <div key={n.label} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <dt className="text-muted">{n.label}</dt>
                <dd className="font-mono">
                  <span className="font-semibold">
                    {n.value}
                    {n.unit ? ` ${n.unit}` : ""}
                  </span>
                  {n.baseline !== undefined ? <span className="text-muted"> (usually {n.baseline})</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">What to do</h4>
          <div className="mt-2 text-sm leading-relaxed">
            <FixBody md={finding.suggestedFix ?? ""} />
          </div>
        </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {command ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={copy}>
              {copied ? "Copied" : "Copy /tp command"}
            </button>
          ) : null}
          {actions ?? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={fixed}
            onClick={() => {
              setFixed(true);
              onMarkFixed?.(finding.id);
            }}
            disabled={fixed}
          >
            {fixed ? "Marked as fixed" : "Mark as fixed"}
          </button>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Command copied to clipboard" : ""}
          </span>
        </div>
        {tpNote ? <p className="text-xs text-muted">{tpNote}</p> : null}
        {footnote ? <p className="text-xs text-muted">{footnote}</p> : null}
      </div>
    </article>
  );
}
