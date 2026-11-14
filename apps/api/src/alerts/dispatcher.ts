import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ms, rows } from "../db/query.js";
import { impactOrderSql, nonTipSql } from "../findings/tips.js";
import { planOf } from "../limits.js";
import { decryptSecret } from "./crypto.js";
import { inQuietHours, loadAlertConfig, type AlertConfigRow } from "./config.js";
import { buildMessage, type AlertEvent, type MessageInput } from "./messages.js";
import { defaultSleep, scrubUrl, sendWebhook, type FetchLike, type SendResult, type Sleep } from "./webhook.js";

// Discord alert dispatcher (contract app-phase6.ts "Alerts").
//
// State-based and idempotent: checkServer() looks at the server's incidents, last sample and crash events and at
// alert_deliveries (what was already sent, suppressed or tried), and delivers whatever is due. It runs
//   - after every metrics / events ingest for that server (kick(), fire and forget: never blocks or fails ingest),
//   - every minute for every server with an alert config (tick(): offline detection, offline incident closes,
//     retries).
// Per server the checks run one at a time in-process (a kick while one runs re-runs it once afterwards), so an
// event isn't sent twice by this process. One API process (like the live hub); several would need a DB claim.
// Known residual risk: if the process dies between Discord accepting a message and the delivery row being written,
// the next check sends that alert again (at-least-once; a duplicate is better than a lost alert).
//
// Rules:
//   - incident_opened once per incident when severity ≥ minSeverity (also when it rises later). An opener that was
//     suppressed by quiet hours is delivered once if the incident later becomes critical (critical bypasses quiet).
//   - incident_resolved only when the opener was SENT, and only for end_reason "recovered" (an incident that ended
//     because the server went offline is covered by server_offline / server_back).
//   - server_offline once per outage; server_back only after a SENT server_offline of that outage.
//   - crash per crash event (or unclean server_start).
//   - Nothing about incidents or outages that started before alerts were configured, and no outage counts until
//     offlineAfterMinutes after this process started (after an API restart every last sample looks old).
//   - A FAILED attempt is retried on later checks (backoff RETRY_BACKOFF_MS, MAX_ATTEMPTS in total) unless the
//     webhook is known to be invalid. sent / suppressed_* rows are final.
// Cooldown (incident_opened, server_offline, crash) = a SENT alert of the same event within cooldownMinutes. Quiet
// hours suppress all but critical incident_opened. Disabled config / event toggle off / plan without alerts →
// suppressed_disabled. Every decision is a row in alert_deliveries. The webhook URL is decrypted only right before
// sending and never logged.

const MIN = 60_000;
const RANK = { medium: 1, high: 2, critical: 3 } as const;
type Sev = keyof typeof RANK;
const rank = (s: unknown) => RANK[(s as Sev) ?? "medium"] ?? 1;
/** Crash events older than this are never alerted (catch-up batches). */
export const CRASH_LOOKBACK_MS = 60 * MIN;
/** Closed incidents are checked for a pending resolved alert this long after closing. */
const RESOLVE_LOOKBACK_MS = 24 * 60 * MIN;
/** Attempts per alert (first try + retries on later checks) and the wait before retry n (after attempt n). */
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [2 * MIN, 8 * MIN];

export type DeliveryStatus = "sent" | "failed" | "suppressed_cooldown" | "suppressed_quiet" | "suppressed_disabled";

export interface DispatcherDeps {
  db: Db;
  now: () => number;
  webOrigin: string;
  /** SECRETS_KEY (32 bytes). Without it nothing can be sent (deliveries log "failed"). */
  secretsKey?: Buffer;
  fetch?: FetchLike;
  sleep?: Sleep;
  log?: (line: string) => void;
  /** When this process started (default: construction time). No outage is reported earlier than offlineAfterMinutes after it. */
  startedAt?: number;
}

interface ServerInfo {
  id: string;
  name: string;
  plan: string;
  first_sample_at: Date | null;
  last_sample_at: Date | null;
}

interface DeliverOpts {
  toggle: boolean;
  cooldown: boolean;
  severity?: Sev;
  incidentId?: string;
  sourceEventId?: number;
  refAt?: number;
}

export interface Attempt {
  status: string;
  created_at: Date | string;
}

/**
 * Pure: what to do about one alert given its earlier delivery rows. "due" = try now, "wait" = a failed attempt is
 * still in its backoff, "done" = sent, suppressed, out of attempts, or the webhook is known to be invalid.
 */
export function attemptState(attempts: Attempt[], nowMs: number, webhookInvalid: boolean): "due" | "wait" | "done" {
  if (attempts.length === 0) return "due";
  if (attempts.some((a) => a.status !== "failed")) return "done";
  if (webhookInvalid || attempts.length >= MAX_ATTEMPTS) return "done";
  const last = Math.max(...attempts.map((a) => ms(a.created_at)));
  return nowMs - last >= (RETRY_BACKOFF_MS[attempts.length - 1] ?? Infinity) ? "due" : "wait";
}

export class AlertDispatcher {
  private readonly chains = new Map<string, { again: boolean; promise: Promise<void> }>();
  private readonly sleep: Sleep;
  private readonly log: (line: string) => void;
  private readonly startedAt: number;
  private lastAt = 0;

  constructor(private readonly deps: DispatcherDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? (() => {});
    this.startedAt = deps.startedAt ?? deps.now();
  }

  /** Schedules a check for one server (coalesced). Never throws. */
  kick(serverId: string): Promise<void> {
    const running = this.chains.get(serverId);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          try {
            await this.checkServer(serverId);
          } catch (err) {
            this.log(`alerts check failed server=${serverId.slice(0, 8)}: ${scrubUrl(err instanceof Error ? err.message : String(err))}`);
          }
        } while (entry.again);
      } finally {
        this.chains.delete(serverId);
      }
    })();
    this.chains.set(serverId, entry);
    return entry.promise;
  }

  /** Resolves when no check is running (tests). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()].map((c) => c.promise));
  }

  /** Every minute: every server with a saved alert config. */
  async tick(): Promise<number> {
    const servers = await rows<{ server_id: string }>(this.deps.db, sql`select server_id from alert_configs`);
    await Promise.all(servers.map((s) => this.kick(s.server_id)));
    return servers.length;
  }

  private link(serverId: string, incidentId?: string) {
    return `${this.deps.webOrigin}/app/servers/${serverId}${incidentId ? `/incidents/${incidentId}` : ""}`;
  }

  private async topFindings(incidentId: string): Promise<string[]> {
    const r = await rows<{ title: string }>(
      this.deps.db,
      sql`select f.title from finding_incidents fi join findings f on f.id = fi.finding_id
           where fi.incident_id = ${incidentId} and ${nonTipSql(sql`f.severity`)} order by ${impactOrderSql("f")} limit 2`,
    );
    return r.map((x) => x.title);
  }

  private attempts(where: SQL): Promise<Attempt[]> {
    return rows<Attempt>(this.deps.db, sql`select status, created_at from alert_deliveries where ${where} order by created_at`);
  }

  async checkServer(serverId: string): Promise<void> {
    const db = this.deps.db;
    const cfg = await loadAlertConfig(db, serverId);
    if (!cfg.saved) return;
    const [srv] = await rows<ServerInfo>(db, sql`select id, name, plan, first_sample_at, last_sample_at from servers where id = ${serverId}`);
    if (!srv) return;
    const now = this.deps.now();
    const minRank = rank(cfg.minSeverity);
    const invalid = cfg.webhookStatus === "invalid";
    const configuredIso = new Date(cfg.createdAt).toISOString();

    // 1. incident_opened (on open, or once it rises to minSeverity)
    const open = await rows<{ id: string; severity: Sev; initial_severity: Sev | null; peak_mspt_p95: number; min_tps_1m: number | null }>(
      db,
      sql`select id, severity, initial_severity, peak_mspt_p95, min_tps_1m from incidents
           where server_id = ${serverId} and ended_at is null and started_at >= ${configuredIso}::timestamptz`,
    );
    for (const i of open) {
      if (rank(i.severity) < minRank) continue;
      let tries = await this.attempts(sql`incident_id = ${i.id} and event = 'incident_opened'`);
      // Quiet-suppressed opener + now critical → one more delivery (critical bypasses quiet hours); only the
      // attempts after the last quiet suppression count for it.
      if (i.severity === "critical" && tries.length > 0 && tries.every((t) => t.status === "suppressed_quiet" || t.status === "failed")) {
        const lastQuiet = tries.map((t) => t.status).lastIndexOf("suppressed_quiet");
        if (lastQuiet >= 0) tries = tries.slice(lastQuiet + 1);
      }
      if (attemptState(tries, now, invalid) !== "due") continue;
      await this.deliver(cfg, srv, "incident_opened", {
        severity: i.severity,
        raised: rank(i.initial_severity ?? i.severity) < minRank,
        peakMspt: Number(i.peak_mspt_p95),
        minTps: i.min_tps_1m === null ? null : Number(i.min_tps_1m),
        findings: await this.topFindings(i.id),
        link: this.link(serverId, i.id),
      }, { toggle: cfg.events.incidentOpened, cooldown: true, severity: i.severity, incidentId: i.id });
    }

    // 2. incident_resolved (recovered only; only after a SENT opener)
    const closed = await rows<{ id: string; started_at: Date; ended_at: Date; peak_mspt_p95: number; min_tps_1m: number | null; severity: Sev }>(
      db,
      sql`select i.id, i.started_at, i.ended_at, i.peak_mspt_p95, i.min_tps_1m, i.severity from incidents i
           where i.server_id = ${serverId} and i.ended_at is not null and i.end_reason = 'recovered'
             and coalesce(i.closed_at, i.ended_at) >= ${new Date(now - RESOLVE_LOOKBACK_MS).toISOString()}::timestamptz
             and exists (select 1 from alert_deliveries d where d.incident_id = i.id and d.event = 'incident_opened' and d.status = 'sent')`,
    );
    for (const i of closed) {
      if (attemptState(await this.attempts(sql`incident_id = ${i.id} and event = 'incident_resolved'`), now, invalid) !== "due") continue;
      await this.deliver(cfg, srv, "incident_resolved", {
        peakMspt: Number(i.peak_mspt_p95),
        minTps: i.min_tps_1m === null ? null : Number(i.min_tps_1m),
        durationMs: ms(i.ended_at) - ms(i.started_at),
        findings: await this.topFindings(i.id),
        link: this.link(serverId, i.id),
      }, { toggle: cfg.events.incidentResolved, cooldown: false, severity: i.severity, incidentId: i.id });
    }

    // 3. server_offline (once per outage) / server_back (after a SENT offline of that outage).
    // An outage is identified by the receive time of the last sample before it (ref_at).
    if (srv.first_sample_at && srv.last_sample_at) {
      const last = ms(srv.last_sample_at);
      const lastIso = new Date(last).toISOString();
      const silentFor = now - Math.max(last, this.startedAt);
      if (silentFor >= cfg.offlineAfterMinutes * MIN && last >= cfg.createdAt) {
        const tries = await this.attempts(sql`server_id = ${serverId} and event = 'server_offline' and ref_at = ${lastIso}::timestamptz`);
        if (attemptState(tries, now, invalid) === "due") {
          await this.deliver(cfg, srv, "server_offline", { minutes: Math.floor((now - last) / MIN), link: this.link(serverId) }, {
            toggle: cfg.events.serverOffline,
            cooldown: true,
            refAt: last,
          });
        }
      }
      // The latest outage that got a SENT offline alert; data has arrived since → back.
      const [off] = await rows<{ ref_at: Date }>(
        db,
        sql`select ref_at from alert_deliveries where server_id = ${serverId} and event = 'server_offline' and status = 'sent' and ref_at is not null
             order by ref_at desc limit 1`,
      );
      if (off && last > ms(off.ref_at)) {
        const refIso = new Date(ms(off.ref_at)).toISOString();
        const tries = await this.attempts(sql`server_id = ${serverId} and event = 'server_back' and ref_at = ${refIso}::timestamptz`);
        if (attemptState(tries, now, invalid) === "due") {
          // Receive times on both ends: the last sample before the outage (ref_at) → the latest sample now.
          await this.deliver(cfg, srv, "server_back", { durationMs: Math.max(0, last - ms(off.ref_at)), link: this.link(serverId) }, {
            toggle: cfg.events.serverOffline,
            cooldown: false,
            refAt: ms(off.ref_at),
          });
        }
      }
    }

    // 4. crash: agent "crash" events and server_start after an unclean shutdown
    const since = new Date(Math.max(cfg.createdAt, now - CRASH_LOOKBACK_MS)).toISOString();
    const crashes = await rows<{ id: number; ts: Date }>(
      db,
      sql`select e.id, e.ts from events e
           where e.server_id = ${serverId} and e.ts >= ${since}::timestamptz
             and (e.type = 'crash' or (e.type = 'server_start' and (e.data->>'uncleanPreviousShutdown')::boolean is true))
           order by e.ts limit 20`,
    );
    for (const e of crashes) {
      if (attemptState(await this.attempts(sql`server_id = ${serverId} and source_event_id = ${Number(e.id)}`), now, invalid) !== "due") continue;
      await this.deliver(cfg, srv, "crash", { atMs: ms(e.ts), link: this.link(serverId) }, { toggle: cfg.events.crash, cooldown: true, sourceEventId: Number(e.id) });
    }
  }

  private async record(
    serverId: string,
    event: AlertEvent,
    status: DeliveryStatus,
    extra: { httpStatus?: number | null; error?: string | null; incidentId?: string; sourceEventId?: number; refAt?: number } = {},
  ) {
    // Strictly increasing per process, so rows written in the same millisecond keep their order in the log.
    this.lastAt = Math.max(this.deps.now(), this.lastAt + 1);
    const now = new Date(this.lastAt).toISOString();
    await this.deps.db.execute(sql`
      insert into alert_deliveries (server_id, event, status, http_status, error, incident_id, source_event_id, ref_at, created_at)
      values (${serverId}, ${event}, ${status}, ${extra.httpStatus ?? null}, ${extra.error ? scrubUrl(extra.error) : null},
              ${extra.incidentId ?? null}, ${extra.sourceEventId ?? null},
              ${extra.refAt === undefined ? null : new Date(extra.refAt).toISOString()}::timestamptz, ${now}::timestamptz)`);
    this.log(`alert ${event} server=${serverId.slice(0, 8)} ${status}${extra.httpStatus ? ` http=${extra.httpStatus}` : ""}`);
  }

  private async deliver(cfg: AlertConfigRow, srv: ServerInfo, event: Exclude<AlertEvent, "test">, input: Omit<MessageInput, "event" | "serverName">, o: DeliverOpts) {
    const base = { incidentId: o.incidentId, sourceEventId: o.sourceEventId, refAt: o.refAt };
    if (!cfg.enabled || !o.toggle || !planOf(srv.plan).discordAlerts) return this.record(srv.id, event, "suppressed_disabled", base);
    const now = this.deps.now();
    if (o.cooldown) {
      const recent = await rows(
        this.deps.db,
        sql`select 1 from alert_deliveries where server_id = ${srv.id} and event = ${event} and status = 'sent'
              and created_at > ${new Date(now - cfg.cooldownMinutes * MIN).toISOString()}::timestamptz limit 1`,
      );
      if (recent.length > 0) return this.record(srv.id, event, "suppressed_cooldown", base);
    }
    if (inQuietHours(now, cfg.quietHours) && !(event === "incident_opened" && o.severity === "critical")) {
      return this.record(srv.id, event, "suppressed_quiet", base);
    }
    const r = await this.post(cfg, buildMessage({ event, serverName: srv.name, ...input }));
    return this.record(srv.id, event, r.ok ? "sent" : "failed", { ...base, httpStatus: r.httpStatus, error: r.error });
  }

  private async setWebhookStatus(cfg: AlertConfigRow, status: "ok" | "invalid") {
    if (status === cfg.webhookStatus || !cfg.webhookEnc) return;
    // Only if the webhook wasn't replaced meanwhile.
    await this.deps.db.execute(sql`update alert_configs set webhook_status = ${status} where server_id = ${cfg.serverId} and webhook_enc = ${cfg.webhookEnc}`);
    cfg.webhookStatus = status;
  }

  /** Decrypt + send + remember the webhook status. A webhook known to be invalid is not called again. */
  private async post(cfg: AlertConfigRow, body: unknown, opts: { ignoreInvalid?: boolean; maxRetries?: number } = {}): Promise<SendResult> {
    if (!cfg.webhookEnc) return { ok: false, httpStatus: null, error: "No webhook saved.", invalid: false };
    if (cfg.webhookStatus === "invalid" && !opts.ignoreInvalid) {
      return { ok: false, httpStatus: null, error: "The webhook no longer works. Paste a new webhook URL in the Alerts tab.", invalid: true };
    }
    if (!this.deps.secretsKey) return { ok: false, httpStatus: null, error: "Alerts can't be sent: SECRETS_KEY isn't set on the server.", invalid: false };
    let url: string;
    try {
      url = decryptSecret(this.deps.secretsKey, cfg.webhookEnc, cfg.serverId);
    } catch {
      // Wrong SECRETS_KEY, a value from before server-bound encryption, or another server's value: unusable for good.
      await this.setWebhookStatus(cfg, "invalid");
      return { ok: false, httpStatus: null, error: "Couldn't read the saved webhook. Paste the webhook URL again in the Alerts tab.", invalid: true };
    }
    const r = await sendWebhook(url, body, { fetch: this.deps.fetch, sleep: this.sleep, maxRetries: opts.maxRetries });
    if (r.ok) await this.setWebhookStatus(cfg, "ok");
    else if (r.invalid) await this.setWebhookStatus(cfg, "invalid");
    return { ...r, error: r.error ? scrubUrl(r.error) : null };
  }

  /** POST /alerts/test and `cli alerts:test`: ignores enabled, cooldown and quiet hours; no retries (fast answer); logged as "test". */
  async sendTest(serverId: string): Promise<SendResult | "no_webhook"> {
    const cfg = await loadAlertConfig(this.deps.db, serverId);
    if (!cfg.webhookEnc) return "no_webhook";
    const [srv] = await rows<{ name: string }>(this.deps.db, sql`select name from servers where id = ${serverId}`);
    const r = await this.post(cfg, buildMessage({ event: "test", serverName: srv?.name ?? "", link: this.link(serverId) }), {
      ignoreInvalid: true,
      maxRetries: 0,
    });
    await this.record(serverId, "test", r.ok ? "sent" : "failed", { httpStatus: r.httpStatus, error: r.error });
    return r;
  }
}
