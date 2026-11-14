"use client";

import { brand, plans, type Plan, type PlanId } from "@tickdoctor/shared";
import { useEffect, useId, useRef, useState } from "react";
import { WaitlistForm } from "./waitlist-form";

const pitch: Record<PlanId, string> = {
  free: "See that something is wrong and how serious it is, on one server.",
  pro: "For a server you care about: why it lags, the evidence and the fixes, plus more history. Free for everyone during the beta.",
  network: "For small networks and communities running several servers.",
};

function days(n: number) {
  return n === 365 ? "1 year" : n === 1 ? "1 day" : `${n} days`;
}

// Bullets are derived from plans.ts so numbers can't drift; wording follows content/pricing.md.
function bullets(p: Plan): string[] {
  return [
    `${p.servers} ${p.servers === 1 ? "server" : "servers"}`,
    p.findings === "basic"
      ? "Findings: what is wrong, how serious, and when. Why, evidence and fixes are in Pro"
      : "Full findings: why, evidence, fixes, what changed and chunk coordinates",
    "Tuning tips",
    ...(p.discordAlerts ? ["Discord alerts"] : []),
    p.statusPage === "branded" ? `Public status page with ${brand.name} branding` : "Customisable public status page",
    `Incident history for ${days(p.incidentRetentionDays)}`,
    `Detailed graphs for ${days(p.rawRetentionDays)}, hourly trends for ${days(p.rollup1hRetentionDays)}`,
  ];
}

export function PricingPlans() {
  const [selected, setSelected] = useState<Plan | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (selected && !d.open) {
      d.showModal();
      d.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
    }
    if (!selected && d.open) d.close();
  }, [selected, openCount]);

  function openFor(plan: Plan) {
    setOpenCount((n) => n + 1); // remount the form so it starts fresh
    setSelected(plan);
  }

  return (
    <>
      <ul className="grid gap-5 lg:grid-cols-3">
        {Object.values(plans).map((p) => (
          <li
            key={p.id}
            className={`flex flex-col rounded-lg border bg-surface p-6 ${p.id === "pro" ? "border-accent" : "border-line"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-semibold">{p.name}</h2>
              {p.id === "pro" ? (
                <span className="rounded-sm bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg">Most popular</span>
              ) : null}
            </div>
            <p className="mt-4 font-mono">
              <span className="text-4xl font-bold">€{p.priceEurMonthly}</span>
              <span className="text-muted"> / month</span>
            </p>
            <p className="mt-3 text-sm text-muted">{pitch[p.id]}</p>
            {p.id === "pro" ? (
              <p className="mt-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
                Free during the beta. Early-access members get a founding discount when paid plans launch.
              </p>
            ) : null}
            <ul className="mt-6 flex-1 space-y-2.5 text-sm">
              {bullets(p).map((b) => (
                <li key={b} className="flex gap-2.5">
                  <svg className="mt-0.5 shrink-0 text-accent-text" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
                  </svg>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`btn mt-8 ${p.id === "pro" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => openFor(p)}
              aria-haspopup="dialog"
            >
              Join early access
              <span className="sr-only"> for the {p.name} plan</span>
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setSelected(null);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-line bg-surface p-0 text-fg"
      >
        {selected ? (
          <div className="p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <h2 id={titleId} className="text-xl font-semibold">
                {selected.id === "free" ? "Early access isn't open yet" : "Paid plans aren't open yet"}
              </h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <p className="mt-3 text-sm text-muted">
              {selected.id === "free"
                ? "Early access isn't open yet. Leave your email and we'll let you know when you can create your free server."
                : `We're still building ${brand.name} and nothing can be bought today. Leave your email and we'll let you know when ${selected.name} opens. Pro is free for everyone during the beta, and early-access members get a founding discount when paid plans launch.`}
            </p>
            <div className="mt-5">
              <WaitlistForm
                key={openCount}
                source="pricing-dialog"
                buttonLabel="Join early access"
                successMessage="Thanks! You're on the list. We'll email you when early access opens."
                showSmallPrint={false}
                autoFocus
              />
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
