"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 sm:px-6" role="alert">
      <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-4 text-muted">This page failed to load. You can try again, or come back in a moment.</p>
      <button type="button" className="btn btn-primary mt-8" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
