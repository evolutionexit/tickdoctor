"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGate, useAuth } from "@/lib/auth";
import { ServersProvider, useServers } from "@/lib/servers-context";
import { Logo } from "../logo";
import { ThemeToggle } from "../theme-toggle";
import { Skeleton } from "../ui";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate
      loading={
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-8 sm:px-6" role="status" aria-label="Loading your account">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      <ServersProvider>
        <Shell>{children}</Shell>
      </ServersProvider>
    </AuthGate>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const link = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded px-2.5 py-1.5 text-sm font-medium ${active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
    >
      {label}
    </Link>
  );
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-fg"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <Link href="/app" aria-label="Dashboard home" className="shrink-0 rounded">
            <Logo />
          </Link>
          <nav aria-label="App" className="order-3 flex w-full items-center gap-1 sm:order-none sm:w-auto">
            {link("/app", "Servers", pathname === "/app" || pathname.startsWith("/app/servers") || pathname.startsWith("/app/onboarding"))}
            {link("/app/account", "Account", pathname.startsWith("/app/account"))}
            <ServerSwitcher />
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-[14rem] truncate text-sm text-muted md:inline" title={user.email}>
              {user.displayName ?? user.email}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </>
  );
}

function ServerSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const { data } = useServers();
  const current = pathname.match(/^\/app\/servers\/([^/]+)/)?.[1] ?? "";
  const [choice, setChoice] = useState(current);
  useEffect(() => setChoice(current), [current]);
  if (!data || data.servers.length === 0) return null;
  return (
    <div className="ml-auto sm:ml-2">
      <label htmlFor="server-switcher" className="sr-only">
        Switch server
      </label>
      <select
        id="server-switcher"
        className="input !min-h-9 max-w-[12rem] !py-1 text-sm"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        {current ? null : <option value="">Switch server…</option>}
        {data.servers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value="__new">Add a server…</option>
      </select>
      <button
        type="button"
        className="btn btn-ghost btn-sm ml-1"
        disabled={!choice || choice === current}
        onClick={() => router.push(choice === "__new" ? "/app/onboarding" : `/app/servers/${choice}`)}
      >
        Go
      </button>
    </div>
  );
}
