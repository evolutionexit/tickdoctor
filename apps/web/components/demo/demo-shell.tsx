"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createDemoApi } from "@/lib/demo";
import { loadDemoDataset } from "@/lib/demo-source";
import { ServerEnvProvider, type ServerEnv } from "@/lib/server-env";
import { ErrorState, Skeleton } from "../ui";
import { ServerTabs } from "../app/server-tabs";
import { DEMO_SERVER_ID } from "@/lib/demo";

const DAY = 86_400_000;

/** Wraps /demo/*: banner, tabs, and the read-only env fed by the static dataset (times shifted so the anchor = now). */
export function DemoShell({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ env: ServerEnv; name: string } | "error" | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadDemoDataset()
      .then((ds) => {
        if (cancelled) return;
        const { api, serverName } = createDemoApi(ds);
        setState({ name: serverName, env: { demo: true, api, base: () => "/demo", maxRangeMs: 7 * DAY, serverName } });
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, []);
  const env = useMemo(() => (state && state !== "error" ? state.env : null), [state]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div role="note" className="mb-6 rounded-md border border-line bg-surface p-4 text-sm">
        <strong className="text-accent-text">Demo:</strong> a made-up server name with real data from our test server.{" "}
        <Link href="/signup" className="font-semibold text-accent-text underline underline-offset-2">Sign up to see yours.</Link>
      </div>
      <ServerTabs id={DEMO_SERVER_ID} base="/demo" only={["", "/incidents", "/findings"]} />
      {state === "error" ? (
        <ErrorState title="Couldn't load the demo" message="The demo data didn't load. Reload the page to try again." onRetry={() => window.location.reload()} />
      ) : env ? (
        <ServerEnvProvider value={env}>{children}</ServerEnvProvider>
      ) : (
        <div role="status" aria-label="Loading the demo" className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>
          <Skeleton className="h-64" />
        </div>
      )}
    </div>
  );
}
