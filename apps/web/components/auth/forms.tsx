"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PASSWORD_MIN } from "@tickdoctor/shared";
import { api, ApiError, friendlyError, safeNext } from "@/lib/api";
import { own } from "@/lib/own";
import { Alert, Field, Spinner } from "../ui";
import { AuthCard, AuthLink, withNext } from "./auth-card";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function CheckEmail({ title, children, back }: { title: string; children: React.ReactNode; back?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <AuthCard title={title} footer={back}>
      <div ref={ref} tabIndex={-1} role="status" className="space-y-3 text-sm outline-none">
        <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--accent-text)" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" />
          <path d="M3 6l9 7 9-7" />
        </svg>
        {children}
      </div>
    </AuthCard>
  );
}

function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}

const LOGIN_ERRORS: Record<string, string> = {
  discord_email_exists: "An account with the email of your Discord account already exists. Log in with your email and password first, then connect Discord from your account page.",
  discord_email: "Discord didn't share a verified email we could match to an account. Verify your email on Discord, or log in with your email and password and link Discord from your account page.",
  discord_failed: "Logging in with Discord didn't work. Please try again, or use your email instead.",
};

export function LoginForm({ next, error }: { next?: string; error?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"" | "login" | "link">("");
  const [msg, setMsg] = useState(error ? (own(LOGIN_ERRORS, error) ?? "") : "");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [discord, setDiscord] = useState(false);
  const target = safeNext(next);

  useEffect(() => {
    api.providers().then((p) => setDiscord(p.discord)).catch(() => undefined);
    api.session().then((s) => { if (s.user) router.replace(target); }).catch(() => undefined);
  }, [router, target]);

  function validEmail() {
    if (EMAIL_RE.test(email.trim())) return true;
    setErrs({ email: "Enter the email address you signed up with." });
    document.getElementById("login-email")?.focus();
    return false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg("");
    setErrs({});
    if (!validEmail()) return;
    if (!password) {
      setErrs({ password: "Enter your password." });
      return;
    }
    setBusy("login");
    try {
      await api.login({ email: email.trim(), password, next: next ? target : undefined });
      router.replace(target);
    } catch (err) {
      setBusy("");
      setErrs(fieldErrors(err));
      setMsg(friendlyError(err, { invalid_credentials: "That email and password don't match. Check them and try again, or reset your password." }));
    }
  }

  async function magic() {
    if (busy) return;
    setMsg("");
    setErrs({});
    if (!validEmail()) return;
    setBusy("link");
    try {
      await api.magicLink({ email: email.trim(), next: next ? target : undefined });
      setSent(true);
    } catch (err) {
      setBusy("");
      setMsg(friendlyError(err));
    }
  }

  if (sent)
    return (
      <CheckEmail title="Check your email" back={<button type="button" className="underline underline-offset-2" onClick={() => { setSent(false); setBusy(""); }}>Back to log in</button>}>
        <p>
          If <strong className="break-all">{email.trim()}</strong> has an account, a login link is on its way. It works once and expires in 15 minutes.
        </p>
        <p className="text-muted">Nothing after a minute or two? Check your spam folder.</p>
      </CheckEmail>
    );

  return (
    <AuthCard
      title="Log in"
      footer={
        <>
          New here? <AuthLink href={withNext("/signup", next)}>Create an account</AuthLink>
        </>
      }
    >
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label="Email" error={errs.email}>
          {(p) => <input {...p} name="email" type="email" inputMode="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Password" error={errs.password}>
          {(p) => <input {...p} name="password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <div className="flex items-center justify-between gap-3 text-sm">
          <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={busy !== ""}>
          {busy === "login" ? "Logging in…" : "Log in"}
        </button>
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-[var(--border)]" /> or <span className="h-px flex-1 bg-[var(--border)]" />
        </div>
        <button type="button" className="btn btn-ghost w-full" onClick={magic} disabled={busy !== ""}>
          {busy === "link" ? "Sending…" : "Email me a login link"}
        </button>
        {discord ? (
          <a className="btn btn-ghost w-full" href={`/api/auth/discord${next ? `?next=${encodeURIComponent(target)}` : ""}`}>
            Continue with Discord
          </a>
        ) : null}
      </form>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer underline underline-offset-2">Never got your confirmation email?</summary>
        <div className="mt-3">
          <ResendForm />
        </div>
      </details>
    </AuthCard>
  );
}

export function SignupForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState("");
  const [discord, setDiscord] = useState(false);
  const target = safeNext(next);

  useEffect(() => {
    api.providers().then((p) => setDiscord(p.discord)).catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg("");
    const local: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim())) local.email = "That doesn't look like an email address.";
    setErrs(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.signup({ email: email.trim(), next: next ? target : undefined });
      setSentTo(email.trim());
    } catch (err) {
      setErrs(fieldErrors(err));
      setMsg(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo)
    return (
      <CheckEmail title="Check your email">
        <p>
          We sent a link to <strong className="break-all">{sentTo}</strong>. Open it to confirm your email and choose your password. It expires in 24 hours.
        </p>
        <p className="text-muted">Nothing after a minute or two? Check your spam folder. If you already had an account, the email will say so and give you a login link.</p>
        <ResendLink email={sentTo} />
      </CheckEmail>
    );

  return (
    <AuthCard
      title="Create your account"
      intro="Free during the beta. No credit card."
      footer={
        <>
          Already have an account? <AuthLink href={withNext("/login", next)}>Log in</AuthLink>
        </>
      }
    >
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label="Email" error={errs.email}>
          {(p) => <input {...p} name="email" type="email" inputMode="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <p className="text-sm text-muted">
          We&apos;ll email you a link to finish creating your account. How we handle your data: <AuthLink href="/legal/privacy">Privacy policy</AuthLink>.
        </p>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        {discord ? (
          <a className="btn btn-ghost w-full" href={`/api/auth/discord${next ? `?next=${encodeURIComponent(target)}` : ""}`}>
            Continue with Discord
          </a>
        ) : null}
      </form>
    </AuthCard>
  );
}

/** "Didn't get it? Send again" for a known email. Same answer whatever the account state. */
function ResendLink({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState("");
  if (state === "sent") return <p role="status">Sent again. If the email is waiting for confirmation, the new link replaces the old one.</p>;
  return (
    <div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={state === "sending"}
        onClick={async () => {
          setState("sending");
          setErr("");
          try {
            await api.resendVerification(email);
            setState("sent");
          } catch (e) {
            setState("idle");
            setErr(friendlyError(e));
          }
        }}
      >
        {state === "sending" ? "Sending…" : "Didn't get it? Send again"}
      </button>
      {err ? <p role="alert" className="mt-2 text-health-lagging">{err}</p> : null}
    </div>
  );
}

/** Email-only form to get a new confirmation link. */
function ResendForm() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(email.trim())) {
      setErr("Enter the email address you signed up with.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.resendVerification(email.trim());
      setSent(true);
    } catch (e2) {
      setErr(friendlyError(e2));
    } finally {
      setBusy(false);
    }
  }
  if (sent) return <p role="status" className="text-sm">If that email is waiting for confirmation, a new link is on its way. Check your spam folder too.</p>;
  return (
    <form method="post" onSubmit={submit} noValidate className="space-y-3">
      <Field label="Your email" error={err}>
        {(p) => <input {...p} name="email" type="email" inputMode="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />}
      </Field>
      <button type="submit" className="btn btn-ghost w-full" disabled={busy}>
        {busy ? "Sending…" : "Send me a new confirmation link"}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg("");
    if (!EMAIL_RE.test(email.trim())) {
      setErr("Enter the email address you signed up with.");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (e2) {
      setMsg(friendlyError(e2));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <CheckEmail title="Check your email" back={<AuthLink href="/login">Back to log in</AuthLink>}>
        <p>
          If <strong className="break-all">{email.trim()}</strong> has an account, we sent a link to choose a new password. It works once and expires in an hour.
        </p>
        <p className="text-muted">Nothing after a minute or two? Check your spam folder.</p>
      </CheckEmail>
    );

  return (
    <AuthCard title="Forgot your password?" intro="Enter your email and we'll send you a link to choose a new one." footer={<AuthLink href="/login">Back to log in</AuthLink>}>
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label="Email" error={err}>
          {(p) => <input {...p} name="email" type="email" inputMode="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [expired, setExpired] = useState(false);

  if (!token || expired)
    return (
      <AuthCard title="This link doesn't work" footer={<AuthLink href="/login">Back to log in</AuthLink>}>
        <p className="text-sm">The reset link is missing, already used, or older than an hour. Links only work once.</p>
        <p className="mt-4">
          <AuthLink href="/forgot-password">Send me a new link</AuthLink>
        </p>
      </AuthCard>
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    setMsg("");
    const local: Record<string, string> = {};
    if (password.length < PASSWORD_MIN) local.password = `Use at least ${PASSWORD_MIN} characters.`;
    if (again !== password) local.again = "The two passwords don't match.";
    setErrs(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      router.replace("/app");
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "invalid_token") return setExpired(true);
      setErrs(fieldErrors(err));
      setMsg(friendlyError(err));
    }
  }

  return (
    <AuthCard title="Choose a new password" intro="You'll be logged in afterwards, and logged out everywhere else.">
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`} error={errs.password}>
          {(p) => <input {...p} name="password" type="password" autoComplete="new-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <Field label="New password again" error={errs.again}>
          {(p) => <input {...p} name="again" type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} required />}
        </Field>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
    </AuthCard>
  );
}

/**
 * Reads the token read-only on load (GET verify-token), never consumes it until the user presses Continue.
 * A confirm link then asks for a password; field errors keep the token usable.
 */
export function VerifyEmail({ token }: { token?: string; kind?: string }) {
  const router = useRouter();
  type St = "checking" | "ready" | "password" | "working" | "done" | "failed" | "missing";
  const [state, setState] = useState<St>(token ? "checking" : "missing");
  const [message, setMessage] = useState("");
  const [info, setInfo] = useState<{ kind: "verify" | "magic"; needsPassword: boolean } | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const magic = info?.kind === "magic";

  useEffect(() => {
    if (!token) return;
    let stop = false;
    (async () => {
      const [sess, tok] = await Promise.allSettled([api.session(), api.verifyToken(token)]);
      if (stop) return;
      if (tok.status === "rejected") {
        setState("failed");
        setMessage(tok.reason instanceof ApiError && tok.reason.code === "invalid_token" ? "" : friendlyError(tok.reason));
        return;
      }
      setInfo(tok.value);
      setSignedInAs(sess.status === "fulfilled" ? (sess.value.user?.email ?? null) : null);
      setState("ready");
    })();
    return () => {
      stop = true;
    };
  }, [token]);

  function post(extra?: { password: string; consent: true; displayName?: string }) {
    if (!token) return;
    setState("working");
    api
      .verify(token, extra)
      .then((s) => {
        setState("done");
        const t = safeNext(s.next);
        setTimeout(() => router.replace(t), 1200);
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.fields?.password || e.fields?.consent || e.fields?.displayName)) {
          setErrs(e.fields);
          setState("password");
          return;
        }
        setState("failed");
        setMessage(e instanceof ApiError && e.code === "invalid_token" ? "" : friendlyError(e));
      });
  }

  function cont() {
    if (info?.kind === "verify" && info.needsPassword) setState("password");
    else post();
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const local: Record<string, string> = {};
    if (password.length < PASSWORD_MIN) local.password = `Use at least ${PASSWORD_MIN} characters. A few random words work well.`;
    else if (password !== again) local.again = "The two passwords don't match.";
    if (!consent) local.consent = "Please tick the box to continue.";
    setErrs(local);
    if (Object.keys(local).length) return;
    post({ password, consent: true, displayName: name.trim() || undefined });
  }

  if (state === "checking" || state === "working")
    return (
      <AuthCard title={magic ? "Logging you in" : "Checking your link"}>
        <Spinner label="One moment" />
      </AuthCard>
    );
  if (state === "ready")
    return (
      <AuthCard title={magic ? "Log in with this link" : "Confirm your email"}>
        <div className="space-y-4 text-sm">
          {signedInAs ? (
            <p>
              You&apos;re signed in as <strong className="break-all">{signedInAs}</strong>. Continue as the account from this link?
            </p>
          ) : (
            <p>{magic ? "Press the button to log in." : "Press the button to confirm your email address."}</p>
          )}
          <button type="button" className="btn btn-primary w-full" onClick={cont}>
            Continue
          </button>
          {signedInAs ? (
            <a href="/app" className="btn btn-ghost w-full">
              Cancel
            </a>
          ) : null}
        </div>
      </AuthCard>
    );
  if (state === "password")
    return (
      <AuthCard title="Choose your password" intro="Your email is confirmed once you save it. You'll be logged in right after.">
        <form method="post" onSubmit={submitPassword} noValidate className="space-y-4">
          {msg ? <Alert>{msg}</Alert> : null}
          <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`} error={errs.password}>
            {(p) => <input {...p} name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} className="input" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />}
          </Field>
          <Field label="New password again" error={errs.again}>
            {(p) => <input {...p} name="again" type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} required />}
          </Field>
          <Field label="Name (optional)" error={errs.displayName}>
            {(p) => <input {...p} name="name" type="text" autoComplete="nickname" maxLength={60} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="consent"
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                required
                aria-invalid={errs.consent ? true : undefined}
                aria-describedby={errs.consent ? "consent-err" : undefined}
              />
              <span>
                I agree to the <AuthLink href="/legal/terms">Terms</AuthLink> and the <AuthLink href="/legal/privacy">Privacy policy</AuthLink>.
              </span>
            </label>
            {errs.consent ? (
              <p id="consent-err" role="alert" className="mt-1 text-sm text-health-lagging">
                {errs.consent}
              </p>
            ) : null}
          </div>
          <button type="submit" className="btn btn-primary w-full">
            Save password and log in
          </button>
        </form>
      </AuthCard>
    );
  if (state === "done")
    return (
      <AuthCard title={magic ? "You're logged in" : "Email verified"}>
        <div role="status" className="space-y-4 text-sm">
          <p>Taking you to your dashboard…</p>
          <a href="/app" className="btn btn-primary w-full">Go to dashboard</a>
        </div>
      </AuthCard>
    );
  return (
    <AuthCard title="This link doesn't work" footer={<AuthLink href="/login">Back to log in</AuthLink>}>
      <div className="space-y-4 text-sm">
        <div role="alert" className="space-y-2">
          {message ? <p>{message}</p> : <p>The link is missing, already used, or expired. Links only work once.</p>}
        </div>
        <p>Request a new one:</p>
        <ResendForm />
        <p className="text-muted">
          Already confirmed? <AuthLink href="/login">Log in</AuthLink> or ask for a login link there.
        </p>
      </div>
    </AuthCard>
  );
}

/** /signup/discord: finish a Discord sign-up (pending row in a cookie). Consent is recorded here. */
export function DiscordComplete({ next }: { next?: string }) {
  const router = useRouter();
  type St = "checking" | "ready" | "working" | "expired" | "error";
  const [state, setState] = useState<St>("checking");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let stop = false;
    api
      .discordPending()
      .then((r) => {
        if (stop) return;
        setEmail(r.email);
        setState("ready");
      })
      .catch((e) => {
        if (stop) return;
        if (e instanceof ApiError && (e.status === 404 || e.code === "not_found" || e.code === "invalid_token")) return setState("expired");
        setMsg(friendlyError(e));
        setState("error");
      });
    return () => {
      stop = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "working") return;
    setMsg("");
    if (!consent) {
      setErrs({ consent: "Please tick the box to continue." });
      return;
    }
    setErrs({});
    setState("working");
    try {
      const s = await api.discordComplete({ consent: true, displayName: name.trim() || undefined });
      router.replace(safeNext(s.next));
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_token") return setState("expired");
      setErrs(fieldErrors(err));
      setMsg(friendlyError(err));
      setState("ready");
    }
  }

  if (state === "checking")
    return (
      <AuthCard title="Finish creating your account">
        <Spinner label="One moment" />
      </AuthCard>
    );
  if (state === "expired" || state === "error")
    return (
      <AuthCard title={state === "expired" ? "This sign-up has expired" : "Something went wrong"} footer={<AuthLink href={withNext("/login", next)}>Back to log in</AuthLink>}>
        <div className="space-y-4 text-sm">
          <p role="alert">{state === "expired" ? "The Discord sign-up timed out or was already used. It only takes a moment to start again." : msg}</p>
          <a className="btn btn-primary w-full" href={`/api/auth/discord${next ? `?next=${encodeURIComponent(safeNext(next))}` : ""}`}>
            Try again with Discord
          </a>
          <p>
            Or <AuthLink href={withNext("/signup", next)}>sign up with email</AuthLink> instead.
          </p>
        </div>
      </AuthCard>
    );
  return (
    <AuthCard title="Finish creating your account" intro="One last step. Your account is created when you press the button.">
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label="Email">
          {(p) => <input {...p} name="email" type="email" className="input" value={email} readOnly />}
        </Field>
        <Field label="Name (optional)" error={errs.displayName}>
          {(p) => <input {...p} name="name" type="text" autoComplete="nickname" maxLength={60} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="consent"
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              required
              aria-invalid={errs.consent ? true : undefined}
              aria-describedby={errs.consent ? "consent-err" : undefined}
            />
            <span>
              I agree to the <AuthLink href="/legal/terms">Terms</AuthLink> and the <AuthLink href="/legal/privacy">Privacy policy</AuthLink>.
            </span>
          </label>
          {errs.consent ? (
            <p id="consent-err" role="alert" className="mt-1 text-sm text-health-lagging">
              {errs.consent}
            </p>
          ) : null}
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={state === "working"}>
          {state === "working" ? "Creating…" : "Create account"}
        </button>
      </form>
    </AuthCard>
  );
}
