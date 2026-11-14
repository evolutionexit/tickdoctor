import Link from "next/link";

/**
 * Shown where the Free plan withholds content (findings teaser: the why, the evidence, the fix, what changed, chunk
 * coordinates). The data is not in the page at all (the API omits it); this is only the explanation. Icon + the word
 * "Locked" + text, so it never relies on colour. Static content: no layout shift when it appears.
 */
export function LockedPanel({ what, className = "" }: { what: string; className?: string }) {
  return (
    <div role="note" aria-label="Locked on the Free plan" data-testid="locked-panel" className={`rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm sm:p-4 ${className}`}>
      <p className="flex items-center gap-2 font-semibold">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-accent-text">
          <rect x="3" y="7" width="10" height="7" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" />
        </svg>
        Locked on the Free plan
      </p>
      <p className="mt-1 leading-relaxed text-muted">{what}</p>
      <Link href="/pricing" className="btn btn-ghost btn-sm mt-3">
        See what Pro includes
      </Link>
    </div>
  );
}

export const LOCKED_FINDING_COPY = "Upgrade to Pro to see why, the evidence and the fix.";
