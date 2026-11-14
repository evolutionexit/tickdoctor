"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLive, type LiveState } from "@/lib/hooks";
import type { FirstData } from "@/lib/types";
import { HealthBadge } from "../health-badge";

/** "Waiting for first data…" that flips live (SSE status event), with a 2 s polling fallback on GET first-data. */
/** Pass `live` from a parent that already has a stream open (one stream per page); otherwise it opens its own. */
export function WaitingForData({ serverId, onConnected, live: liveProp }: { serverId: string; onConnected?: () => void; live?: LiveState }) {
  const own = useLive(liveProp ? null : serverId);
  const live = liveProp ?? own;
  const [first, setFirst] = useState<FirstData | null>(null);
  const [pollFailed, setPollFailed] = useState(false);

  const received = (live.health !== null && live.health !== "waiting") || first?.received === true;

  useEffect(() => {
    if (first) return; // keep asking until we have the details, even when the live stream flipped `received` first
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.firstData(serverId);
        if (!stop) {
          setPollFailed(false);
          if (d.received) setFirst(d);
        }
      } catch {
        if (!stop) setPollFailed(true);
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [serverId, first]);

  useEffect(() => {
    if (received) onConnected?.();
  }, [received, onConnected]);

  if (received)
    return (
      <div role="status" className="rounded-lg border p-4" style={{ borderColor: "color-mix(in srgb, var(--health-healthy) 60%, transparent)", background: "color-mix(in srgb, var(--health-healthy) 10%, transparent)" }}>
        <HealthBadge state="healthy" label="Connected" />
        <p className="mt-3 font-semibold">Your server is talking to TickDoctor.</p>
        <p className="mt-1 text-sm text-muted">
          {first?.software ? `${first.software}${first.agentVersion ? ` · plugin v${first.agentVersion}` : ""}. ` : ""}
          The first graphs appear within a minute or so.
        </p>
        <Link href={`/app/servers/${serverId}`} className="btn btn-primary mt-4">
          Open the dashboard
        </Link>
      </div>
    );

  return (
    <div role="status" aria-live="polite" className="rounded-lg border border-line bg-surface-2 p-4">
      <HealthBadge state="waiting" />
      <p className="mt-3 font-semibold">Waiting for first data…</p>
      <p className="mt-1 text-sm text-muted">
        Restart your server with the plugin installed. This page updates by itself as soon as it connects.
        {pollFailed ? " We're having trouble checking right now, but we'll keep trying." : ""}
      </p>
    </div>
  );
}
