import { Hono, type Context } from "hono";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  DISCORD_WEBHOOK_RE,
  RULE_IDS,
  SEVERITIES,
  SEVERITY_RANK,
  patchFindingRequest,
  putAlertConfigRequest,
  type AlertConfig,
  type Finding,
  type IncidentListItem,
} from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { iso, isoOrNull, rows } from "../db/query.js";
import { HttpError } from "../errors.js";
import { planOf } from "../limits.js";
import { bodyLimit } from "../middleware/body-limit.js";
import { rateLimited, type RateLimitStore } from "../middleware/rate-limit.js";
import type { SessionEnv } from "../middleware/session.js";
import { getFinding, incidentIdsOf, markFixed, toFinding, undoMarkFixed } from "../findings/lifecycle.js";
import { impactOrderSql, nonTipSql, tipSql } from "../findings/tips.js";
import { loadIncidentDetail } from "../incidents/detail.js";
import { serverFindingsLocked, viewFinding } from "../findings/gate.js";
import { encryptSecret } from "../alerts/crypto.js";
import { isValidTimeZone, loadAlertConfig, publicConfig } from "../alerts/config.js";
import type { AlertDispatcher } from "../alerts/dispatcher.js";
import { maskWebhook } from "../alerts/webhook.js";
import { serverAccess } from "./servers.js";
import { MAX_JSON_BYTES, parseQuery, readJson } from "./json.js";

// Phase 6 app API (contract app-phase6.ts): incident detail, findings (+ mark fixed), Discord alert settings.
// Owner checks everywhere: someone else's (or an unknown / malformed) id is 404, never 403.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Phase6Deps {
  db: Db;
  now: () => number;
  adminToken: string | undefined;
  alerts: AlertDispatcher;
  /** SECRETS_KEY; without it webhooks can't be saved (503). */
  secretsKey?: Buffer;
  /** POST /alerts/test: 5 per server per 10 min. */
  alertTestPerServer: RateLimitStore;
}

const user = (c: Context<SessionEnv>) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Please sign in");
  return s.user;
};

const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

// ---------- /api/incidents ----------

export function incidentRoutes(deps: Phase6Deps) {
  const app = new Hono<SessionEnv>();
  app.get("/:id", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) throw notFound("Incident");
    const detail = await loadIncidentDetail(deps.db, id, u.id, deps.now(), true);
    if (!detail) throw notFound("Incident");
    return c.json(detail, 200);
  });
  return app;
}

// ---------- /api/findings ----------

async function ownedFinding(db: Db, id: string, userId: string): Promise<Finding> {
  if (!UUID.test(id)) throw notFound("Finding");
  const r = await rows<{ id: string }>(db, sql`select f.id from findings f join servers s on s.id = f.server_id where f.id = ${id} and s.owner_id = ${userId}`);
  if (r.length === 0) throw notFound("Finding");
  const f = await getFinding(db, id);
  if (!f) throw notFound("Finding");
  return f;
}

export function findingRoutes(deps: Phase6Deps) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));

  app.get("/:id", async (c) => {
    const finding = await ownedFinding(deps.db, c.req.param("id"), user(c).id);
    const r = await rows<{ id: string; started_at: Date; ended_at: Date | null; severity: string; peak_mspt_p95: number; min_tps_1m: number | null; trigger: string }>(
      deps.db,
      sql`select i.id, i.started_at, i.ended_at, i.severity, i.peak_mspt_p95, i.min_tps_1m, i.trigger
            from finding_incidents fi join incidents i on i.id = fi.incident_id
           where fi.finding_id = ${finding.id} order by i.started_at desc limit 50`,
    );
    const incidents: IncidentListItem[] = r.map((i) => ({
      id: i.id,
      startedAt: iso(i.started_at),
      endedAt: isoOrNull(i.ended_at),
      severity: i.severity as IncidentListItem["severity"],
      peakMsptP95: Number(i.peak_mspt_p95),
      minTps1m: i.min_tps_1m === null ? null : Number(i.min_tps_1m),
      trigger: i.trigger === "tps" ? "tps" : "mspt",
    }));
    return c.json({ finding: viewFinding(finding, await serverFindingsLocked(deps.db, finding.serverId)), incidents }, 200);
  });

  app.patch("/:id", async (c) => {
    const u = user(c);
    const body = await readJson(c, patchFindingRequest);
    const f = await ownedFinding(deps.db, c.req.param("id"), u.id);
    // The Phase 4 lifecycle functions (same as `cli finding:mark-fixed`), so the recheck job works unchanged.
    const ok = body.status === "marked_fixed" ? await markFixed(deps.db, f.id, deps.now()) : await undoMarkFixed(deps.db, f.id);
    if (!ok) {
      throw new HttpError(
        409,
        "conflict",
        body.status === "marked_fixed" ? "Only open findings can be marked fixed" : "Only findings marked fixed can be reopened",
      );
    }
    // Mark fixed / undo is allowed on every plan (status only); the response follows the same gating as GET.
    const updated = (await getFinding(deps.db, f.id))!;
    return c.json({ finding: viewFinding(updated, await serverFindingsLocked(deps.db, updated.serverId)) }, 200);
  });
  return app;
}

// ---------- /api/servers/:id/findings + /alerts ----------

const findingsQuery = z.object({
  status: z.enum(["active", "open", "marked_fixed", "confirmed_fixed", "all"]).default("active"),
  severity: z.enum(SEVERITIES).optional(),
  ruleId: z.enum(RULE_IDS).optional(),
});

const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

const statusSql = (status: z.infer<typeof findingsQuery>["status"]) =>
  status === "all"
    ? sql`true`
    : status === "active"
      ? sql`f.status in ('open', 'marked_fixed')`
      : sql`f.status = ${status}`;

export function serverPhase6Routes(deps: Phase6Deps) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));
  const authorize = serverAccess(deps.db, deps.adminToken);

  const withIncidentIds = async (rs: Record<string, unknown>[], locked: boolean) => {
    const ids = await incidentIdsOf(deps.db, rs.map((r) => String(r.id)));
    return rs.map((r) => viewFinding(toFinding(r, ids.get(String(r.id)) ?? []), locked));
  };

  app.get("/:id/findings", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    const q = parseQuery(c, findingsQuery);
    const minRank = q.severity ? SEVERITY_RANK[q.severity] : -1;
    const sevAllowed = SEVERITIES.filter((s) => SEVERITY_RANK[s] >= minRank);
    const main = await rows(
      deps.db,
      sql`select f.* from findings f
           where f.server_id = ${serverId} and ${statusSql(q.status)} and ${nonTipSql(sql`f.severity`)}
             and f.severity = any(${`{${sevAllowed.join(",")}}`}::text[])
             ${q.ruleId ? sql`and f.rule_id = ${q.ruleId}` : sql``}
           order by ${impactOrderSql("f")} limit 200`,
    );
    const tips = await rows(
      deps.db,
      sql`select f.* from findings f
           where f.server_id = ${serverId} and ${statusSql(q.status)} and ${tipSql(sql`f.severity`)}
           order by ${impactOrderSql("f")} limit 20`,
    );
    const locked = await serverFindingsLocked(deps.db, serverId);
    return c.json({ findings: await withIncidentIds(main, locked), tuningTips: await withIncidentIds(tips, locked) }, 200);
  });

  const planCheck = async (serverId: string) => {
    const [s] = await rows<{ plan: string }>(deps.db, sql`select plan from servers where id = ${serverId}`);
    if (!planOf(s?.plan ?? "free").discordAlerts) throw new HttpError(402, "plan_limit", "Discord alerts aren't part of this plan");
  };

  app.get("/:id/alerts", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    return c.json(publicConfig(await loadAlertConfig(deps.db, serverId)), 200);
  });

  app.put("/:id/alerts", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    const body = await readJson(c, putAlertConfigRequest);
    const bad = (field: string, msg: string) => new HttpError(400, "invalid_request", "Please check the highlighted fields", {}, { [field]: msg });
    if (!isValidTimeZone(body.quietHours.timeZone)) throw bad("quietHours", "Unknown time zone");
    await planCheck(serverId);
    const cur = await loadAlertConfig(deps.db, serverId);
    let enc = cur.webhookEnc;
    let masked = cur.webhookUrlMasked;
    let status: AlertConfig["webhookStatus"] = cur.webhookStatus;
    if (typeof body.webhookUrl === "string") {
      const url = body.webhookUrl.trim();
      // SSRF guard: only real Discord webhook URLs are ever stored (and so ever fetched).
      if (!DISCORD_WEBHOOK_RE.test(url)) throw bad("webhookUrl", "Paste a Discord webhook URL (https://discord.com/api/webhooks/…)");
      if (!deps.secretsKey) throw new HttpError(503, "provider_not_configured", "Alerts aren't set up on this server yet (SECRETS_KEY missing)");
      enc = encryptSecret(deps.secretsKey, url, serverId);
      masked = maskWebhook(url);
      status = "untested";
    } else if (body.webhookUrl === null) {
      enc = null;
      masked = null;
      status = "none";
    }
    if (body.enabled && !enc) throw bad("webhookUrl", "Add a Discord webhook before turning alerts on");
    const now = new Date(deps.now()).toISOString();
    await deps.db.execute(sql`
      insert into alert_configs (server_id, enabled, webhook_enc, webhook_masked, webhook_status, events, min_severity,
                                 offline_after_minutes, cooldown_minutes, quiet_hours, created_at, updated_at)
      values (${serverId}, ${body.enabled}, ${enc}, ${masked}, ${status}, ${JSON.stringify(body.events)}::jsonb, ${body.minSeverity},
              ${body.offlineAfterMinutes}, ${body.cooldownMinutes}, ${JSON.stringify(body.quietHours)}::jsonb, ${now}::timestamptz, ${now}::timestamptz)
      on conflict (server_id) do update set enabled = excluded.enabled, webhook_enc = excluded.webhook_enc,
             webhook_masked = excluded.webhook_masked, webhook_status = excluded.webhook_status, events = excluded.events,
             min_severity = excluded.min_severity, offline_after_minutes = excluded.offline_after_minutes,
             cooldown_minutes = excluded.cooldown_minutes, quiet_hours = excluded.quiet_hours, updated_at = excluded.updated_at`);
    return c.json(publicConfig(await loadAlertConfig(deps.db, serverId)), 200);
  });

  app.post("/:id/alerts/test", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    user(c);
    const retryAfter = deps.alertTestPerServer.hit(serverId, deps.now());
    if (retryAfter > 0) throw rateLimited(retryAfter);
    await planCheck(serverId);
    const r = await deps.alerts.sendTest(serverId);
    if (r === "no_webhook") {
      throw new HttpError(400, "invalid_request", "Save a Discord webhook first", {}, { webhookUrl: "Save a Discord webhook first" });
    }
    if (!r.ok) throw new HttpError(502, "webhook_failed", r.error ?? "Discord refused the message");
    return c.json({ ok: true as const, httpStatus: r.httpStatus ?? 200 }, 200);
  });

  app.get("/:id/alerts/deliveries", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    const q = parseQuery(c, deliveriesQuery);
    const r = await rows<{ id: string; event: string; status: string; http_status: number | null; error: string | null; incident_id: string | null; created_at: Date }>(
      deps.db,
      sql`select id, event, status, http_status, error, incident_id, created_at from alert_deliveries
           where server_id = ${serverId} order by created_at desc, id limit ${q.limit}`,
    );
    return c.json(
      {
        deliveries: r.map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          httpStatus: d.http_status,
          error: d.error,
          incidentId: d.incident_id,
          createdAt: iso(d.created_at),
        })),
      },
      200,
    );
  });

  return app;
}
