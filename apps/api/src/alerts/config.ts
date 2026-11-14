import { sql } from "drizzle-orm";
import { ALERT_DEFAULTS, type AlertConfig } from "@tickdoctor/shared";
import { rows, type Exec } from "../db/query.js";

// alert_configs row ↔ AlertConfig (contract app-phase6.ts) + quiet hours.

export interface AlertConfigRow extends AlertConfig {
  serverId: string;
  /** Encrypted webhook (never leaves this module except to the dispatcher's decrypt). */
  webhookEnc: string | null;
  createdAt: number;
  /** false = never saved (defaults). */
  saved: boolean;
}

export function defaultAlertConfig(): AlertConfig {
  return {
    enabled: false,
    webhookUrlMasked: null,
    webhookStatus: "none",
    events: { incidentOpened: true, incidentResolved: true, serverOffline: true, crash: true },
    minSeverity: ALERT_DEFAULTS.minSeverity,
    offlineAfterMinutes: ALERT_DEFAULTS.offlineAfterMinutes,
    cooldownMinutes: ALERT_DEFAULTS.cooldownMinutes,
    quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
  };
}

export async function loadAlertConfig(db: Exec, serverId: string): Promise<AlertConfigRow> {
  const [r] = await rows<{
    enabled: boolean; webhook_enc: string | null; webhook_masked: string | null; webhook_status: string;
    events: AlertConfig["events"]; min_severity: string; offline_after_minutes: number; cooldown_minutes: number;
    quiet_hours: AlertConfig["quietHours"]; created_at: Date;
  }>(db, sql`select * from alert_configs where server_id = ${serverId}`);
  const d = defaultAlertConfig();
  if (!r) return { ...d, serverId, webhookEnc: null, createdAt: 0, saved: false };
  return {
    serverId,
    saved: true,
    enabled: r.enabled,
    webhookEnc: r.webhook_enc,
    webhookUrlMasked: r.webhook_masked,
    webhookStatus: (["none", "ok", "invalid", "untested"].includes(r.webhook_status) ? r.webhook_status : "none") as AlertConfig["webhookStatus"],
    events: { ...d.events, ...r.events },
    minSeverity: r.min_severity as AlertConfig["minSeverity"],
    offlineAfterMinutes: r.offline_after_minutes,
    cooldownMinutes: r.cooldown_minutes,
    quietHours: { ...d.quietHours, ...r.quiet_hours },
    createdAt: new Date(r.created_at).getTime(),
  };
}

export function publicConfig(c: AlertConfigRow): AlertConfig {
  return {
    enabled: c.enabled,
    webhookUrlMasked: c.webhookUrlMasked,
    webhookStatus: c.webhookStatus,
    events: c.events,
    minSeverity: c.minSeverity,
    offlineAfterMinutes: c.offlineAfterMinutes,
    cooldownMinutes: c.cooldownMinutes,
    quietHours: c.quietHours,
  };
}

/** True for an IANA zone Intl knows ("Europe/Zurich", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Local minute of the day in `timeZone`. */
export function localMinute(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

/**
 * Quiet hours [start, end) in local time; start > end spans midnight ("22:00"–"08:00"). start == end = no quiet
 * time. An invalid zone (can't happen after PUT validation) counts as not quiet.
 */
export function inQuietHours(nowMs: number, q: AlertConfig["quietHours"]): boolean {
  if (!q.enabled) return false;
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === e) return false;
  let t: number;
  try {
    t = localMinute(nowMs, q.timeZone);
  } catch {
    return false;
  }
  return s < e ? t >= s && t < e : t >= s || t < e;
}
