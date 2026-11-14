import Link from "next/link";
import type { ServerSummary } from "@tickdoctor/shared";
import { ago, num, severityWord } from "@/lib/format";
import { HealthBadge } from "../health-badge";

function Stat({ label, value, unit, title }: { label: string; value: string; unit?: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg font-semibold">
        {value}
        {unit && value !== "–" ? <span className="ml-0.5 text-xs font-normal text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

export function ServerCard({ server: s }: { server: ServerSummary }) {
  const waiting = s.health === "waiting";
  const stale = s.health === "offline";
  return (
    <article aria-labelledby={`srv-${s.id}`} className="flex flex-col rounded-lg border border-line bg-surface p-4 transition-colors hover:border-[var(--accent)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={`srv-${s.id}`} className="min-w-0 break-words text-lg font-semibold">
          <Link href={`/app/servers/${s.id}`} className="after:absolute after:inset-0 hover:underline">
            {s.name}
          </Link>
        </h2>
        <HealthBadge state={s.health} />
      </div>

      {waiting ? (
        <p className="mt-4 flex-1 text-sm text-muted">No data yet. Finish the setup and this card will fill in as soon as the plugin reports.</p>
      ) : (
        <>
          <dl className={`mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 ${stale ? "opacity-70" : ""}`}>
            <Stat label="TPS" value={num(s.latest?.tps1m)} title="Ticks per second. 20 is perfect." />
            <Stat label="MSPT p95" value={num(s.latest?.msptP95)} unit="ms" title="How long the slowest 5% of ticks take. Under 50 ms is healthy." />
            <Stat label="Players" value={s.latest?.players === null || s.latest?.players === undefined ? "–" : String(s.latest.players)} />
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Open incidents</dt>
              <dd className="mt-0.5 font-mono text-lg font-semibold">
                {s.openIncidents > 0 ? (
                  <Link href={`/app/servers/${s.id}/incidents`} className="relative z-10 text-accent-text underline underline-offset-2" aria-label={`${s.openIncidents} open incident${s.openIncidents === 1 ? "" : "s"}, view them`}>
                    {s.openIncidents}
                  </Link>
                ) : (
                  "0"
                )}
              </dd>
            </div>
          </dl>
          {stale ? <p className="mt-2 text-xs text-muted">Last seen {ago(s.lastSeenAt)}.</p> : null}
        </>
      )}

      <div className="mt-4 border-t border-line pt-3 text-sm">
        {s.topFinding ? (
          <p>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{severityWord[s.topFinding.severity]}</span>
            <span className="block">{s.topFinding.title}</span>
          </p>
        ) : waiting ? (
          <p className="relative z-10">
            <Link href={`/app/servers/${s.id}`} className="text-accent-text underline underline-offset-2">
              Finish setup
            </Link>
          </p>
        ) : (
          <p className="text-muted">No open findings.</p>
        )}
      </div>
    </article>
  );
}
