"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { navLinks } from "@/lib/site";

export function Header() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Home" className="shrink-0 rounded">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
          {navLinks.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm text-muted hover:text-fg">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className="btn btn-ghost btn-sm">
            Log in
          </Link>
          <Link href="/signup" className="btn btn-ghost btn-sm hidden sm:inline-flex">
            Sign up
          </Link>
          <Link href="/#waitlist" className="btn btn-primary btn-sm hidden sm:inline-flex">
            Join waitlist
          </Link>
          <button
            ref={buttonRef}
            type="button"
            className="btn btn-ghost btn-sm !px-2.5 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {open ? <path d="M5 5l14 14M19 5L5 19" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      <div id="mobile-menu" hidden={!open} className="border-t border-line bg-bg md:hidden">
        <nav aria-label="Mobile" className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6">
          {navLinks.map((l) => (
            <Link key={l.href} href={l.href} className="rounded py-3 text-base text-fg" onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
          <Link href="/signup" className="rounded py-3 text-base text-fg" onClick={() => setOpen(false)}>
            Sign up
          </Link>
          <Link href="/login" className="rounded py-3 text-base text-fg" onClick={() => setOpen(false)}>
            Log in
          </Link>
          <Link href="/#waitlist" className="btn btn-primary my-2" onClick={() => setOpen(false)}>
            Join waitlist
          </Link>
        </nav>
      </div>
    </header>
  );
}
