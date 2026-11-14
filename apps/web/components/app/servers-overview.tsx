"use client";

import Link from "next/link";
import { friendlyError } from "@/lib/api";
import { planLabel } from "@/lib/plan";
import { useServers } from "@/lib/servers-context";
import { EmptyState, ErrorState, PageTitle, Skeleton } from "../ui";
import { ServerCard } from "./server-card";

export function ServersOverview() {
  const { data, error, loading, reload } = useServers();

  if (!data && loading)
    return (
      <div role="status" aria-label="Loading your servers">
        <PageTitle title="Your servers" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      </div>
    );
  if (!data) return <ErrorState title="Couldn't load your servers" message={friendlyError(error)} onRetry={reload} />;

  const { servers, limits } = data;
  const full = limits.used >= limits.maxServers;
  return (
    <div>
      <PageTitle title="Your servers" sub={`${limits.used} of ${limits.maxServers} server${limits.maxServers === 1 ? "" : "s"} on the ${planLabel(limits.plan, limits.planSource)} plan`}>
        {servers.length > 0 && !full ? (
          <Link href="/app/onboarding" className="btn btn-primary btn-sm">
            Add a server
          </Link>
        ) : null}
      </PageTitle>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-health-lagging">
          Couldn&apos;t refresh just now. Showing the last data we got.
        </p>
      ) : null}
      {servers.length === 0 ? (
        <EmptyState
          title="No servers yet"
          action={
            <Link href="/app/onboarding" className="btn btn-primary">
              Add your first server
            </Link>
          }
        >
          <p>Add the TickDoctor plugin to your Paper server and we&apos;ll start explaining its lag. Setup takes about five minutes.</p>
        </EmptyState>
      ) : (
        <>
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {servers.map((s) => (
              <li key={s.id} className="relative">
                <ServerCard server={s} />
              </li>
            ))}
          </ul>
          {full ? (
            <p className="mt-6 text-sm text-muted">
              You&apos;re using all {limits.maxServers} server{limits.maxServers === 1 ? "" : "s"} on the {planLabel(limits.plan, limits.planSource)} plan.{" "}
              <Link href="/pricing" className="text-accent-text underline underline-offset-2">
                See plans
              </Link>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
