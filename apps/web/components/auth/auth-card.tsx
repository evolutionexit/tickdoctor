import Link from "next/link";

export function AuthCard({ title, intro, children, footer }: { title: string; intro?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-80" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-md px-4 py-12 sm:py-16">
        <div className="rounded-lg border border-line bg-surface p-5 shadow-lg shadow-black/10 sm:p-7">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {intro ? <p className="mt-2 text-sm text-muted">{intro}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <p className="mt-5 text-center text-sm text-muted">{footer}</p> : null}
      </div>
    </div>
  );
}

export function withNext(path: string, next?: string) {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

export function AuthLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-accent-text underline underline-offset-2">
      {children}
    </Link>
  );
}
