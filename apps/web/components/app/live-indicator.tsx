import type { LiveConnection } from "@/lib/hooks";

const TEXT: Record<LiveConnection, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  unavailable: "Live updates unavailable. Refreshing every 15 s.",
};

/** Glyph + word, not colour alone. */
export function LiveIndicator({ connection }: { connection: LiveConnection }) {
  const glyph =
    connection === "live" ? (
      <circle cx="6" cy="6" r="4" fill="currentColor" />
    ) : connection === "unavailable" ? (
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2" />
    ) : (
      <circle cx="6" cy="6" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.5 2" />
    );
  return (
    <span role="status" className={`inline-flex items-center gap-1.5 text-xs ${connection === "live" ? "text-accent-text" : "text-muted"}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{glyph}</svg>
      {TEXT[connection]}
    </span>
  );
}
