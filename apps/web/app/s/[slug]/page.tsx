import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brand } from "@tickdoctor/shared";
import { HealthIcon } from "@/components/health-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { ago, duration } from "@/lib/format";
import { fetchPublicStatus, pct, STATE_VIEW, StatusRateLimited } from "@/lib/public-status";
import { darkVars, lightVars } from "@/lib/theme-css";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const s = await fetchPublicStatus(slug).catch(() => null);
  if (!s) return { title: "Status page not found", robots: { index: false, follow: false } };
  const bits: string[] = [STATE_VIEW[s.state].word];
  if (s.players) bits.push(`${s.players.online}${s.players.max ? ` of ${s.players.max}` : ""} players online`);
  if (s.uptime?.d7 != null) bits.push(`${pct(s.uptime.d7)} uptime over 7 days`);
  const title = `${s.title} status | ${brand.name}`;
  const description = bits.join(" · ");
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false }, // until go-public
    openGraph: { type: "website", siteName: s.branding ? brand.name : s.title, title, description, url: `/s/${slug}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

const scoped = `.status-theme-dark{${darkVars}}.status-theme-light{${lightVars}}`;

export default async function StatusPage({ params }: Props) {
  const { slug } = await params;
  let s;
  try {
    s = await fetchPublicStatus(slug);
  } catch (e) {
    if (e instanceof StatusRateLimited) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-bg p-6 text-fg">
          <div className="max-w-sm text-center">
            <h1 className="text-xl font-semibold">Too many requests</h1>
            <p className="mt-2 text-muted">This status page was loaded a lot from your connection. Please try again in a minute.</p>
          </div>
        </main>
      );
    }
    throw e;
  }
  if (!s) notFound();
  const v = STATE_VIEW[s.state];
  const themeClass = s.theme === "dark" ? "status-theme-dark" : s.theme === "light" ? "status-theme-light" : "";
  const generated = Date.parse(s.generatedAt);
  const uptime = s.uptime
    ? ([["Last 24 hours", s.uptime.d1], ["Last 7 days", s.uptime.d7], ["Last 30 days", s.uptime.d30]] as const)
    : null;

  return (
    <div className={`${themeClass} flex min-h-screen flex-col bg-bg text-fg`}>
      <style dangerouslySetInnerHTML={{ __html: scoped }} />
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-16">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Server status</p>
            <h1 className="mt-1 break-words text-3xl font-bold tracking-tight sm:text-4xl">{s.title}</h1>
          </div>
          {s.theme === "auto" ? <ThemeToggle /> : null}
        </div>

        <section
          aria-labelledby="state-h"
          className="relative mt-8 overflow-hidden rounded-lg border p-6 sm:p-8"
          style={{
            borderColor: `color-mix(in srgb, var(--health-${v.health}) 60%, transparent)`,
            background: `color-mix(in srgb, var(--health-${v.health}) 12%, var(--surface))`,
            color: `var(--health-${v.health}-text)`,
          }}
        >
          <h2 id="state-h" className="sr-only">Current state</h2>
          <div className="flex items-center gap-4 sm:gap-5">
            <HealthIcon state={v.health} size={56} />
            <div>
              <p className="text-3xl font-extrabold tracking-tight sm:text-5xl">{v.word}</p>
              <p className="mt-1 text-base text-fg">{s.title} {v.line}</p>
            </div>
          </div>
        </section>

        <p className="mt-3 text-sm text-muted">
          {s.lastSeenAt ? (
            <>
              Last seen <time dateTime={s.lastSeenAt} title={new Date(s.lastSeenAt).toUTCString()}>{ago(s.lastSeenAt, generated)}</time>.
            </>
          ) : (
            "We haven't heard from this server yet."
          )}
        </p>

        {s.players || uptime ? (
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            {s.players ? (
              <div className="rounded-lg border border-line bg-surface p-4 sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Players online</dt>
                <dd className="mt-1 font-mono text-3xl font-semibold">
                  {s.state === "offline" ? "–" : s.players.online}
                  {s.players.max !== null && s.state !== "offline" ? <span className="ml-1 text-lg font-normal text-muted">/ {s.players.max}</span> : null}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {uptime ? (
          <section aria-labelledby="uptime-h" className="mt-6">
            <h2 id="uptime-h" className="text-lg font-semibold">Uptime</h2>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              {uptime.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line bg-surface p-3 sm:p-4">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold sm:text-2xl">{pct(value) ?? <span className="text-sm font-normal text-muted">Not enough data yet, or not kept on this plan</span>}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">Uptime is the share of time we received data from the server. A server that is online but lagging still counts as up.</p>
          </section>
        ) : null}

        {s.incidents ? (
          <section aria-labelledby="inc-h" className="mt-8">
            <h2 id="inc-h" className="text-lg font-semibold">Recent incidents</h2>
            <p className="text-sm text-muted">Periods of lag in the last 30 days.</p>
            {s.incidents.length === 0 ? (
              <p className="mt-3 rounded-lg border border-line bg-surface p-4 text-sm">No incidents in the last 30 days.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
                {s.incidents.map((i) => {
                  const h = i.severity === "medium" ? "degraded" : "lagging";
                  return (
                    <li key={i.startedAt} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                      <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: `var(--health-${h}-text)` }}>
                        <HealthIcon state={h} size={14} />
                        {{ medium: "Minor", high: "Serious", critical: "Severe" }[i.severity]}
                      </span>
                      <time dateTime={i.startedAt} className="font-mono">
                        {new Date(i.startedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} UTC
                      </time>
                      <span className="text-muted">{i.endedAt ? `Lasted ${duration(i.durationSeconds)}` : `Still going`}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}
      </main>

      <footer className="border-t border-line px-4 py-6 text-center text-sm text-muted sm:px-6">
        {s.branding ? (
          <p>
            Monitored with{" "}
            <Link href="/" className="font-semibold text-accent-text underline underline-offset-2">{brand.name}</Link>
          </p>
        ) : null}
        <p className={s.branding ? "mt-2" : ""}>{brand.legalDisclaimer}</p>
      </footer>
    </div>
  );
}
