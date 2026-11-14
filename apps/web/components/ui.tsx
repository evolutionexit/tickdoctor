"use client";

import { useEffect, useId, useRef, useState } from "react";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (p: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => React.ReactNode;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1 text-sm text-health-lagging">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({
  tone = "error",
  title,
  children,
  className = "",
}: {
  tone?: "error" | "info" | "success" | "warn";
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const color = { error: "lagging", info: "waiting", success: "healthy", warn: "degraded" }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-4 py-3 text-sm ${className}`}
      style={{
        borderColor: `color-mix(in srgb, var(--health-${color}) 55%, transparent)`,
        background: `color-mix(in srgb, var(--health-${color}) 10%, transparent)`,
      }}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : ""}>{children}</div> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M12 3a9 9 0 019 9" strokeLinecap="square" />
      </svg>
      {label}…
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

export function ErrorState({ message, onRetry, title = "Couldn't load this" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm mt-4" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-dashed border-line bg-surface p-8 text-center sm:p-12">
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative">
        <h2 className="text-xl font-semibold">{title}</h2>
        {children ? <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div> : null}
        {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className = "btn btn-ghost btn-sm" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        ta.remove();
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <>
      <button type="button" className={className} onClick={copy}>
        {copied ? "Copied" : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}

export function CodeBlock({ text, label, copyLabel = "Copy" }: { text: string; label: string; copyLabel?: string }) {
  return (
    <div className="rounded-md border border-line bg-bg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <CopyButton text={text} label={copyLabel} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-sm leading-relaxed" tabIndex={0} aria-label={label}>
        {text}
      </pre>
    </div>
  );
}

/** Modal built on the native <dialog>: focus trap, Escape and backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-line bg-surface p-0 text-fg"
    >
      {open ? (
        <div className="p-5">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-3">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line bg-surface p-4 sm:p-5 ${className}`}>{children}</section>;
}

export function PageTitle({ title, children, sub }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      </div>
      {children}
    </div>
  );
}
