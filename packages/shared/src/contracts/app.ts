import { z } from "zod";
import { METRIC_NAMES } from "./metrics";
import { RULE_IDS, SEVERITIES } from "./findings";

// Phase 5 contract (frozen after Phase 5 starts): the app API used by apps/web. Explained in docs/contracts.md §3.
// All routes are same-origin under /api (Caddy). JSON in and out. Errors: { error: { code, message, fields? } }.

// ---------------------------------------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------------------------------------

export const SESSION_COOKIE = "td_session"; // httpOnly, SameSite=Lax, Path=/, Secure when COOKIE_SECURE=true, 30 days sliding
export const CSRF_COOKIE = "td_csrf"; // NOT httpOnly (the web app reads it), SameSite=Lax, Path=/
export const CSRF_HEADER = "x-csrf-token";

/**
 * CSRF (every non-GET/HEAD under /api, including signup/login, except POST /api/waitlist which keeps its Phase 1 guard):
 *   1. Origin header must equal WEB_PUBLIC_URL (missing → reject), AND
 *   2. header x-csrf-token must equal the td_csrf cookie (double submit).
 * GET /api/auth/session always (re)issues td_csrf when missing, so the web app calls it once on load.
 * Failure → 403 { error: { code: "csrf_failed" } }.
 */

export const API_ERROR_CODES = [
  "invalid_request", // 400, zod failure; `fields` maps field → message
  "unauthorized", // 401 no/expired session
  "email_not_verified", // 403 action needs a verified email (creating a server)
  "csrf_failed", // 403
  "bad_origin", // 403 (waitlist only)
  "not_found", // 404 also for servers/incidents of another user (never 403)
  "conflict", // 409
  "invalid_token", // 400 expired/used/unknown email token
  "invalid_credentials", // 401 login: wrong email or password (same message for both)
  "plan_limit", // 402 e.g. server count
  "payload_too_large", // 413
  "rate_limited", // 429 + Retry-After header
  "provider_not_configured", // 503 Discord env missing
  "webhook_failed", // 502 alert test: Discord refused or unreachable (Phase 6)
  "internal", // 500
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export const apiErrorBody = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

/** Rate limits (per process, in-memory like the waitlist). Exceeding → 429 rate_limited + Retry-After. */
export const AUTH_LIMITS = {
  loginPerIpPer15Min: 20,
  loginPerEmailPer15Min: 10,
  signupPerIpPerHour: 10,
  /** magic-link + forgot-password + resend-verification, counted together */
  emailSendsPerEmailPer15Min: 3,
  emailSendsPerIpPerHour: 20,
  /** POST /api/auth/verify + /api/auth/reset-password, counted together */
  tokenAttemptsPerIpPer15Min: 30,
} as const;

// ---------------------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().email().max(254);
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
/** Same-site relative path only ("/app/servers/…"); anything else → "/app". Validated by the API and the web app. */
export const nextPath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/)
  .optional();

/** Token lifetimes (email_tokens; stored as sha256, single use). */
export const EMAIL_TOKEN_TTL = { verifyHours: 24, magicLinkMinutes: 15, resetMinutes: 60 } as const;
export const SESSION_TTL_DAYS = 30;

/**
 * Account confirmation model (Michel, 2026-11-10 — replaces "unverified users may log in"):
 *   - An UNCONFIRMED account (email_verified_at null) can never log in or hold a session. It has no password:
 *     the password is chosen only on the page the confirmation link opens, after the "Continue" step.
 *   - The session middleware ignores (and deletes) any session whose user is unconfirmed (defence in depth).
 *   - Every "send me a link" path for an unconfirmed (or CLI-created) account sends a fresh CONFIRM link
 *     (kind "verify" → /verify-email?token=…&kind=verify), never a magic or reset link. Issuing it voids all
 *     earlier unused tokens of that user.
 *
 * POST /api/auth/signup { email, next? }   — no password or consent field (a body that includes
 *   one is rejected by the strict schema → 400; it is never stored or logged).
 * → 200 { ok: true } ALWAYS for a valid body (no account enumeration).
 *   New email: creates an unconfirmed user (no password) and sends a confirm link.
 *   Unconfirmed existing email: resets the pending row (consent_at = null; password, display name, sessions,
 *     tokens and oauth links of the earlier attempt are removed), voids old tokens, sends a new confirm link. The upsert,
 *     void and token insert run in one transaction.
 *   Confirmed existing email: sends a "you already have an account" email with a magic link; changes nothing.
 * Signup does NOT log in. The page shows a sentence ("We'll email you a link to finish creating your account" + privacy
 * policy link) instead of a checkbox (Michel, 2026-11-10). The only consent record is the checkbox on the password page (verify).
 * Pending (unconfirmed) users without servers are deleted 7 days after their last signup by the hourly retention job.
 */
export const signupRequest = z
  .object({
    email,
    next: nextPath,
  })
  .strict();

/** POST /api/auth/login { email, password } → 200 sessionResponse + Set-Cookie, or 401 invalid_credentials. Unconfirmed accounts always get the same 401 invalid_credentials (they have no password). */
export const loginRequest = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX), next: nextPath });

/** POST /api/auth/logout → 200 { ok: true }, deletes the session row, clears the cookie. POST /api/auth/logout-all → ends every session of the user. */

/**
 * POST /api/auth/magic-link { email } → 200 { ok: true } always. Sends a link to /verify-email?token=…&kind=magic.
 * Unknown email: creates no account and sends nothing (still 200). (Signing up stays explicit.)
 * Unconfirmed account: sends a confirm link (kind verify) instead — same response.
 */
export const magicLinkRequest = z.object({ email, next: nextPath });

/** POST /api/auth/resend-verification { email } → 200 { ok: true } always (no session exists before confirmation).
 * Unconfirmed account → new confirm link (voids older ones); confirmed or unknown → sends nothing. Same per-email/IP send limits. */
export const resendVerificationRequest = z.object({ email });

/**
 * POST /api/auth/verify { token, password? } — the /verify-email page posts the token from its URL only after the user
 * presses "Continue" (GET links never change state; scanners can't consume them).
 * GET /api/auth/verify-token?token=… → 200 { kind: "verify" | "magic", needsPassword: boolean } or 400 invalid_token.
 *   Read-only (consumes nothing); lets the page show the password step. Rate-limited with tokenAttemptsPerIpPer15Min.
 * Kind "verify" (confirm): `password` and `consent: true` REQUIRED, `displayName` optional. Missing/invalid →
 *   400 invalid_request with fields.password / fields.consent and the token is NOT consumed. Valid → in one transaction:
 *   consume token, set password_hash, email_verified_at, consent_at = now, display_name = this request's value or null,
 *   delete any sessions, other tokens and oauth links of the user, then log in. A verify token whose user is already
 *   confirmed → 400 invalid_token.
 * Kind "magic" (only ever issued to confirmed accounts): logs in; `password` ignored.
 * Response `next`: the `next` stored with the token if one was requested; otherwise "/app/onboarding" for kind verify
 *   and "/app" for kind magic.
 * → 200 sessionResponse + Set-Cookie, or 400 invalid_token.
 */
export const verifyRequest = z.object({
  token: z.string().min(20).max(200),
  password: password.optional(),
  consent: z.literal(true).optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
});
export const discordCompleteRequest = z.object({ consent: z.literal(true), displayName: z.string().trim().min(1).max(60).optional() });
export const discordPendingResponse = z.object({ email: z.string() });
export const verifyTokenInfo = z.object({ kind: z.enum(["verify", "magic"]), needsPassword: z.boolean() });

/** POST /api/auth/forgot-password { email } → 200 { ok: true } always; confirmed account → reset link (/reset-password?token=…);
 * unconfirmed account → confirm link instead; unknown → nothing. */
export const forgotPasswordRequest = z.object({ email });

/** POST /api/auth/reset-password { token, password } → 200 sessionResponse + Set-Cookie. Ends all other sessions. Reset tokens exist only for confirmed accounts. */
export const resetPasswordRequest = z.object({ token: z.string().min(20).max(200), password });

/**
 * Discord (optional, config-gated):
 * GET /api/auth/providers → { discord: boolean } (true only when DISCORD_CLIENT_ID/SECRET/REDIRECT_URI are set).
 * GET /api/auth/discord?next=… → 302 to Discord (scope "identify email", state = random, stored in a short httpOnly cookie
 *     td_oauth, 10 min). Not configured → 503 provider_not_configured.
 * GET /api/auth/discord/callback?code&state → state must match the cookie. Then:
 *   - known oauth_accounts(discord, discordUserId) → log that user in;
 *   - else if Discord says the email is verified AND a user with that email exists AND that user's email is verified → link + log in;
 *   - else if Discord email verified and no user has it → NO account yet: store a pending Discord signup (Discord id,
 *     email, next; server-side row, random token, 10 min, single use; token in an httpOnly SameSite=Lax cookie
 *     td_discord_pending) and 302 /signup/discord. That page shows the email + the same consent checkbox as the password
 *     page and posts:
 *     GET /api/auth/discord/pending → 200 { email } or 404 not_found (no/expired cookie).
 *     POST /api/auth/discord/complete { consent: true, displayName? } (CSRF) → creates a confirmed user (consent_at = now)
 *     + link + log in → 200 sessionResponse (next from the pending row, default /app/onboarding). Missing consent → 400
 *     fields.consent (pending row kept). Expired/used → 400 invalid_token. Discord id linked to someone meanwhile → 400
 *     invalid_token. Email belongs to a CONFIRMED user meanwhile → 400 invalid_token. Email belongs to an UNCONFIRMED user
 *     (pending signup or CLI-created) → that row is taken over: confirmed (consent_at now, display name from this request,
 *     its tokens voided) + linked — Discord's verified email proves the inbox like a confirm link.
 *   - otherwise (unverified Discord email, or the matching CONFIRMED local account is already linked to a different Discord id) → no login, redirect /login?error=discord_email. Phase 8 (L10): a verified Discord email that matches an existing CONFIRMED local account is NEVER auto-linked: no link, no session, no pending row, redirect /login?error=discord_email_exists (the user logs in normally first and connects Discord from /app/account). A matching UNCONFIRMED local account counts as "no user" (pending signup → takeover on complete).
 *   Success → 302 to `next` (default /app). Errors → 302 /login?error=discord_failed. No Discord tokens are stored (we only need the id).
 * Logged-in users can link from /app/account: GET /api/auth/discord?link=1 (links to the current user; no email checks, the user is
 *   signed in on both sides). That Discord id already linked to another user → 302 /app/account?error=discord_in_use;
 *   other failures → 302 /app/account?error=discord_failed.
 */
export const providersResponse = z.object({ discord: z.boolean() });

export const PLAN_IDS = ["free", "pro", "network"] as const;

export const sessionUser = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  emailVerified: z.boolean(),
  plan: z.enum(PLAN_IDS),
  /** Phase 8: the plan the limits actually use (BETA_ALL_PRO may lift free → pro), and why. */
  effectivePlan: z.enum(PLAN_IDS),
  planSource: z.enum(["stored", "beta"]),
  hasPassword: z.boolean(),
  discordLinked: z.boolean(),
  createdAt: z.string(),
});
export type SessionUser = z.infer<typeof sessionUser>;

/** GET /api/auth/session → 200 { user: SessionUser | null } (never 401; sets td_csrf if missing). Login-ish endpoints return the same with `next`. */
export const sessionResponse = z.object({ user: sessionUser.nullable(), next: z.string().optional() });
export type SessionResponse = z.infer<typeof sessionResponse>;

// ---------------------------------------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------------------------------------

/**
 * Health state — ONE function in apps/api decides it (and the web app only displays it):
 *   - "offline":  no metrics sample for > OFFLINE_AFTER_SECONDS (or never → "waiting" instead)
 *   - "lagging":  an incident is open
 *   - "degraded": no open incident, but over the last 5 min the median of mspt_p95 ≥ 40 ms or of tps_1m < 19
 *   - "healthy":  otherwise
 *   - "waiting":  the server never sent data (onboarding not finished)
 * UI: always icon + word + colour (colour-blind safe), never colour alone.
 */
export const HEALTH_STATES = ["healthy", "degraded", "lagging", "offline", "waiting"] as const;
export type ServerHealth = (typeof HEALTH_STATES)[number]; // brand.ts HealthState = the four colour states; "waiting" is shown like offline with its own icon + word
export const OFFLINE_AFTER_SECONDS = 90;
export const DEGRADED = { windowSeconds: 300, msptP95: 40, tps1m: 19 } as const;

export const latestSample = z.object({
  ts: z.string(),
  tps1m: z.number().nullable(),
  msptAvg: z.number().nullable(),
  msptP95: z.number().nullable(),
  players: z.number().int().nullable(),
});
export type LatestSample = z.infer<typeof latestSample>;

export const serverSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  plan: z.enum(PLAN_IDS),
  createdAt: z.string(),
  firstSeenAt: z.string().nullable(), // first metrics sample ever (null = waiting)
  lastSeenAt: z.string().nullable(),
  health: z.enum(HEALTH_STATES),
  latest: latestSample.nullable(),
  openIncidents: z.number().int(),
  /** Most severe open finding (ties → newest lastSeenAt); tuning tips (severity info) are never shown here. */
  topFinding: z
    .object({ id: z.string().uuid(), ruleId: z.enum(RULE_IDS), severity: z.enum(SEVERITIES), title: z.string() })
    .nullable(),
});
export type ServerSummary = z.infer<typeof serverSummary>;

/** GET /api/servers → { servers: ServerSummary[] } (owner's servers, newest first), plus the plan's server limit. */
export const serverListResponse = z.object({
  servers: z.array(serverSummary),
  limits: z.object({ plan: z.enum(PLAN_IDS), planSource: z.enum(["stored", "beta"]), maxServers: z.number().int(), used: z.number().int() }), // plan = effective plan (Phase 8)
});

export const serverName = z.string().trim().min(1).max(60);

/**
 * POST /api/servers { name } → 201 createdServerResponse. Needs a verified email (403 email_not_verified) and a free
 * slot in the user's plan (402 plan_limit). The plaintext key appears ONLY in this response and in rotate-key.
 * New servers get the user's plan (users.plan; servers.plan stays as the per-server value the limits module reads).
 */
export const createServerRequest = z.object({ name: serverName });
export const agentSetup = z.object({
  apiKey: z.string(), // td_live_…, shown once
  keyPrefix: z.string(),
  /** Ready-to-paste plugins/TickDoctor/config.yml lines: api-url (env AGENT_API_URL, default WEB_PUBLIC_URL) + api-key. */
  configSnippet: z.string(),
  downloadUrl: z.string(), // "/downloads/agent/latest.jar"
  agentVersion: z.string(), // e.g. "0.1.2"
});
export const createdServerResponse = z.object({ server: serverSummary, setup: agentSetup });

/** GET /api/servers/:id → serverDetail. 404 if missing or not the user's. */
export const serverDetail = serverSummary.extend({
  keyPrefix: z.string().nullable(), // active key's display prefix (null if all revoked)
  keyCreatedAt: z.string().nullable(),
  info: z
    .object({
      software: z.string(), // e.g. "Paper 26.2 (build 83)"
      minecraftVersion: z.string(),
      javaVersion: z.string(),
      agentVersion: z.string(),
      host: z.object({ os: z.string(), arch: z.string(), cpuModel: z.string().optional(), cores: z.number().int(), memTotalBytes: z.number() }),
      viewDistance: z.number().int(),
      simulationDistance: z.number().int(),
      heapMaxBytes: z.number(),
      plugins: z.number().int(),
      since: z.string(), // valid_from of the current server_info_history row
    })
    .nullable(),
});
export type ServerDetail = z.infer<typeof serverDetail>;

/** PATCH /api/servers/:id { name } → serverDetail. (Slug changes come with status pages in Phase 7.) */
export const updateServerRequest = z.object({ name: serverName });

/** DELETE /api/servers/:id { confirmName } → 200 { ok: true }. confirmName must equal the current name (400 otherwise). Cascades all data. */
export const deleteServerRequest = z.object({ confirmName: z.string().max(60) });

/** POST /api/servers/:id/rotate-key → agentSetup. Old key revoked immediately (the agent gets 401 until the new key is pasted). */

/**
 * GET /api/servers/:id/first-data → polled by onboarding every 2 s (also pushed via SSE `status`).
 * received = at least one hello or metrics call arrived with this server's key.
 */
export const firstDataResponse = z.object({
  received: z.boolean(),
  helloAt: z.string().nullable(),
  firstSampleAt: z.string().nullable(),
  software: z.string().nullable(),
  agentVersion: z.string().nullable(),
  health: z.enum(HEALTH_STATES),
});

/**
 * GET /api/servers/:id/metrics?metric&from&to → metricsResponse (contracts/metrics.ts, unchanged). Auth: session + owner.
 * (DEV_ADMIN_TOKEN bearer stays accepted on GET routes only, dev only, refused in production — e2e convenience.)
 *
 * GET /api/servers/:id/metrics/batch?metrics=a,b,c&from&to → { series: MetricsResponse[] } (≤ 8 metrics, same rules) so the
 * dashboard doesn't fire 8 requests per range change.
 */
export const metricsBatchQuery = z.object({
  metrics: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()))
    .pipe(z.array(z.enum(METRIC_NAMES)).min(1).max(8)),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

/**
 * GET /api/servers/:id/incidents?from&to&limit → { incidents: IncidentListItem[] } newest first (default last 30 days, limit ≤ 200).
 * Phase 5 uses it for incident markers on graphs and counts; the full incident page/endpoint is Phase 6.
 */
export const incidentListItem = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  severity: z.enum(["medium", "high", "critical"]),
  peakMsptP95: z.number(),
  minTps1m: z.number().nullable(),
  trigger: z.enum(["mspt", "tps"]),
});
export type IncidentListItem = z.infer<typeof incidentListItem>;

// ---------------------------------------------------------------------------------------------------------
// Live (Server-Sent Events)
// ---------------------------------------------------------------------------------------------------------

/**
 * GET /api/servers/:id/live → text/event-stream (session + owner; 404 otherwise).
 * On connect: one `status` event, then the last sample as `sample` (if any). Afterwards, per ingested sample a `sample`
 * event, and a `status` event whenever health changes (incl. offline after OFFLINE_AFTER_SECONDS — the API checks
 * open streams every 15 s). Comment line `: ping` every 15 s. `retry: 5000`.
 * One API process: an in-process event bus fed by the ingest route (multi-instance would need LISTEN/NOTIFY — later).
 * Max 5 open streams per user (6th → 429).
 */
export const liveSampleEvent = latestSample.extend({
  hostCpu: z.number().nullable(),
  cpuTempC: z.number().nullable(),
  heapUsedBytes: z.number().nullable(),
  heapMaxBytes: z.number().nullable(),
  memAvailableBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
});
export const liveStatusEvent = z.object({
  health: z.enum(HEALTH_STATES),
  lastSeenAt: z.string().nullable(),
  openIncidentId: z.string().uuid().nullable(),
});

// ---------------------------------------------------------------------------------------------------------
// Account (Phase 5 subset; export + delete come in Phase 8)
// ---------------------------------------------------------------------------------------------------------

/** GET /api/account → { user: SessionUser }. PATCH /api/account { displayName } → same. */
export const updateAccountRequest = z.object({ displayName: z.string().trim().min(1).max(60).nullable() });
/** POST /api/account/password { currentPassword?, newPassword } → 200 { ok: true }; currentPassword required when hasPassword; ends other sessions. */
export const changePasswordRequest = z.object({
  currentPassword: z.string().max(PASSWORD_MAX).optional(),
  newPassword: password,
});

// ---------------------------------------------------------------------------------------------------------
// Agent download
// ---------------------------------------------------------------------------------------------------------

/**
 * GET /downloads/agent/latest.jar → the newest agent jar (public, no auth), served from AGENT_JAR_DIR (the newest
 * tickdoctor-agent-<semver>.jar by version), Content-Disposition attachment with the versioned file name,
 * plus header X-Agent-Version. 404 not_found when no jar exists.
 */
