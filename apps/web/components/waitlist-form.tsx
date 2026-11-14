"use client";

import { brand } from "@tickdoctor/shared";
import { useEffect, useId, useRef, useState } from "react";

export type WaitlistSource = "landing-hero" | "landing-footer" | "pricing-dialog";

const MESSAGES = {
  invalid_email: "That doesn't look like an email address. Could you check it?",
  consent_required: "Please tick the box so we know it's OK to email you.",
  rate_limited: "Too many tries from your connection. Please wait a minute and try again.",
  generic: "Something went wrong on our side. Please try again in a moment.",
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Status = "idle" | "submitting" | "success";

interface Props {
  source: WaitlistSource;
  buttonLabel?: string;
  /** Show a visible label above the email field (otherwise it is visually hidden). */
  visibleLabel?: string;
  successTitle?: string;
  successMessage?: string;
  showSmallPrint?: boolean;
  /** Called when the email field should receive focus first (e.g. dialog). */
  autoFocus?: boolean;
}

export function WaitlistForm({
  source,
  buttonLabel = "Join the waitlist",
  visibleLabel,
  successTitle = "You're on the list.",
  successMessage = "Thanks! We'll email you when early access opens. No spam, and you can ask us to remove your email at any time.",
  showSmallPrint = true,
  autoFocus = false,
}: Props) {
  const uid = useId();
  const emailId = `${uid}-email`;
  const emailErrId = `${uid}-email-err`;
  const consentId = `${uid}-consent`;
  const consentErrId = `${uid}-consent-err`;
  const formErrId = `${uid}-form-err`;

  const statusRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [emailError, setEmailError] = useState("");
  const [consentError, setConsentError] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (status === "success") statusRef.current?.focus();
  }, [status]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    const trimmed = email.trim();
    const eErr = EMAIL_RE.test(trimmed) && trimmed.length <= 254 ? "" : MESSAGES.invalid_email;
    const cErr = consent ? "" : MESSAGES.consent_required;
    setEmailError(eErr);
    setConsentError(cErr);
    setFormError("");
    if (eErr || cErr) {
      document.getElementById(eErr ? emailId : consentId)?.focus();
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source, website, consent: true }),
      });
      if (res.ok) {
        setStatus("success");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      setStatus("idle");
      if (res.status === 429 || code === "rate_limited") setFormError(MESSAGES.rate_limited);
      else if (code === "invalid_email") {
        setEmailError(MESSAGES.invalid_email);
        document.getElementById(emailId)?.focus();
      } else if (code === "consent_required") {
        setConsentError(MESSAGES.consent_required);
        document.getElementById(consentId)?.focus();
      } else setFormError(MESSAGES.generic);
    } catch {
      setStatus("idle");
      setFormError(MESSAGES.generic);
    }
  }

  if (status === "success") {
    return (
      <div ref={statusRef} tabIndex={-1} role="status" className="rounded-md border border-line bg-surface p-4 outline-none">
        <p className="flex items-center gap-2 font-semibold text-accent-text">
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
          </svg>
          {successTitle}
        </p>
        <p className="mt-1 text-sm text-muted">{successMessage}</p>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="w-full">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label htmlFor={emailId} className={visibleLabel ? "mb-1.5 block text-sm font-medium" : "sr-only"}>
            {visibleLabel ?? "Email address"}
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus={autoFocus}
            placeholder="you@example.com"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? emailErrId : undefined}
            disabled={submitting}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary shrink-0 sm:self-end" aria-disabled={submitting || undefined}>
          {submitting ? "Joining…" : buttonLabel}
        </button>
      </div>
      <p id={emailErrId} aria-live="polite" className="mt-1.5 min-h-0 text-sm text-health-lagging">
        {emailError}
      </p>

      {/* Honeypot: real users never see or fill this. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
        <label>
          Website
          <input
            type="text"
            name="hp_field"
            id={`${uid}-hp`}
            tabIndex={-1}
            autoComplete="new-password"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>

      <div className="mt-2 flex items-start gap-2.5">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          aria-invalid={consentError ? true : undefined}
          aria-describedby={consentError ? consentErrId : undefined}
          disabled={submitting}
          required
          className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--accent)]"
        />
        <label htmlFor={consentId} className="cursor-pointer text-sm">
          Email me about early access to {brand.name}. You can ask us to remove your email at any time.
        </label>
      </div>
      <p className="mt-1 pl-[1.875rem] text-sm">
        <a href="/legal/privacy" className="text-accent-text underline underline-offset-2">
          How we handle your email
        </a>
      </p>
      <p id={consentErrId} aria-live="polite" className="mt-1.5 text-sm text-health-lagging">
        {consentError}
      </p>
      <p id={formErrId} role="alert" className="mt-1.5 text-sm text-health-lagging">
        {formError}
      </p>

      {showSmallPrint ? (
        <p className="mt-3 text-sm text-muted">
          Free during the beta. No credit card. We only use your email to tell you about early access, and you can
          ask us to remove your email at any time.
        </p>
      ) : null}
    </form>
  );
}
