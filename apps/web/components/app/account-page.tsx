"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PASSWORD_MIN, brand } from "@tickdoctor/shared";
import { api, ApiError, downloadAccountExport, friendlyError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { own } from "@/lib/own";
import { userPlanLabel } from "@/lib/plan";
import { Alert, Card, Dialog, Field, PageTitle } from "../ui";

// Copy: apps/web/content/phase8-copy.md
const COPY = {
  betaNote:
    "During the beta every account gets Pro for free. When the beta ends, accounts go back to Free unless you upgrade, and the founding discount applies when you do. We'll announce the date, and we'll email you well before it. Free keeps less history (detailed samples 1 day, per-minute averages 3 days, hourly averages and incidents 7 days), so history older than that will be trimmed when the beta ends.",
  exportHint: "Downloads one JSON file with everything we hold about your account and your servers: account details, servers, incidents, findings, alerts, status page settings and history, and your waitlist entry if you have one. It never includes password hashes, API key hashes or your Discord webhook address.",
  deleteIntro: "This permanently deletes your account and everything in it. It happens immediately and can't be undone. There is no grace period and we can't bring anything back, so export your data first if you want a copy.",
  deleteList: ["All your servers and their full history", "Incidents and findings", "Alert settings and the alert log", "Status pages (their web addresses become free again)", "API keys (the plugin stops sending data)", "Your Discord link", "Your waitlist entry, if you signed up with this email", "Your account and login sessions"],
  deleteDiscord: "Alert messages already posted in your Discord channel stay in Discord. We can't remove them from there. You can delete the webhook in Discord if you want.",
  deleteGeneric: `Something went wrong and your account was not deleted. Please try again, or write to ${brand.supportEmail}.`,
};

const ACCOUNT_ERRORS: Record<string, string> = {
  discord_in_use: "That Discord account is already linked to a different TickDoctor account. Log in there and unlink it first, or use another Discord account.",
  discord_failed: "Linking Discord didn't work. Please try again.",
};

export function AccountPage({ error }: { error?: string }) {
  const { user, setUser, logout } = useAuth();
  const [discordAvailable, setDiscordAvailable] = useState(false);
  useEffect(() => {
    api.providers().then((p) => setDiscordAvailable(p.discord)).catch(() => undefined);
  }, []);

  const linkError = error ? own(ACCOUNT_ERRORS, error) : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="Account" />
      {linkError ? <Alert title="Discord isn't linked">{linkError}</Alert> : null}
      <ProfileCard />

      <Card>
        <h2 className="text-lg font-semibold">Sign-in</h2>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Email</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2 break-all">
              {user.email}
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: `var(--health-${user.emailVerified ? "healthy" : "degraded"}-text)` }}>
                {user.emailVerified ? "✓ Verified" : "▪ Not verified yet"}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Plan</dt>
            <dd className="mt-0.5">
              {userPlanLabel(user)} ·{" "}
              <Link href="/pricing" className="text-accent-text underline underline-offset-2">
                See plans and limits
              </Link>
              {user.planSource === "beta" ? (
                <span className="mt-2 block rounded-md border border-line bg-surface-2 p-3 text-muted">
                  <strong className="block text-fg">About the beta</strong>
                  {COPY.betaNote}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Discord</dt>
            <dd className="mt-0.5">
              {user.discordLinked ? (
                "Linked. You can use it to log in."
              ) : discordAvailable ? (
                <a className="btn btn-ghost btn-sm" href="/api/auth/discord?link=1">
                  Link Discord
                </a>
              ) : (
                <span className="text-muted">Not linked.</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <PasswordCard hasPassword={user.hasPassword} onChanged={() => setUser({ ...user, hasPassword: true })} />

      <Card>
        <h2 className="text-lg font-semibold">Log out</h2>
        <p className="mt-1 text-sm text-muted">&ldquo;Everywhere&rdquo; also ends your sessions on other devices.</p>
        <LogoutButtons onLogout={logout} />
      </Card>

      <ExportCard />
      <DeleteCard />
    </div>
  );
}

function LogoutButtons({ onLogout }: { onLogout: (everywhere?: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go(everywhere: boolean) {
    setBusy(true);
    setErr("");
    try {
      await onLogout(everywhere);
    } catch (e) {
      setBusy(false);
      setErr(friendlyError(e));
    }
  }
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => go(false)}>
          Log out
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => go(true)}>
          Log out everywhere
        </button>
      </div>
      {err ? <p role="alert" className="mt-2 text-sm text-health-lagging">{err}</p> : null}
    </>
  );
}

function ProfileCard() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setErr("");
    try {
      const r = await api.updateAccount(name.trim() || null);
      setUser(r.user);
      setSaved(true);
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.fields?.displayName ? e2.fields.displayName : friendlyError(e2));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">Profile</h2>
      <form method="post" onSubmit={save} noValidate className="mt-3 space-y-3">
        <Field label="Display name" hint="Optional. Only you see it." error={err}>
          {(p) => <input {...p} className="input" maxLength={60} autoComplete="nickname" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />}
        </Field>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <span role="status" className="text-sm text-muted">{saved ? "Saved." : ""}</span>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard({ hasPassword, onChanged }: { hasPassword: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg("");
    setDone(false);
    const local: Record<string, string> = {};
    if (hasPassword && !current) local.currentPassword = "Enter your current password.";
    if (next.length < PASSWORD_MIN) local.newPassword = `Use at least ${PASSWORD_MIN} characters.`;
    if (again !== next) local.again = "The two passwords don't match.";
    setErrs(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: hasPassword ? current : undefined, newPassword: next });
      setDone(true);
      setCurrent("");
      setNext("");
      setAgain("");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrs(err.fields);
      else {
        setErrs({});
        setMsg(friendlyError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">{hasPassword ? "Change password" : "Set a password"}</h2>
      {!hasPassword ? <p className="mt-1 text-sm text-muted">You log in with an email link or Discord. Add a password if you also want to log in the usual way.</p> : null}
      <form method="post" onSubmit={save} noValidate className="mt-3 space-y-3">
        {msg ? <Alert>{msg}</Alert> : null}
        {done ? <Alert tone="success">Password saved. Your other devices were logged out.</Alert> : null}
        {hasPassword ? (
          <Field label="Current password" error={errs.currentPassword}>
            {(p) => <input {...p} type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`} error={errs.newPassword}>
          {(p) => <input {...p} type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label="New password again" error={errs.again}>
          {(p) => <input {...p} type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} />}
        </Field>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
        </button>
      </form>
    </Card>
  );
}

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  async function go() {
    setBusy(true);
    setErr("");
    setDone(false);
    try {
      await downloadAccountExport();
      setDone(true);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 429
          ? "You've asked for a few exports already. Please try again in an hour."
          : "We couldn't prepare your file. Please try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">Your data</h2>
      <p className="mt-1 text-sm text-muted">{COPY.exportHint}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-busy={busy} onClick={() => void go()}>
          {busy ? "Preparing your file…" : "Export my data"}
        </button>
        <span role="status" className="text-sm text-muted">{busy ? "Large histories can take a moment." : done ? "Your file is downloading. Large histories can take a moment." : ""}</span>
      </div>
      {err ? <p role="alert" className="mt-2 text-sm text-health-lagging">{err}</p> : null}
    </Card>
  );
}

function DeleteCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border-2 p-4 sm:p-5" style={{ borderColor: "color-mix(in srgb, var(--health-lagging) 60%, transparent)" }} aria-labelledby="danger-title">
      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--health-lagging-text)" }}>Danger zone</p>
      <h2 id="danger-title" className="mt-1 text-lg font-semibold">Delete my account</h2>
      <p className="mt-1 text-sm">{COPY.deleteIntro}</p>
      <p className="mt-3 text-sm font-medium">What gets deleted</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
        {COPY.deleteList.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">{COPY.deleteDiscord}</p>
      <button type="button" className="btn btn-danger btn-sm mt-4" onClick={() => setOpen(true)}>
        Delete my account
      </button>
      <DeleteDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

function DeleteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!open) {
      setEmail("");
      setPassword("");
      setErrs({});
      setMsg("");
    }
  }, [open]);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (email.trim().toLowerCase() !== user.email.toLowerCase()) local.confirmEmail = "That doesn't match your account's email address.";
    if (user.hasPassword && !password) local.password = "Enter your password.";
    setErrs(local);
    setMsg("");
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.deleteAccount({ confirmEmail: email.trim(), ...(user.hasPassword ? { password } : {}) });
      try {
        sessionStorage.clear();
      } catch {
        /* storage may be blocked */
      }
      window.location.assign("/goodbye"); // full load: drops every bit of client state
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.fields && Object.keys(err.fields).length) {
        setErrs({
          ...(err.fields.confirmEmail ? { confirmEmail: "That doesn't match your account's email address." } : {}),
          ...(err.fields.password ? { password: "That password isn't right." } : {}),
        });
      } else {
        setErrs({});
        setMsg(err instanceof ApiError && err.status === 429 ? "Too many tries. Please wait a few minutes and try again." : COPY.deleteGeneric);
      }
    }
  }
  return (
    <Dialog open={open} onClose={() => (busy ? undefined : onClose())} title="Delete your account for good?">
      <form method="post" onSubmit={go} noValidate className="space-y-3">
        <p className="text-sm">This deletes your account, all your servers and all their data right now. It can&apos;t be undone.</p>
        {msg ? <Alert>{msg}</Alert> : null}
        <Field label={"Type your email address to confirm"} error={errs.confirmEmail}>
          {(p) => <input {...p} type="email" name="confirmEmail" placeholder={user.email} className="input" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        {user.hasPassword ? (
          <Field label="Your password" hint="We ask for your password to make sure it's really you." error={errs.password}>
            {(p) => <input {...p} type="password" name="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            Keep my account
          </button>
          <button type="submit" className="btn btn-danger btn-sm" disabled={busy}>
            {busy ? "Deleting…" : "Delete everything"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
