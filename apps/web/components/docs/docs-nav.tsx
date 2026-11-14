"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export interface NavItem {
  href: string;
  title: string;
  group: string;
}

/** Docs sidebar: always visible from md up, a toggle button on a phone. */
export function DocsNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const groups = [...new Set(items.map((i) => i.group))];
  const current = items.find((i) => i.href === pathname);

  return (
    <div className="md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto md:pr-2">
      <button
        type="button"
        className="btn btn-ghost w-full justify-between md:hidden"
        aria-expanded={open}
        aria-controls="docs-nav"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current ? current.title : "Docs menu"}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d={open ? "M3 10l5-5 5 5" : "M3 6l5 5 5-5"} />
        </svg>
      </button>
      <nav id="docs-nav" aria-label="Docs" className={`${open ? "block" : "hidden"} mt-3 space-y-6 md:mt-0 md:block`}>
        {groups.map((g) => (
          <div key={g}>
            <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">{g}</h2>
            <ul className="mt-2 space-y-0.5">
              {items.filter((i) => i.group === g).map((i) => {
                const active = i.href === pathname;
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded px-2 py-1.5 text-sm ${active ? "bg-surface-2 font-semibold text-fg" : "text-muted hover:text-fg"}`}
                    >
                      {i.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <ul>
          <li>
            <Link href="/changelog" className="block rounded px-2 py-1.5 text-sm text-muted hover:text-fg">Changelog</Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
