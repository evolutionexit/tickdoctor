"use client";

import { useEffect, useMemo, useState } from "react";
import { ALERT_DEFAULTS, DISCORD_WEBHOOK_RE, type AlertConfig } from "@tickdoctor/shared";
import { api, ApiError, friendlyError, type PutAlertConfig } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { usePolled } from "@/lib/hooks";
import { Alert, Card, ErrorState, Field, Skeleton } from "../ui";
import { NotFoundState } from "./bits";

const EVENT_LABEL: Record<string, string> = {
  incident_opened: "Lag started",
  incident_resolved: "Lag over",
  server_offline: "Server offline",
  server_back: "Server back",
  crash: "Crash",
  test: "Test message",
};
const STATUS_WORD: Record<string, string> = {
  sent: "Sent",
  failed: "Couldn't send",
  suppressed_cooldown: "Skipped: same alert sent recently",
  suppressed_quiet: "Skipped: quiet hours",
  suppressed_disabled: "Not sent: alerts are turned off for this",
};

function zones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const z = f ? f("timeZone") : [];
    if (z.length) return z.includes("UTC") ? z : ["UTC", ...z];
  } catch {
    /* fall through */
  }
  return ["UTC"];
}
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

type Draft = Omit<AlertConfig, "webhookUrlMasked" | "webhookStatus">;
const toDraft = (c: AlertConfig): Draft => ({
  enabled: c.enabled,
  events: c.events,
  minSeverity: c.minSeverity,
  offlineAfterMinutes: c.offlineAfterMinutes,
  cooldownMinutes: c.cooldownMinutes,
  quietHours: c.quietHours,
});

type UrlMode = "keep" | "replace" | "remove";

function WebhookCard({ conf, urlMode, setUrlMode, url, setUrl, urlErr, setUrlErr, hasUrl, set }: { conf: AlertConfig; urlMode: UrlMode; setUrlMode: (m: UrlMode) => void; url: string; setUrl: (u: string) => void; urlErr: string; setUrlErr: (e: string) => void; hasUrl: boolean; set: (patch: Partial<Draft>) => void }) {
  return (
    <Card>
      <h2 className="font-semibold">Discord webhook</h2>
      {hasUrl && urlMode === "keep" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <code className="inline break-all">{conf.webhookUrlMasked}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setUrlMode("replace"); setUrlErr(""); }}>Replace URL</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setUrlMode("remove"); set({ enabled: false }); }}>Remove webhook</button>
        </div>
      ) : urlMode === "remove" ? (
        <p className="mt-3 text-sm">
          The webhook will be removed and alerts turned off when you save.{" "}
          <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => { setUrlMode("keep"); set({ enabled: conf.enabled }); }}>Keep it</button>
        </p>
      ) : (
        <div className="mt-3">
          <Field label="Webhook URL" error={urlErr} hint="Looks like https://discord.com/api/webhooks/… Only Discord webhook links are accepted. We store it encrypted and only show you the start of it.">
            {(p) => (
              <input {...p} type="url" inputMode="url" autoComplete="off" spellCheck={false} className="input w-full" placeholder="https://discord.com/api/webhooks/…" value={url} onChange={(e) => { setUrl(e.target.value); setUrlErr(""); }} />
            )}
          </Field>
          {hasUrl ? (
            <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => { setUrlMode("keep"); setUrl(""); setUrlErr(""); }}>Cancel</button>
          ) : null}
        </div>
      )}
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">Connect Discord in 5 steps</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>In Discord, open the channel where alerts should go and click the gear icon (Edit Channel).</li>
          <li>Go to <strong>Integrations</strong>, then <strong>Webhooks</strong>, and click <strong>New Webhook</strong>.</li>
          <li>Give it a name if you like, then click <strong>Copy Webhook URL</strong>.</li>
          <li>Paste the URL into the box above and click <strong>Save</strong>.</li>
          <li>Click <strong>Send test alert</strong>. A message should appear in your channel within a few seconds.</li>
        </ol>
        <p className="mt-2 text-muted">You need the &quot;Manage Webhooks&quot; permission on that channel. Anyone with this URL can post to your channel, so don&apos;t share it.</p>
      </details>
    </Card>
  );
}

function AlertRulesCard({ draft, set, hasUrl, urlMode }: { draft: Draft; set: (patch: Partial<Draft>) => void; hasUrl: boolean; urlMode: UrlMode }) {
  const setEvents = (k: keyof Draft["events"], v: boolean) => set({ events: { ...draft.events, [k]: v } });
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold" id="enable-h">Send alerts to Discord</h2>
          <p className="text-sm text-muted">{draft.enabled ? "On" : !hasUrl && urlMode !== "keep" ? "Alerts are off. Add a webhook above first." : "Alerts are off. Nothing will be sent."}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-labelledby="enable-h"
          onClick={() => set({ enabled: !draft.enabled })}
          className={`relative h-8 w-14 shrink-0 rounded-sm border ${draft.enabled ? "border-[var(--accent)] bg-accent" : "border-line bg-surface-2"}`}
        >
          <span aria-hidden="true" className={`absolute top-0.5 flex h-6 w-6 items-center justify-center bg-bg text-xs font-bold text-fg transition-all ${draft.enabled ? "left-7" : "left-0.5"}`}>{draft.enabled ? "✓" : ""}</span>
        </button>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">Tell me when</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([
            ["incidentOpened", "Lag starts"],
            ["incidentResolved", "Lag is over"],
            ["serverOffline", "Server goes offline or comes back"],
            ["crash", "Server crashed"],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={draft.events[k]} onChange={(e) => setEvents(k, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Field label="Minimum severity for &quot;lag starts&quot;" hint="Lower severities still show on the website, they just don't send a message.">
          {(p) => (
            <select {...p} className="input w-full" value={draft.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as Draft["minSeverity"] })}>
              <option value="medium">Medium and above (every incident)</option>
              <option value="high">High and above (serious lag)</option>
              <option value="critical">Critical only (near-unusable)</option>
            </select>
          )}
        </Field>
        <Field label="Count the server as offline after (minutes)" hint="Minutes without data before we send an offline message. A few minutes works well. Between 2 and 60.">
          {(p) => (
            <input {...p} type="number" min={2} max={60} className="input w-full" value={draft.offlineAfterMinutes} onChange={(e) => set({ offlineAfterMinutes: Number(e.target.value) || 0 })} onBlur={() => set({ offlineAfterMinutes: clamp(String(draft.offlineAfterMinutes), 2, 60, ALERT_DEFAULTS.offlineAfterMinutes) })} />
          )}
        </Field>
        <Field label="Quiet period between repeats (minutes)" hint="If the same kind of alert happens again within this time, we skip it. Lag-is-over and server-back are never skipped. Between 5 minutes and 24 hours.">
          {(p) => (
            <input {...p} type="number" min={5} max={1440} className="input w-full" value={draft.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) || 0 })} onBlur={() => set({ cooldownMinutes: clamp(String(draft.cooldownMinutes), 5, 1440, ALERT_DEFAULTS.cooldownMinutes) })} />
          )}
        </Field>
      </div>
    </Card>
  );
}

function QuietHoursCard({ q, setQ, allZones }: { q: Draft["quietHours"]; setQ: (patch: Partial<Draft["quietHours"]>) => void; allZones: string[] }) {
  return (
    <Card>
      <label className="flex min-h-10 items-center gap-2 font-semibold">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={q.enabled} onChange={(e) => setQ({ enabled: e.target.checked })} />
        Quiet hours
      </label>
      <p className="text-sm text-muted">During quiet hours we don&apos;t send messages, so you can sleep. Critical incidents still come through. Everything else is skipped for good, not sent later. You can see what was skipped in the delivery log.</p>
      <div className={`mt-3 grid gap-4 sm:grid-cols-3`}>
        <Field label="From" >{(p) => <input {...p} type="time" className="input w-full" value={q.start} disabled={!q.enabled} onChange={(e) => setQ({ start: e.target.value })} />}</Field>
        <Field label="Until">{(p) => <input {...p} type="time" className="input w-full" value={q.end} disabled={!q.enabled} onChange={(e) => setQ({ end: e.target.value })} />}</Field>
        <Field label="Time zone" hint="Times are in this time zone. It can cross midnight, for example 22:00 to 08:00.">
          {(p) => (
            <select {...p} className="input w-full" value={q.timeZone} disabled={!q.enabled} onChange={(e) => setQ({ timeZone: e.target.value })}>
              {(allZones.includes(q.timeZone) ? allZones : [q.timeZone, ...allZones]).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          )}
        </Field>
      </div>
    </Card>
  );
}

function DeliveriesCard({ deliveries }: { deliveries: ReturnType<typeof usePolled<Awaited<ReturnType<typeof api.alertDeliveries>>>> }) {
  return (
    <Card>
      <h2 className="font-semibold">Recent alerts</h2>
      <p className="text-sm text-muted">Every message we sent, or skipped on purpose, in the last 30 days.</p>
      {!deliveries.data && deliveries.loading ? (
        <div role="status" aria-label="Loading deliveries" className="mt-3"><Skeleton className="h-24" /></div>
      ) : !deliveries.data ? (
        <p role="alert" className="mt-2 text-sm text-health-lagging">{friendlyError(deliveries.error)} <button type="button" className="underline" onClick={deliveries.reload}>Try again</button></p>
      ) : deliveries.data.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing yet. Alerts and tests show up here.</p>
      ) : (
        <div className="relative mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Recent alert deliveries">
          <table className="w-full min-w-[24rem] text-left text-sm">
            <caption className="sr-only">Recent alert deliveries</caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">What</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Result</th>
                <th scope="col" className="py-2 font-semibold">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deliveries.data.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 pr-3">{EVENT_LABEL[d.event] ?? d.event}</td>
                  <td className="py-2 pr-3">
                    <span className={d.status === "failed" ? "font-semibold text-health-lagging" : ""}>
                      {d.status === "sent" ? "✓ " : d.status === "failed" ? "✕ " : "– "}
                      {STATUS_WORD[d.status] ?? d.status}
                    </span>
                    {d.status === "failed" && d.error ? <span className="block text-xs text-muted">{d.error}</span> : null}
                  </td>
                  <td className="py-2 font-mono text-xs">{dateTime(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LoadingAlerts() {
  return (
    <div role="status" aria-label="Loading alert settings" className="mx-auto max-w-2xl space-y-4">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-60" />
    </div>
  );
}

function AlertsIntro({ webhookStatus }: { webhookStatus: AlertConfig["webhookStatus"] }) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-muted">Get a Discord message when your server has trouble, so you don&apos;t have to keep the dashboard open. Messages go to a channel you choose. Tuning tips never send alerts.</p>
      </div>

      {webhookStatus === "invalid" ? (
        <Alert tone="warn" title="Alerts are paused: Discord rejected the webhook">
          Discord says this webhook doesn&apos;t exist any more, or we&apos;re not allowed to use it. It may have been deleted. Create a new one and paste it below. Until then we won&apos;t try to send anything.
        </Alert>
      ) : null}
    </>
  );
}

function WebhookStatusLine({ status }: { status: AlertConfig["webhookStatus"] }) {
  return status !== "invalid" ? <p className="text-xs text-muted">{{ none: "No webhook yet.", untested: "Not tested yet. Send a test alert to check it works.", ok: "Working. Last test or message went through.", invalid: "" }[status]}</p> : null;
}

export function AlertsPage({ id }: { id: string }) {
  const cfg = usePolled(() => api.alerts(id), `alerts-${id}`);
  const deliveries = usePolled(() => api.alertDeliveries(id), `deliveries-${id}`, 30_000);
  const [conf, setConf] = useState<AlertConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [urlMode, setUrlMode] = useState<UrlMode>("keep");
  const [url, setUrl] = useState("");
  const [urlErr, setUrlErr] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const allZones = useMemo(zones, []);

  useEffect(() => {
    if (cfg.data && !conf) {
      setConf(cfg.data);
      const d = toDraft(cfg.data);
      // Quiet hours with no saved zone yet: default to the browser's.
      if (!d.quietHours.enabled && d.quietHours.timeZone === "UTC") d.quietHours = { ...d.quietHours, timeZone: browserZone() };
      setDraft(d);
      if (!cfg.data.webhookUrlMasked) setUrlMode("replace");
    }
  }, [cfg.data, conf]);

  if (!cfg.data && cfg.loading) return <LoadingAlerts />;
  if (!cfg.data || !conf || !draft)
    return cfg.error instanceof ApiError && cfg.error.code === "not_found" ? (
      <NotFoundState error={cfg.error} what="server" />
    ) : (
      <ErrorState title="Couldn't load the alert settings" message={friendlyError(cfg.error)} onRetry={cfg.reload} />
    );

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !draft) return;
    setErr("");
    setUrlErr("");
    setSaved(false);
    if (draft.quietHours.enabled && draft.quietHours.start === draft.quietHours.end) return;
    const body: PutAlertConfig = {
      ...draft,
      offlineAfterMinutes: clamp(String(draft.offlineAfterMinutes), 2, 60, ALERT_DEFAULTS.offlineAfterMinutes),
      cooldownMinutes: clamp(String(draft.cooldownMinutes), 5, 1440, ALERT_DEFAULTS.cooldownMinutes),
    };
    if (urlMode === "replace") {
      const u = url.trim();
      if (!u && draft.enabled && !conf?.webhookUrlMasked) return setUrlErr("Add a webhook before turning alerts on.");
      if (u) {
        if (!DISCORD_WEBHOOK_RE.test(u)) return setUrlErr("That isn't a Discord webhook URL. It should look like https://discord.com/api/webhooks/123…/abc…");
        body.webhookUrl = u;
      }
    } else if (urlMode === "remove") {
      body.webhookUrl = null;
      body.enabled = false;
    }
    setSaving(true);
    try {
      const next = await api.saveAlerts(id, body);
      setConf(next);
      setDraft(toDraft(next));
      setUrl("");
      setUrlMode(next.webhookUrlMasked ? "keep" : "replace");
      setSaved(true);
      setTest(null);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.fields?.webhookUrl) setUrlErr(e2.fields.webhookUrl);
      else setErr(friendlyError(e2, { plan_limit: "Discord alerts aren't included in your plan." }));
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTest(null);
    try {
      await api.testAlert(id);
      setTest({ ok: true, message: "Test sent. Check your Discord channel." });
    } catch (e) {
      setTest({ ok: false, message: friendlyError(e, { webhook_failed: (e as Error).message, rate_limited: "You've sent a few tests in a row. Please wait about 10 minutes." }) });
    } finally {
      setTesting(false);
      deliveries.reload();
      // The API may have flagged the webhook as invalid: refresh only the status, keep the unsaved draft.
      api.alerts(id).then((c) => setConf((prev) => (prev ? { ...prev, webhookStatus: c.webhookStatus } : c))).catch(() => undefined);
    }
  }

  const q = draft.quietHours;
  const setQ = (patch: Partial<typeof q>) => set({ quietHours: { ...q, ...patch } });
  const hasUrl = !!conf.webhookUrlMasked;

  return (
    <form method="post" onSubmit={save} noValidate className="mx-auto max-w-3xl space-y-6">
      <AlertsIntro webhookStatus={conf.webhookStatus} />

      <WebhookCard conf={conf} urlMode={urlMode} setUrlMode={setUrlMode} url={url} setUrl={setUrl} urlErr={urlErr} setUrlErr={setUrlErr} hasUrl={hasUrl} set={set} />

      <AlertRulesCard draft={draft} set={set} hasUrl={hasUrl} urlMode={urlMode} />

      <QuietHoursCard q={q} setQ={setQ} allZones={allZones} />

      {err ? <Alert>{err}</Alert> : null}
      {q.enabled && q.start === q.end ? <p role="alert" className="text-sm text-health-lagging">Start and end can&apos;t be the same time.</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        <button type="button" className="btn btn-ghost" onClick={sendTest} disabled={testing || !hasUrl}>
          {testing ? "Sending…" : "Send test alert"}
        </button>
        <span role="status" aria-live="polite" className="text-sm">
          {saved ? <span className="text-health-healthy">Saved.</span> : null}
        </span>
      </div>
      {!hasUrl ? <p className="-mt-3 text-xs text-muted">Save the webhook first, then send the test. The test ignores quiet hours and the quiet period.</p> : null}
      <WebhookStatusLine status={conf.webhookStatus} />
      {test ? <Alert tone={test.ok ? "success" : "error"} title={test.ok ? "Test alert sent" : "Test alert failed"}>{test.message}</Alert> : null}


      <DeliveriesCard deliveries={deliveries} />
    </form>
  );
}

function clamp(v: string, min: number, max: number, fallback: number): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
