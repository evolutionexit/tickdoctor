import type { ServerHealth } from "@tickdoctor/shared";

// Colour-blind friendly: every state is icon shape + word + colour.
const config: Record<ServerHealth, { label: string; icon: React.ReactNode }> = {
  healthy: {
    label: "Healthy",
    icon: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />,
  },
  degraded: {
    label: "Degraded",
    icon: (
      <>
        <rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <rect x="3" y="3" width="5" height="10" fill="currentColor" />
      </>
    ),
  },
  lagging: {
    label: "Lagging",
    icon: (
      <>
        <path d="M8 2.2L14.5 13.5H1.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <rect x="7.2" y="6.2" width="1.6" height="3.6" fill="currentColor" />
        <rect x="7.2" y="10.8" width="1.6" height="1.5" fill="currentColor" />
      </>
    ),
  },
  waiting: {
    label: "Waiting for data",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.4 1.6" />
        <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
      </>
    ),
  },
  offline: {
    label: "Offline",
    icon: <rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  },
};

/** The state's icon (16×16 viewBox), for places that draw the state bigger than the badge. */
export function HealthIcon({ state, size = 16 }: { state: ServerHealth; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {config[state].icon}
    </svg>
  );
}

export function HealthBadge({ state, detail, label: labelOverride, className = "" }: { state: ServerHealth; detail?: string; label?: string; className?: string }) {
  const { label: defaultLabel, icon } = config[state];
  const label = labelOverride ?? defaultLabel;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${className}`}
      style={{
        color: `var(--health-${state}-text)`,
        borderColor: `color-mix(in srgb, var(--health-${state}) 55%, transparent)`,
        background: `color-mix(in srgb, var(--health-${state}) 12%, transparent)`,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">{icon}</svg>
      <span>{label}</span>
      {detail ? <span className="font-mono font-normal normal-case tracking-normal">· {detail}</span> : null}
    </span>
  );
}
