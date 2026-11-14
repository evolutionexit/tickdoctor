"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RESERVED_SLUGS, STATUS_SLUG_RE, STATUS_THEMES, brand, plans, type StatusPageSettings as Settings } from "@tickdoctor/shared";
import { api, ApiError, friendlyError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { usePolled } from "@/lib/hooks";
import { Alert, Card, CodeBlock, CopyButton, ErrorState, Field, Skeleton } from "../ui";
import { NotFoundState } from "./bits";

type Draft = Omit<Settings, "publicUrl" | "badgeUrl">;
const toDraft = (s: Settings): Draft => {
  const d: Partial<Settings> = { ...s };
  delete d.publicUrl;
  delete d.badgeUrl;
  return d as Draft;
};
const THEME_LABEL = { auto: "Match the visitor's device", dark: "Always dark", light: "Always light" } as const;

// Mirrors apps/api/src/status-pages/settings.ts: brand words are reserved as the first or last hyphen-separated part.
const BRAND_TOKENS = new Set(["tickdoctor", "mojang", "minecraft", brand.name.toLowerCase().replace(/[^a-z0-9]/g, "")]);

export function slugProblem(slug: string): string {
  if (!STATUS_SLUG_RE.test(slug))
    return "Use 3 to 40 lowercase letters, numbers or single hyphens. It can't start or end with a hyphen.";
  const parts = slug.split("-");
  if ((RESERVED_SLUGS as readonly string[]).includes(slug) || BRAND_TOKENS.has(parts[0]!) || BRAND_TOKENS.has(parts[parts.length - 1]!)) return "This address can't be used. Please choose another.";
  return "";
}

function Switch({ checked, onChange, labelledBy, disabled }: { checked: boolean; onChange: (v: boolean) => void; labelledBy: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-8 w-14 shrink-0 rounded-sm border disabled:opacity-50 ${checked ? "border-[var(--accent)] bg-accent" : "border-line bg-surface-2"}`}
    >
      <span aria-hidden="true" className={`absolute top-0.5 flex h-6 w-6 items-center justify-center bg-bg text-xs font-bold text-fg transition-all ${checked ? "left-7" : "left-0.5"}`}>{checked ? "✓" : ""}</span>
    </button>
  );
}

function LoadingSettings() {
  return (
    <div role="status" aria-label="Loading status page settings" className="mx-auto max-w-2xl space-y-4">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-60" />
    </div>
  );
}

function Intro() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Status page</h1>
      <p className="mt-1 text-sm text-muted">A public page you can share with your players, so they can check whether the server is up without asking you. It is switched off until you turn it on, and it only shows what you choose below. Never shown, whatever you pick: player names, IP addresses, your plugin list, findings, your API key, and who owns the server.</p>
    </div>
  );
}

type SetDraft = (patch: Partial<Draft>) => void;

function EnableCard({ enabled, set }: { enabled: boolean; set: SetDraft }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold" id="sp-enable-h">Make the status page public</h2>
          <p className="text-sm text-muted">{enabled ? "On. Anyone with the link can see the page." : "Off. Nobody can see this page, and its address shows \"not found\"."}</p>
        </div>
        <Switch checked={enabled} onChange={(v) => set({ enabled: v })} labelledBy="sp-enable-h" />
      </div>
    </Card>
  );
}

function AddressCard({ draft, publicUrl, slugMsg, err, set, setSlugErr }: { draft: Draft; publicUrl: string; slugMsg: string; err: string; set: SetDraft; setSlugErr: (e: string) => void }) {
  return (
    <Card className="space-y-4">
      <Field
        label="Address"
        hint={`Your page will be at ${new URL(publicUrl).origin}/s/${draft.slug || "your-name"}`}
        error={slugMsg}
      >
        {(p) => (
          <input
            {...p}
            className="input font-mono"
            value={draft.slug}
            maxLength={40}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setSlugErr("");
              set({ slug: e.target.value.toLowerCase().trim() });
            }}
          />
        )}
      </Field>
      <Field label="Title" hint="Shown at the top of the page and in link previews." error={err && !draft.title.trim() ? err : undefined}>
        {(p) => <input {...p} className="input" value={draft.title} maxLength={60} onChange={(e) => set({ title: e.target.value })} />}
      </Field>
      <Field label="Theme">
        {(p) => (
          <select {...p} className="input" value={draft.theme} onChange={(e) => set({ theme: e.target.value as Draft["theme"] })}>
            {STATUS_THEMES.map((t) => <option key={t} value={t}>{THEME_LABEL[t]}</option>)}
          </select>
        )}
      </Field>
    </Card>
  );
}

function ShowCard({ draft, canHide, set }: { draft: Draft; canHide: boolean; set: SetDraft }) {
  const toggles = [
    ["showPlayers", "Show players online", "Shows how many players are online and your max players, for example \"12 of 40\". No names."],
    ["showUptime", "Show uptime", "Share of time your server was online over the last 1, 7 and 30 days."],
    ["showIncidents", "Show recent lag incidents", "Periods of lag from the last 30 days: when, how long and how serious. No causes or technical details. This makes your lag history public."],
  ] as const;

  return (
    <Card>
      <h2 className="font-semibold">What to show</h2>
      <ul className="mt-3 divide-y divide-line">
        {toggles.map(([k, label, hint]) => (
          <li key={k} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium" id={`sp-${k}`}>{label}</p>
              <p className="text-sm text-muted">{hint}</p>
            </div>
            <Switch checked={draft[k]} onChange={(v) => set({ [k]: v })} labelledBy={`sp-${k}`} />
          </li>
        ))}
        <li className="flex items-center justify-between gap-4 py-3">
          <div>
            <p className="text-sm font-medium" id="sp-hide">Hide “Monitored with TickDoctor”</p>
            <p className="text-sm text-muted">
              {canHide ? "Remove the line at the bottom of the page and on the badge." : (
                <>Free pages always show “Monitored with TickDoctor”. Pro and Network plans can hide it. <Link href="/pricing" className="text-accent-text underline underline-offset-2">See plans</Link>.</>
              )}
            </p>
          </div>
          <Switch checked={canHide && draft.hideBranding} onChange={(v) => set({ hideBranding: v })} labelledBy="sp-hide" disabled={!canHide} />
        </li>
      </ul>
    </Card>
  );
}

function ShareCard({ saved, draft, badgeBroken, setBadgeBroken }: { saved: Settings; draft: Draft; badgeBroken: boolean; setBadgeBroken: (b: boolean) => void }) {
  const live = saved.enabled;
  // Snippets come from the SAVED settings (what the public page really says), not the unsaved draft.
  const mdAlt = `${saved.title} status`.replace(/([\\[\]])/g, "\\$1");
  const htmlAlt = `${saved.title} status`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const md = `[![${mdAlt}](${saved.badgeUrl})](${saved.publicUrl})`;
  const html = `<a href="${saved.publicUrl}"><img src="${saved.badgeUrl}" alt="${htmlAlt}"></a>`;

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Share it</h2>
      <p className="text-sm text-muted">Put a small badge in your Discord server, your website or your README. It updates by itself and links to your status page. It refreshes about once a minute and only works while the status page is public.</p>
      {live ? (
        <>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Public link</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <a href={saved.publicUrl} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-sm text-accent-text underline underline-offset-2">{saved.publicUrl}</a>
              <CopyButton text={saved.publicUrl} label="Copy link" />
              <a href={saved.publicUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">Open<span className="sr-only"> (new tab)</span></a>
            </div>
            {draft.slug !== saved.slug ? <p className="mt-1 text-xs text-muted">You changed the address. Save to switch to the new link. The old one stops working right away.</p> : null}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Badge</p>
            <div className="mt-2 flex min-h-8 items-center">
              {badgeBroken ? (
                <p className="text-sm text-muted">The badge didn&apos;t load. It may take a moment after you save.</p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={saved.badgeUrl} alt="Status badge preview" height={20} onError={() => setBadgeBroken(true)} />
              )}
            </div>
          </div>
          <CodeBlock label="Markdown (GitHub, Discord, forums)" text={md} />
          <CodeBlock label="HTML (your website)" text={html} />
        </>
      ) : (
        <p className="text-sm text-muted">Turn the status page on and save to get a public link and a badge you can paste into your Discord, README or website.</p>
      )}
    </Card>
  );
}

export function StatusPageSettings({ id }: { id: string }) {
  const res = usePolled(() => api.statusPage(id), `status-page-${id}`);
  const { user } = useAuth();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [slugErr, setSlugErr] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [badgeBroken, setBadgeBroken] = useState(false);

  useEffect(() => {
    if (res.data && !saved) {
      setSaved(res.data);
      setDraft(toDraft(res.data));
    }
  }, [res.data, saved]);

  if (!res.data && res.loading) return <LoadingSettings />;
  if (!res.data || !saved || !draft)
    return res.error instanceof ApiError && res.error.code === "not_found" ? (
      <NotFoundState error={res.error} what="server" />
    ) : (
      <ErrorState title="Couldn't load the status page settings" message={friendlyError(res.error)} onRetry={res.reload} />
    );

  const canHide = plans[user.effectivePlan].statusPage === "custom";
  const liveProblem = slugProblem(draft.slug);
  const slugMsg = slugErr || liveProblem;
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDone(false);
    setErr("");
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !draft) return;
    setErr("");
    setDone(false);
    if (liveProblem) return;
    const title = draft.title.trim();
    if (!title) return setErr("Give the page a title.");
    setSaving(true);
    try {
      const next = await api.saveStatusPage(id, { ...draft, title, hideBranding: canHide ? draft.hideBranding : false });
      setSaved(next);
      setDraft(toDraft(next));
      setSlugErr("");
      setBadgeBroken(false);
      setDone(true);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "conflict") setSlugErr("Someone already uses this address. Please choose another.");
      else if (e2 instanceof ApiError && e2.fields?.slug) setSlugErr(e2.fields.slug);
      else setErr(friendlyError(e2));
    } finally {
      setSaving(false);
    }
  }

  return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Intro />

        <form method="post" onSubmit={save} className="space-y-6" noValidate>
          <EnableCard enabled={draft.enabled} set={set} />

          <AddressCard draft={draft} publicUrl={saved.publicUrl} slugMsg={slugMsg} err={err} set={set} setSlugErr={setSlugErr} />

          <ShowCard draft={draft} canHide={canHide} set={set} />

          {err && draft.title.trim() ? <Alert>{err}</Alert> : null}
          {done ? <Alert tone="success">Saved.{saved.enabled ? " Your status page is live." : ""}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={saving || !!liveProblem} aria-disabled={saving || !!liveProblem}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>

        <ShareCard saved={saved} draft={draft} badgeBroken={badgeBroken} setBadgeBroken={setBadgeBroken} />
      </div>
  );
}
