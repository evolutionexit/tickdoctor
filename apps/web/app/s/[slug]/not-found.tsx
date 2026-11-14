import Link from "next/link";
import type { Metadata } from "next";
import { brand } from "@tickdoctor/shared";

export const metadata: Metadata = { title: "Status page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-24 sm:px-6">
      <p className="font-mono text-sm text-accent-text">404</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Status page not found</h1>
      <p className="mt-4 text-muted">There is no status page at this address. It may have been turned off, or the link is wrong.</p>
      <div className="mt-8">
        <Link href="/" className="btn btn-ghost">Go to {brand.name}</Link>
      </div>
      <p className="mt-16 text-sm text-muted">{brand.legalDisclaimer}</p>
    </main>
  );
}
