import Link from "next/link";
import type { Finding, Severity } from "@tickdoctor/shared";
import { ApiError } from "@/lib/api";
import { HealthBadge } from "../health-badge";
import { EmptyState } from "../ui";

const SEV_HEALTH = { info: "offline", low: "healthy", medium: "degraded", high: "lagging", critical: "lagging" } as const;
const SEV_WORD: Record<Severity, string> = { info: "Info", low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/** Severity is always icon + word + colour (same icons as the health badge). */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return <HealthBadge state={SEV_HEALTH[severity]} label={SEV_WORD[severity]} />;
}

export function OpenClosedBadge({ open }: { open: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-line px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        {open ? <circle cx="8" cy="8" r="5" fill="currentColor" /> : <path d="M3.5 8.5l3 3 6-7" strokeLinecap="square" />}
      </svg>
      {open ? "Happening now" : "Over"}
    </span>
  );
}

export function FindingStatusChip({ f }: { f: Pick<Finding, "status" | "resolvedBy"> }) {
  const label =
    f.status === "open"
      ? "Open"
      : f.status === "marked_fixed"
        ? "Marked fixed – watching"
        : f.resolvedBy === "auto"
          ? "Confirmed fixed automatically"
          : "Confirmed fixed by you";
  const tone = f.status === "open" ? "degraded" : f.status === "marked_fixed" ? "waiting" : "healthy";
  const icon =
    f.status === "open" ? (
      <circle cx="8" cy="8" r="4.5" fill="currentColor" />
    ) : f.status === "marked_fixed" ? (
      <>
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </>
    ) : (
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    );
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold"
      style={{
        color: `var(--health-${tone}-text)`,
        borderColor: `color-mix(in srgb, var(--health-${tone}) 55%, transparent)`,
        background: `color-mix(in srgb, var(--health-${tone}) 12%, transparent)`,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">{icon}</svg>
      {label}
    </span>
  );
}

export function NotFoundState({ error, what }: { error: unknown; what: string }) {
  if (!(error instanceof ApiError) || error.code !== "not_found") return null;
  return (
    <EmptyState title={`We can't find that ${what}`} action={<Link href="/app" className="btn btn-primary">Back to your servers</Link>}>
      <p>It may have been deleted, or the link is wrong.</p>
    </EmptyState>
  );
}

/** Calm list of tuning tips (see isTuningTip). Used on the findings page and, collapsed, on the dashboard. */
export function TipsNote() {
  return <p className="text-sm text-muted">Small improvements we noticed in your setup. These don&apos;t cause lag, and they never trigger alerts. They&apos;re here for when you have a quiet minute.</p>;
}
