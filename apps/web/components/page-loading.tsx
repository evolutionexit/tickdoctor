export function PageLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="grid max-w-md animate-pulse gap-3" aria-hidden="true">
        <div className="h-8 w-3/4 rounded bg-surface-2" />
        <div className="h-4 w-full rounded bg-surface-2" />
        <div className="h-4 w-5/6 rounded bg-surface-2" />
      </div>
    </div>
  );
}
