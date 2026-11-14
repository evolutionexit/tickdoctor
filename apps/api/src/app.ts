import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { clientIpResolver, type ClientIpResolver } from "./middleware/client-ip.js";
import { FixedWindowLimiter, type RateLimitStore } from "./middleware/rate-limit.js";
import { RollingWindowCap, type GlobalCap } from "./middleware/global-cap.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { dbKeyVerifier, type IngestKeyVerifier } from "./ingest/auth.js";
import { AUTH_LIMITS } from "@tickdoctor/shared";
import { cookieSecure } from "./env.js";
import { serverRoutes } from "./routes/servers.js";
import { authRoutes, type AuthLimiters } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { downloadRoutes } from "./routes/downloads.js";
import { csrfProtection, sessionMiddleware, type SessionEnv } from "./middleware/session.js";
import { logOnlyMailer, type Mailer } from "./auth/mailer.js";
import type { DiscordConfig, FetchLike } from "./auth/discord.js";
import { LiveHub } from "./live/hub.js";
import { ingestDebugRoutes, ingestRoutes, type IngestRouteDeps } from "./ingest/routes.js";
import { detectInTx } from "./incidents/detector.js";
import { helloRulesTrigger } from "./findings/jobs.js";
import { IngestRing } from "./ingest/store.js";
import { AlertDispatcher } from "./alerts/dispatcher.js";
import { parseSecretsKey } from "./alerts/crypto.js";
import { findingRoutes, incidentRoutes, serverPhase6Routes } from "./routes/phase6.js";
import { badgeRoutes, publicStatusRoutes, statusPageRoutes } from "./routes/phase7.js";

/** Rate limiters, injectable so an in-memory store can later be replaced by Postgres/Redis. */
export interface AppLimiters {
  /** Per client IP on POST /api/waitlist (contract: 5 / 10 min). */
  waitlistPerIp: RateLimitStore;
  /** Global cap on new waitlist rows per rolling hour. */
  waitlistGlobal: GlobalCap;
  /** Per agent key on /v1/ingest/* (contract: ≈ 30 / min). Defaults to a fresh in-memory limiter. */
  ingestPerKey?: RateLimitStore;
  /** Per client IP on /v1/ingest/* and /v1/debug/*, counting only failed-auth requests. Defaults to a fresh in-memory limiter. */
  ingestPerIp?: RateLimitStore;
  /** Per server on /v1/ingest/snapshot (contract: ≤ 1 per 2 min). Defaults to a fresh in-memory limiter. */
  snapshotPerServer?: RateLimitStore;
  /** Phase 5 auth limits (contract AUTH_LIMITS). Defaults to fresh in-memory limiters. */
  auth?: AuthLimiters;
  /** POST /api/account/password per user. */
  passwordPerUser?: RateLimitStore;
  /** GET /api/account/export per user (contract: 3 / hour). */
  exportPerUser?: RateLimitStore;
  /** POST /api/servers/:id/alerts/test per server (contract: 5 / 10 min). */
  alertTestPerServer?: RateLimitStore;
  /** GET /api/public/status/:slug per client IP (contract: 60 / min). */
  publicStatusPerIp?: RateLimitStore;
  /** GET /badge/:slug.svg per client IP. */
  badgePerIp?: RateLimitStore;
}

const MIN = 60_000;
/**
 * Auth limiters fail closed when full (no eviction), so they track more keys: 50k buckets ≈ a few MB.
 */
const AUTH_MAX_KEYS = 50_000;
export function createAuthLimiters(): AuthLimiters {
  return {
    loginPerIp: new FixedWindowLimiter(AUTH_LIMITS.loginPerIpPer15Min, 15 * MIN, AUTH_MAX_KEYS),
    loginPerEmail: new FixedWindowLimiter(AUTH_LIMITS.loginPerEmailPer15Min, 15 * MIN, AUTH_MAX_KEYS),
    signupPerIp: new FixedWindowLimiter(AUTH_LIMITS.signupPerIpPerHour, 60 * MIN, AUTH_MAX_KEYS),
    emailSendsPerEmail: new FixedWindowLimiter(AUTH_LIMITS.emailSendsPerEmailPer15Min, 15 * MIN, AUTH_MAX_KEYS),
    emailSendsPerIp: new FixedWindowLimiter(AUTH_LIMITS.emailSendsPerIpPerHour, 60 * MIN, AUTH_MAX_KEYS),
    tokenPerIp: new FixedWindowLimiter(AUTH_LIMITS.tokenAttemptsPerIpPer15Min, 15 * MIN, AUTH_MAX_KEYS),
  };
}
/** Same budget as login per email: guessing the current password is a login attempt too. */
export const PASSWORD_CHANGES_PER_15_MIN = AUTH_LIMITS.loginPerEmailPer15Min;

export const ALERT_TESTS_PER_10_MIN = 5;
export const EXPORTS_PER_HOUR = 3;
export const INGEST_PER_KEY_PER_MINUTE = 30;
export const PUBLIC_STATUS_PER_IP_PER_MINUTE = 60;
/** Not in the contract: badges are embedded in READMEs and fetched through shared image proxies (GitHub camo). */
export const BADGE_PER_IP_PER_MINUTE = 600;
export const INGEST_PER_IP_PER_MINUTE = 60;

export const SNAPSHOT_WINDOW_MS = 2 * 60 * 1000;

export const DEFAULT_WAITLIST_GLOBAL_CAP_PER_HOUR = 200;

export function createLimiters(opts: { waitlistGlobalCapPerHour?: number } = {}) {
  return {
    waitlistPerIp: new FixedWindowLimiter(5, 10 * 60 * 1000, 10_000),
    waitlistGlobal: new RollingWindowCap(
      opts.waitlistGlobalCapPerHour ?? DEFAULT_WAITLIST_GLOBAL_CAP_PER_HOUR,
      60 * 60 * 1000,
    ),
    ingestPerKey: new FixedWindowLimiter(INGEST_PER_KEY_PER_MINUTE, 60 * 1000, 10_000),
    ingestPerIp: new FixedWindowLimiter(INGEST_PER_IP_PER_MINUTE, 60 * 1000, 10_000),
    snapshotPerServer: new FixedWindowLimiter(1, SNAPSHOT_WINDOW_MS, 10_000),
    auth: createAuthLimiters(),
    passwordPerUser: new FixedWindowLimiter(PASSWORD_CHANGES_PER_15_MIN, 15 * MIN, AUTH_MAX_KEYS),
    alertTestPerServer: new FixedWindowLimiter(ALERT_TESTS_PER_10_MIN, 10 * MIN, 10_000),
    exportPerUser: new FixedWindowLimiter(EXPORTS_PER_HOUR, 60 * MIN, AUTH_MAX_KEYS),
    publicStatusPerIp: new FixedWindowLimiter(PUBLIC_STATUS_PER_IP_PER_MINUTE, MIN, 10_000),
    badgePerIp: new FixedWindowLimiter(BADGE_PER_IP_PER_MINUTE, MIN, 10_000),
  } satisfies AppLimiters;
}

export interface AppDeps {
  db: Db;
  env: Pick<Env, "WEB_PUBLIC_URL" | "TRUST_PROXY"> &
    Partial<
      Pick<
        Env,
        | "WAITLIST_GLOBAL_CAP_PER_HOUR"
        | "API_KEY_PEPPER"
        | "INGEST_DEBUG"
        | "DEV_ADMIN_TOKEN"
        | "NODE_ENV"
        | "COOKIE_SECURE"
        | "AGENT_API_URL"
        | "AGENT_JAR_DIR"
        | "DISCORD_CLIENT_ID"
        | "DISCORD_CLIENT_SECRET"
        | "DISCORD_REDIRECT_URI"
        | "SECRETS_KEY"
      >
    >;
  /** Defaults to fresh in-memory limiters built from env. */
  limiters?: AppLimiters;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
  /** Override client-IP resolution (tests). Defaults to TRUST_PROXY-aware resolver. */
  clientIp?: ClientIpResolver;
  /** Agent key check; defaults to hashed per-server keys in Postgres (needs API_KEY_PEPPER). */
  ingestVerifier?: IngestKeyVerifier;
  /** Dev-only sink for accepted ingest payloads (exposed via /v1/debug/last when INGEST_DEBUG). */
  ingestRing?: IngestRing;
  /** Summary-line logger for ingest (tests capture it). */
  log?: (line: string) => void;
  /** Phase 4 incident detection after metrics ingest. Default: detectIncidents; `false` disables (tests). */
  detect?: IngestRouteDeps["detect"] | false;
  /** Phase 4 server-scope rules after hello. Default: a background pass; `false` disables (tests). */
  onHello?: IngestRouteDeps["onHello"] | false;
  /** Auth emails. Default: log-only (no SMTP). */
  mailer?: Mailer;
  /** Live SSE bus (index.ts starts its 15 s offline check). Default: a fresh hub. */
  hub?: LiveHub;
  /** fetch used for Discord (tests mock it). */
  fetch?: FetchLike;
  /** Discord base URL override (tests). */
  discordBaseUrl?: string;
  /** SSE ping interval (tests). */
  livePingMs?: number;
  /** Phase 6 Discord alerts. Default: a dispatcher from env (SECRETS_KEY) using `fetch`; index.ts runs its minute tick. */
  alerts?: AlertDispatcher;
}

/** Discord is enabled only when all three settings are present. */
export function discordConfig(env: AppDeps["env"], baseUrl?: string): DiscordConfig | undefined {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI) return undefined;
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    redirectUri: env.DISCORD_REDIRECT_URI,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

interface AppCtx {
  deps: AppDeps;
  now: () => number;
  webOrigin: string;
  clientIp: ClientIpResolver;
  limiters: AppLimiters;
  log: (line: string) => void;
  hub: LiveHub;
  cookies: { secure: boolean };
  adminToken: string | undefined;
}

type Phase7Deps = Parameters<typeof publicStatusRoutes>[0];

function healthRoute(app: Hono, deps: AppDeps) {
  app.get("/health", async (c) => {
    let db = false;
    try {
      await deps.db.execute(sql`select 1`);
      db = true;
    } catch {
      db = false;
    }
    return c.json({ ok: true as const, db });
  });
}

function phase7Deps(x: AppCtx): Phase7Deps {
  const { limiters } = x;
  return {
    db: x.deps.db,
    now: x.now,
    adminToken: x.adminToken,
    webOrigin: x.webOrigin,
    clientIp: x.clientIp,
    publicPerIp: limiters.publicStatusPerIp ?? new FixedWindowLimiter(PUBLIC_STATUS_PER_IP_PER_MINUTE, MIN, 10_000),
    badgePerIp: limiters.badgePerIp ?? new FixedWindowLimiter(BADGE_PER_IP_PER_MINUTE, MIN, 10_000),
  };
}

/** Browser-facing routes: session cookie + CSRF (contract app.ts). The Phase 1 waitlist keeps its own Origin guard. */
function applyApiMiddleware(api: Hono<SessionEnv>, x: AppCtx) {
  const isPublic = (path: string) => path === "/api/public" || path.startsWith("/api/public/");
  api.use("*", csrfProtection({ webOrigin: x.webOrigin, skip: (path) => path === "/api/waitlist" || isPublic(path) }));
  // Authenticated JSON must never be stored by a shared cache or the browser history cache (pentest F-05).
  // Only a default: routes that set their own Cache-Control (export, SSE) keep it; /api/public is excluded.
  api.use("*", async (c, next) => {
    await next();
    if (!isPublic(c.req.path) && !c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
  });
  const session = sessionMiddleware({ db: x.deps.db, now: x.now, cookies: x.cookies });
  api.use("*", (c, next) => (isPublic(c.req.path) ? next() : session(c, next)));
}

function mountWaitlistAuthAccount(api: Hono<SessionEnv>, x: AppCtx) {
  const { deps, limiters } = x;
  api.route(
    "/waitlist",
    waitlistRoutes({
      db: deps.db,
      webOrigin: x.webOrigin,
      clientIp: x.clientIp,
      now: x.now,
      perIpLimiter: limiters.waitlistPerIp,
      globalCap: limiters.waitlistGlobal,
    }),
  );
  api.route(
    "/auth",
    authRoutes({
      db: deps.db,
      now: x.now,
      clientIp: x.clientIp,
      cookies: x.cookies,
      webOrigin: x.webOrigin,
      mailer: deps.mailer ?? logOnlyMailer(x.log),
      limiters: limiters.auth ?? createAuthLimiters(),
      discord: discordConfig(deps.env, deps.discordBaseUrl),
      fetch: deps.fetch,
      log: x.log,
      hub: x.hub,
    }),
  );
  api.route(
    "/account",
    accountRoutes({
      db: deps.db,
      now: x.now,
      passwordPerUser: limiters.passwordPerUser ?? new FixedWindowLimiter(PASSWORD_CHANGES_PER_15_MIN, 15 * MIN, AUTH_MAX_KEYS),
      exportPerUser: limiters.exportPerUser ?? new FixedWindowLimiter(EXPORTS_PER_HOUR, 60 * MIN, AUTH_MAX_KEYS),
      hub: x.hub,
      mailer: deps.mailer ?? logOnlyMailer(x.log),
      cookies: x.cookies,
      log: x.log,
    }),
  );
}

function mountServerRoutes(api: Hono<SessionEnv>, x: AppCtx) {
  const { deps } = x;
  if (!deps.env.API_KEY_PEPPER && !deps.ingestVerifier) throw new Error("createApp: API_KEY_PEPPER (or an ingestVerifier) is required");
  api.route(
    "/servers",
    serverRoutes({
      db: deps.db,
      now: x.now,
      pepper: deps.env.API_KEY_PEPPER ?? "",
      agentApiUrl: deps.env.AGENT_API_URL ?? x.webOrigin,
      agentJarDir: deps.env.AGENT_JAR_DIR,
      adminToken: x.adminToken,
      hub: x.hub,
      pingIntervalMs: deps.livePingMs,
    }),
  );
}

function createAlerts(x: AppCtx): AlertDispatcher {
  const { deps } = x;
  return (
    deps.alerts ??
    new AlertDispatcher({
      db: deps.db,
      now: x.now,
      webOrigin: x.webOrigin,
      secretsKey: deps.env.SECRETS_KEY ? parseSecretsKey(deps.env.SECRETS_KEY) : undefined,
      fetch: deps.fetch,
      log: x.log,
    })
  );
}

function mountPhase6And7Routes(api: Hono<SessionEnv>, x: AppCtx, alerts: AlertDispatcher, phase7: Phase7Deps) {
  const { deps } = x;
  const phase6 = {
    db: deps.db,
    now: x.now,
    adminToken: x.adminToken,
    alerts,
    secretsKey: deps.env.SECRETS_KEY ? parseSecretsKey(deps.env.SECRETS_KEY) : undefined,
    alertTestPerServer: x.limiters.alertTestPerServer ?? new FixedWindowLimiter(ALERT_TESTS_PER_10_MIN, 10 * MIN, 10_000),
  };
  api.route("/servers", serverPhase6Routes(phase6));
  api.route("/incidents", incidentRoutes(phase6));
  api.route("/findings", findingRoutes(phase6));
  api.route("/servers", statusPageRoutes(phase7));
}

/** Agent-facing routes (API-key auth, ingest). Errors use the ingest shape { ok: false, error }. */
function buildV1(x: AppCtx, alerts: AlertDispatcher) {
  const { deps, limiters, hub } = x;
  const v1 = new Hono();
  let verifier = deps.ingestVerifier;
  if (!verifier) {
    if (!deps.env.API_KEY_PEPPER) throw new Error("createApp: API_KEY_PEPPER (or an ingestVerifier) is required");
    verifier = dbKeyVerifier(deps.db, deps.env.API_KEY_PEPPER);
  }
  const ring = deps.env.INGEST_DEBUG ? (deps.ingestRing ?? new IngestRing(20)) : undefined;
  const ingestPerIp =
    limiters.ingestPerIp ?? new FixedWindowLimiter(INGEST_PER_IP_PER_MINUTE, 60 * 1000, 10_000);
  v1.route(
    "/ingest",
    ingestRoutes({
      verifier,
      failedAuthPerIpLimiter: ingestPerIp,
      clientIp: x.clientIp,
      perKeyLimiter:
        limiters.ingestPerKey ?? new FixedWindowLimiter(INGEST_PER_KEY_PER_MINUTE, 60 * 1000, 10_000),
      snapshotPerServerLimiter: limiters.snapshotPerServer ?? new FixedWindowLimiter(1, SNAPSHOT_WINDOW_MS, 10_000),
      db: deps.db,
      ring,
      now: x.now,
      log: x.log,
      onSamples: (serverId, samples) => hub.publishSamples(serverId, samples),
      // Alerts never block or fail ingest: a coalesced background check per server.
      onIngested: (serverId) => void alerts.kick(serverId),
      detect: deps.detect === false ? undefined : (deps.detect ?? detectInTx),
      onHello:
        deps.onHello === false
          ? undefined
          : (deps.onHello ?? ((t) => (serverId: string, nowMs: number) => t.trigger(serverId, nowMs))(helloRulesTrigger(deps.db))),
    }),
  );
  if (ring) v1.route("/debug", ingestDebugRoutes({ verifier, ring, failedAuthPerIpLimiter: ingestPerIp, clientIp: x.clientIp, now: x.now }));
  return v1;
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  // Origin only (no trailing slash), like loadEnv does: CSRF Origin checks and links (no "//app" in alert links).
  const webOrigin = new URL(deps.env.WEB_PUBLIC_URL).origin;
  const clientIp = deps.clientIp ?? clientIpResolver(deps.env.TRUST_PROXY);
  const limiters =
    deps.limiters ?? createLimiters({ waitlistGlobalCapPerHour: deps.env.WAITLIST_GLOBAL_CAP_PER_HOUR });

  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  healthRoute(app, deps);

  const log = deps.log ?? ((line: string) => console.log(line));
  const hub = deps.hub ?? new LiveHub({ db: deps.db, now, log });
  const cookies = { secure: cookieSecure({ COOKIE_SECURE: deps.env.COOKIE_SECURE ?? "", NODE_ENV: deps.env.NODE_ENV ?? "development" }) };
  const adminToken = deps.env.NODE_ENV === "production" ? undefined : deps.env.DEV_ADMIN_TOKEN;
  const x: AppCtx = { deps, now, webOrigin, clientIp, limiters, log, hub, cookies, adminToken };

  // Phase 7 public routes: no auth, no cookies read or set. Mounted before /api so the session middleware never
  // runs for them (and skipped there too for unknown /api/public/* paths).
  const phase7 = phase7Deps(x);
  app.route("/api/public", publicStatusRoutes(phase7));
  app.route("/badge", badgeRoutes(phase7));

  const api = new Hono<SessionEnv>();
  applyApiMiddleware(api, x);
  mountWaitlistAuthAccount(api, x);
  mountServerRoutes(api, x);
  const alerts = createAlerts(x);
  mountPhase6And7Routes(api, x, alerts, phase7);
  app.route("/api", api);
  app.route("/downloads", downloadRoutes({ agentJarDir: deps.env.AGENT_JAR_DIR }));

  app.route("/v1", buildV1(x, alerts));

  return app;
}
