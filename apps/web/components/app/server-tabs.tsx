"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { slug: "", label: "Dashboard" },
  { slug: "/incidents", label: "Incidents" },
  { slug: "/findings", label: "Findings" },
  { slug: "/alerts", label: "Alerts" },
  { slug: "/status-page", label: "Status page" },
  { slug: "/settings", label: "Settings" },
] as const;

/** Sub-navigation shared by every /app/servers/[id]/* page. Scrolls sideways on a phone instead of wrapping. */
export function ServerTabs({ id, base: baseOverride, only }: { id?: string; base?: string; only?: readonly string[] }) {
  const pathname = usePathname();
  const base = baseOverride ?? `/app/servers/${id}`;
  const tabs = only ? TABS.filter((t) => only.includes(t.slug)) : TABS;
  return (
    <nav aria-label="Server sections" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1">
        {tabs.map((t) => {
          const href = base + t.slug;
          const active = t.slug === "" ? pathname === base : pathname.startsWith(href);
          return (
            <li key={t.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${
                  active ? "border-[var(--accent)] text-fg" : "border-transparent text-muted hover:text-fg"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
