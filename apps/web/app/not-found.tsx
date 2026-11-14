import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 sm:px-6">
      <p className="font-mono text-sm text-accent-text">404</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Page not found</h1>
      <p className="mt-4 text-muted">We couldn&apos;t find that page. It may have moved, or the link may be wrong.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/" className="btn btn-primary">Back to the home page</Link>
        <Link href="/pricing" className="btn btn-ghost">See pricing</Link>
      </div>
    </div>
  );
}
