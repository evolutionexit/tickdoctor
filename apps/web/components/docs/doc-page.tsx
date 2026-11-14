import Link from "next/link";
import { Markdown } from "../markdown";
import { docNav, readDoc } from "@/lib/docs";

/** One docs page: title, lead, rendered Markdown (or a "Coming soon" stub), prev/next. */
export async function DocPage({ href, file, fallbackTitle }: { href: string; file: string; fallbackTitle: string }) {
  const [doc, nav] = await Promise.all([readDoc(file, fallbackTitle), docNav()]);
  const idx = nav.findIndex((n) => n.href === href);
  const prev = idx > 0 ? nav[idx - 1] : undefined;
  const next = idx >= 0 ? nav[idx + 1] : undefined;
  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{doc.title}</h1>
      {doc.description ? <p className="mt-3 text-lg text-muted">{doc.description}</p> : null}
      <div className="mt-8">
        {doc.missing ? (
          <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center" role="status">
            <p className="text-lg font-semibold">Coming soon</p>
            <p className="mt-1 text-sm text-muted">We&apos;re still writing this page. Check back shortly.</p>
            <Link href="/docs" className="btn btn-ghost btn-sm mt-4">Back to the docs</Link>
          </div>
        ) : (
          <Markdown md={doc.body} variant="doc" />
        )}
      </div>
      {prev || next ? (
        <nav aria-label="Previous and next" className="mt-12 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={prev.href} rel="prev" className="rounded-lg border border-line bg-surface p-4 hover:bg-surface-2">
              <span className="text-xs uppercase tracking-wide text-muted">Previous</span>
              <span className="mt-1 block font-semibold">← {prev.title}</span>
            </Link>
          ) : <span />}
          {next ? (
            <Link href={next.href} rel="next" className="rounded-lg border border-line bg-surface p-4 text-right hover:bg-surface-2 sm:col-start-2">
              <span className="text-xs uppercase tracking-wide text-muted">Next</span>
              <span className="mt-1 block font-semibold">{next.title} →</span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}
