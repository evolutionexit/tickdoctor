import type { Metadata } from "next";
import Link from "next/link";
import { brand } from "@tickdoctor/shared";

export const metadata: Metadata = { title: `Account deleted | ${brand.name}`, robots: { index: false, follow: false } };

// Copy: apps/web/content/phase8-copy.md
export default function GoodbyePage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center sm:py-28">
      <h1 className="text-3xl font-bold tracking-tight">Your account has been deleted</h1>
      <p className="mt-4 text-muted">
        Your account, your servers and all their data are gone. We&apos;ve sent you a short email to confirm. If you still have the plugin installed, remove it or clear <code>api-key</code> in its config; it will stop sending data on its own because its key no longer works.
      </p>
      <p className="mt-2 text-sm text-muted">Alert messages already posted in Discord stay there.</p>
      <Link href="/" className="btn btn-primary mt-8">
        Back to the home page
      </Link>
      <p className="mt-8 text-sm text-muted">
        Anything we could have done better? Write to <a className="text-accent-text underline underline-offset-2" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>. We read everything.
      </p>
    </div>
  );
}
