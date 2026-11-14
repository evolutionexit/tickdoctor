import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq, sql } from "drizzle-orm";
import {
  forgotPasswordRequest,
  loginRequest,
  magicLinkRequest,
  nextPath,
  resendVerificationRequest,
  resetPasswordRequest,
  discordCompleteRequest,
  type discordPendingResponse,
  signupRequest,
  verifyRequest,
  type SessionResponse,
  type verifyTokenInfo,
} from "@tickdoctor/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { oauthAccounts, users } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { bodyLimit } from "../middleware/body-limit.js";
import type { ClientIpResolver } from "../middleware/client-ip.js";
import { rateLimited, type RateLimitStore } from "../middleware/rate-limit.js";
import {
  clearSessionCookie,
  ensureCsrfCookie,
  requireUser,
  rotateCsrfCookie,
  setSessionCookie,
  type CookieOpts,
  type SessionEnv,
} from "../middleware/session.js";
import { hashPassword, randomToken, safeEqual, sha256Hex, verifyDummy, verifyPassword } from "../auth/crypto.js";
import { discordAuthorizeUrl, fetchDiscordProfile, type DiscordConfig, type FetchLike } from "../auth/discord.js";
import { mails, type MailMessage, type Mailer } from "../auth/mailer.js";
import {
  consumeEmailToken,
  createSession,
  deleteSessionByToken,
  deleteUserSessions,
  findUserByEmail,
  findUserById,
  confirmAccount,
  completeDiscordSignup,
  createDiscordPending,
  DISCORD_PENDING_TTL_MS,
  issueEmailToken,
  peekDiscordPending,
  peekEmailToken,
  signupTx,
  toSessionUser,
  type UserRow,
} from "../auth/store.js";
import { MAX_JSON_BYTES, readJson } from "./json.js";
import type { LiveHub } from "../live/hub.js";

export interface AuthLimiters {
  loginPerIp: RateLimitStore;
  loginPerEmail: RateLimitStore;
  signupPerIp: RateLimitStore;
  emailSendsPerEmail: RateLimitStore;
  emailSendsPerIp: RateLimitStore;
  /** GET /verify-token + POST /verify + /reset-password per IP (token guessing / scrypt CPU). */
  tokenPerIp: RateLimitStore;
}

export interface AuthRouteDeps {
  db: Db;
  now: () => number;
  clientIp: ClientIpResolver;
  cookies: CookieOpts;
  webOrigin: string;
  mailer: Mailer;
  limiters: AuthLimiters;
  discord?: DiscordConfig;
  /** Injectable for tests (mock Discord). */
  fetch?: FetchLike;
  log: (line: string) => void;
  /** Live streams are closed when sessions end. */
  hub?: Pick<LiveHub, "closeUser" | "closeSession">;
}

export const OAUTH_COOKIE = "td_oauth";
export const DISCORD_PENDING_COOKIE = "td_discord_pending";

/** Postgres 23505 (postgres.js error, possibly wrapped by drizzle as `cause`). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
const OAUTH_COOKIE_PATH = "/api/auth/discord";
const OAUTH_TTL_S = 600;
const DEFAULT_NEXT = "/app";
const tokenParam = z.string().min(20).max(200);

const safeNext = (v: unknown, fallback = DEFAULT_NEXT): string => {
  const p = nextPath.safeParse(v);
  return p.success && p.data ? p.data : fallback;
};

function limit(store: RateLimitStore, key: string, now: number) {
  const retryAfter = store.hit(key, now);
  if (retryAfter > 0) throw rateLimited(retryAfter);
}

type Ctx = Context<SessionEnv>;
/** ?error= codes on /login after a Discord sign-in (discord_email_exists: Discord never links by email at sign-in). */
type LoginErrorCode = "discord_failed" | "discord_email" | "discord_email_exists";

interface AuthHelpers {
  send: (msg: MailMessage) => void;
  link: (path: string, token: string, extra?: string) => string;
  emailSendLimit: (c: Context, email: string) => void;
  logIn: (c: Ctx, userId: string, next: string) => Promise<SessionResponse>;
  sendConfirm: (user: { id: string; email: string }, next?: string) => Promise<void>;
  pendingCookie: { httpOnly: boolean; sameSite: "Lax"; secure: boolean; path: string };
  invalidToken: () => HttpError;
  loginError: (c: Context, code: LoginErrorCode) => Response;
  accountError: (c: Context, code: "discord_failed" | "discord_in_use") => Response;
}

function makeHelpers(deps: AuthRouteDeps): AuthHelpers {
  /** Fire and forget: the response never depends on (or waits for) SMTP, so failures and timing reveal nothing. */
  const send = (msg: MailMessage) => {
    void deps.mailer.send(msg).catch((err: unknown) => {
      deps.log(`mail send failed ("${msg.subject}"): ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const link = (path: string, token: string, extra = "") => `${deps.webOrigin}${path}?token=${encodeURIComponent(token)}${extra}`;

  /** Shared limiter for magic-link / forgot-password / resend-verification (contract AUTH_LIMITS). */
  const emailSendLimit = (c: Context, email: string) => {
    const now = deps.now();
    limit(deps.limiters.emailSendsPerIp, deps.clientIp(c), now);
    limit(deps.limiters.emailSendsPerEmail, email, now);
  };

  async function logIn(c: Ctx, userId: string, next: string): Promise<SessionResponse> {
    const user = await findUserById(deps.db, userId);
    // Defence in depth: no route may create a session for an unconfirmed account.
    if (!user || !user.emailVerifiedAt) throw new HttpError(401, "invalid_credentials", "Wrong email or password");
    const old = getCookie(c, "td_session");
    if (old) await deleteSessionByToken(deps.db, old);
    const token = await createSession(deps.db, userId, deps.now());
    setSessionCookie(c, token, deps.cookies);
    rotateCsrfCookie(c, deps.cookies); // new privilege level → new CSRF token
    return { user: toSessionUser(user), next };
  }

  /** A fresh confirm link (kind verify) for an unconfirmed account; voids every earlier unused link. */
  async function sendConfirm(user: { id: string; email: string }, next?: string) {
    const token = await issueEmailToken(deps.db, user.id, "verify", deps.now(), next);
    send(mails.verify(user.email, link("/verify-email", token, "&kind=verify")));
  }

  const pendingCookie = { httpOnly: true, sameSite: "Lax" as const, secure: deps.cookies.secure, path: OAUTH_COOKIE_PATH };
  const invalidToken = () => new HttpError(400, "invalid_token", "This link is invalid or has expired");
  const loginError = (c: Context, code: LoginErrorCode) => c.redirect(`${deps.webOrigin}/login?error=${code}`, 302);
  const accountError = (c: Context, code: "discord_failed" | "discord_in_use") =>
    c.redirect(`${deps.webOrigin}/app/account?error=${code}`, 302);

  return { send, link, emailSendLimit, logIn, sendConfirm, pendingCookie, invalidToken, loginError, accountError };
}

const sessionHandler = (deps: AuthRouteDeps) => (c: Ctx) => {
  ensureCsrfCookie(c, deps.cookies);
  const s = c.get("session");
  const body: SessionResponse = { user: s ? toSessionUser(s.user) : null };
  return c.json(body, 200);
};

const signupHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  limit(deps.limiters.signupPerIp, deps.clientIp(c), deps.now());
  const body = await readJson(c, signupRequest);
  const now = deps.now();
  // Over the per-email send limit: still { ok: true } and the same statements, just no new token/mail.
  const mayMail = deps.limiters.emailSendsPerEmail.hit(body.email, now) === 0;
  const r = await signupTx(deps.db, body.email, now, mayMail, body.next);
  if (r.token && r.pending) h.send(mails.verify(body.email, h.link("/verify-email", r.token, "&kind=verify")));
  else if (r.token) h.send(mails.existingAccount(body.email, h.link("/verify-email", r.token, "&kind=magic")));
  return c.json({ ok: true as const }, 200);
};

const loginHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  const now = deps.now();
  limit(deps.limiters.loginPerIp, deps.clientIp(c), now);
  const body = await readJson(c, loginRequest);
  limit(deps.limiters.loginPerEmail, body.email, now);
  const user = await findUserByEmail(deps.db, body.email);
  // Unknown, unconfirmed and password-less accounts all pay for a scrypt check and get the same 401.
  const usable = user?.passwordHash && user.emailVerifiedAt ? user.passwordHash : null;
  const ok = usable ? await verifyPassword(body.password, usable) : await verifyDummy(body.password);
  if (!ok || !user) throw new HttpError(401, "invalid_credentials", "Wrong email or password");
  return c.json(await h.logIn(c, user.id, body.next ?? DEFAULT_NEXT), 200);
};

const logoutHandler = (deps: AuthRouteDeps) => async (c: Ctx) => {
  const token = getCookie(c, "td_session");
  if (token) {
    await deleteSessionByToken(deps.db, token);
    deps.hub?.closeSession(sha256Hex(token));
  }
  clearSessionCookie(c, deps.cookies);
  return c.json({ ok: true as const }, 200);
};

const logoutAllHandler = (deps: AuthRouteDeps) => async (c: Ctx) => {
  const user = requireUser(c);
  await deleteUserSessions(deps.db, user.id);
  deps.hub?.closeUser(user.id);
  clearSessionCookie(c, deps.cookies);
  return c.json({ ok: true as const }, 200);
};

// Known residual timing difference (documented): for an unknown email this does one SELECT and no write, a known
// one also locks the row and inserts a token (a few ms). Responses are identical and the per-email/IP send limits
// cap probing; signup, the main enumeration target, runs the same statements for every account state.
const magicLinkHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  const body = await readJson(c, magicLinkRequest);
  h.emailSendLimit(c, body.email);
  const user = await findUserByEmail(deps.db, body.email);
  if (user?.emailVerifiedAt) {
    const token = await issueEmailToken(deps.db, user.id, "magic", deps.now(), body.next);
    h.send(mails.magic(user.email, h.link("/verify-email", token, "&kind=magic")));
  } else if (user) {
    await h.sendConfirm(user, body.next);
  }
  return c.json({ ok: true as const }, 200);
};

/** Read-only: lets /verify-email show the password step. Consumes nothing. */
const verifyTokenHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  limit(deps.limiters.tokenPerIp, deps.clientIp(c), deps.now());
  const q = tokenParam.safeParse(c.req.query("token"));
  if (!q.success) throw h.invalidToken();
  const t = await peekEmailToken(deps.db, q.data, ["verify", "magic"], deps.now());
  // Magic links only for confirmed accounts, confirm links only for unconfirmed ones; anything else is stale.
  if (!t || (t.kind === "magic") !== t.userConfirmed) throw h.invalidToken();
  const body: z.infer<typeof verifyTokenInfo> = { kind: t.kind === "verify" ? "verify" : "magic", needsPassword: t.kind === "verify" };
  return c.json(body, 200);
};

type PeekedToken = NonNullable<Awaited<ReturnType<typeof peekEmailToken>>>;
type VerifyBody = z.infer<typeof verifyRequest>;

async function verifyMagic(deps: AuthRouteDeps, h: AuthHelpers, c: Ctx, t: PeekedToken, body: VerifyBody) {
  // Magic links are only issued to confirmed accounts; anything else is stale.
  if (!t.userConfirmed) throw h.invalidToken();
  const used = await consumeEmailToken(deps.db, body.token, ["magic"], deps.now());
  if (!used) throw h.invalidToken();
  return c.json(await h.logIn(c, used.userId, safeNext(used.next, "/app")), 200);
}

async function verifyConfirm(deps: AuthRouteDeps, h: AuthHelpers, c: Ctx, t: PeekedToken, body: VerifyBody) {
  if (t.userConfirmed) throw h.invalidToken(); // confirm links are only for unconfirmed accounts
  // Confirm link: password + binding consent (+ optional name) are given here. Missing → 400, token stays usable.
  const fields: Record<string, string> = {};
  if (!body.password) fields.password = "Choose a password";
  if (body.consent !== true) fields.consent = "Please accept the terms and privacy policy";
  if (Object.keys(fields).length) throw new HttpError(400, "invalid_request", "Please check the highlighted fields", {}, fields);
  // scrypt only runs once the token is known to be valid.
  const hash = await hashPassword(body.password!);
  const ok = await confirmAccount(deps.db, { tokenId: t.id, userId: t.userId, passwordHash: hash, displayName: body.displayName ?? null, nowMs: deps.now() });
  if (!ok) throw h.invalidToken();
  deps.hub?.closeUser(t.userId);
  return c.json(await h.logIn(c, t.userId, safeNext(t.next, "/app/onboarding")), 200);
}

const verifyHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  limit(deps.limiters.tokenPerIp, deps.clientIp(c), deps.now());
  const body = await readJson(c, verifyRequest);
  const t = await peekEmailToken(deps.db, body.token, ["verify", "magic"], deps.now());
  if (!t) throw h.invalidToken();
  if (t.kind === "magic") return verifyMagic(deps, h, c, t, body);
  return verifyConfirm(deps, h, c, t, body);
};

const resendVerificationHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  const body = await readJson(c, resendVerificationRequest);
  h.emailSendLimit(c, body.email);
  const user = await findUserByEmail(deps.db, body.email);
  if (user && !user.emailVerifiedAt) await h.sendConfirm(user);
  return c.json({ ok: true as const }, 200);
};

const forgotPasswordHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  const body = await readJson(c, forgotPasswordRequest);
  h.emailSendLimit(c, body.email);
  const user = await findUserByEmail(deps.db, body.email);
  if (user?.emailVerifiedAt) {
    const token = await issueEmailToken(deps.db, user.id, "reset", deps.now());
    h.send(mails.reset(user.email, h.link("/reset-password", token)));
  } else if (user) {
    await h.sendConfirm(user);
  }
  return c.json({ ok: true as const }, 200);
};

const resetPasswordHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  limit(deps.limiters.tokenPerIp, deps.clientIp(c), deps.now());
  const body = await readJson(c, resetPasswordRequest);
  // Token first: scrypt (CPU + 32 MB) only runs for a valid, unused token of a confirmed account.
  const t = await peekEmailToken(deps.db, body.token, ["reset"], deps.now());
  if (!t || !t.userConfirmed) throw h.invalidToken();
  const hash = await hashPassword(body.password);
  const used = await consumeEmailToken(deps.db, body.token, ["reset"], deps.now());
  if (!used) throw h.invalidToken();
  await deps.db.update(users).set({ passwordHash: hash }).where(eq(users.id, used.userId));
  await deleteUserSessions(deps.db, used.userId);
  deps.hub?.closeUser(used.userId);
  return c.json(await h.logIn(c, used.userId, DEFAULT_NEXT), 200);
};

// ---------- Discord ----------

const discordStartHandler = (deps: AuthRouteDeps) => (c: Ctx) => {
  if (!deps.discord) throw new HttpError(503, "provider_not_configured", "Discord sign-in is not configured");
  const linkMode = c.req.query("link") === "1";
  const session = c.get("session");
  if (linkMode && !session) return c.redirect(`${deps.webOrigin}/login?next=${encodeURIComponent("/app/account")}`, 302);
  const state = randomToken();
  const payload = {
    s: state,
    /** Explicit `next` only (null = mode default); a pending Discord signup keeps it for /discord/complete. */
    n: safeNext(c.req.query("next"), "") || null,
    u: linkMode ? session!.user.id : null,
  };
  setCookie(c, OAUTH_COOKIE, Buffer.from(JSON.stringify(payload)).toString("base64url"), {
    httpOnly: true,
    sameSite: "Lax", // sent on Discord's top-level redirect back to us
    secure: deps.cookies.secure,
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_TTL_S,
  });
  return c.redirect(discordAuthorizeUrl(deps.discord, state), 302);
};

interface OauthState {
  s: string;
  n: string;
  explicitNext: string | null;
  u: string | null;
}

function parseOauthState(raw: string | undefined): OauthState | null {
  try {
    const p = raw ? (JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>) : null;
    if (p && typeof p.s === "string" && (p.n === null || typeof p.n === "string") && (p.u === null || typeof p.u === "string")) {
      const explicitNext = safeNext(p.n, "") || null;
      return { s: p.s, n: explicitNext ?? (p.u ? "/app/account" : DEFAULT_NEXT), explicitNext, u: p.u };
    }
  } catch {
    return null;
  }
  return null;
}

type DiscordProfile = Awaited<ReturnType<typeof fetchDiscordProfile>>;

/** Linking from /app/account: the same user must still be signed in. */
async function linkDiscordAccount(
  deps: AuthRouteDeps,
  h: AuthHelpers,
  c: Ctx,
  st: OauthState,
  profile: DiscordProfile,
  linkedUserId: string | undefined,
) {
  const session = c.get("session");
  if (!session || session.user.id !== st.u) return h.accountError(c, "discord_failed");
  if (linkedUserId && linkedUserId !== st.u) return h.accountError(c, "discord_in_use");
  if (!linkedUserId) {
    await deps.db.transaction(async (tx) => {
      await tx.delete(oauthAccounts).where(sql`${oauthAccounts.userId} = ${st.u} and ${oauthAccounts.provider} = 'discord'`);
      await tx.insert(oauthAccounts).values({ provider: "discord", providerUserId: profile.id, userId: st.u! });
    });
  }
  return c.redirect(`${deps.webOrigin}${st.n}`, 302);
}

/**
 * No linked Discord account yet. Discord SIGN-IN never links by email (Michel, audit L10): when the verified
 * Discord email belongs to a CONFIRMED account → /login?error=discord_email_exists, with no link, no session and
 * nothing written. That owner signs in normally and links Discord from /app/account (st.u flow). Otherwise a
 * pending signup (consent on /signup/discord).
 */
async function resolveUnlinkedDiscord(
  deps: AuthRouteDeps,
  h: AuthHelpers,
  c: Ctx,
  st: OauthState,
  profile: DiscordProfile,
): Promise<Response> {
  if (!profile.verified || !profile.email) return h.loginError(c, "discord_email");
  const existing: UserRow | undefined = await findUserByEmail(deps.db, profile.email);
  // An UNCONFIRMED row with this email still counts as "no user" (unchanged, deliberately): it never had a
  // session, consent or data, and the pending Discord signup below takes it over only on /discord/complete with
  // the consent checkbox, the way a confirm link would (Discord's verified email proves the inbox).
  if (existing?.emailVerifiedAt) return h.loginError(c, "discord_email_exists");
  // No account yet: it is created only after the consent checkbox on /signup/discord (pending row, 10 min).
  // `next` is kept only when the start request carried one; otherwise complete defaults to /app/onboarding.
  const token = await createDiscordPending(deps.db, {
    discordUserId: profile.id,
    email: profile.email,
    next: st.explicitNext,
    nowMs: deps.now(),
  });
  setCookie(c, DISCORD_PENDING_COOKIE, token, { ...h.pendingCookie, maxAge: DISCORD_PENDING_TTL_MS / 1000 });
  return c.redirect(`${deps.webOrigin}/signup/discord`, 302);
}

const discordCallbackHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  const discord = deps.discord;
  if (!discord) throw new HttpError(503, "provider_not_configured", "Discord sign-in is not configured");
  const raw = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH, secure: deps.cookies.secure, httpOnly: true, sameSite: "Lax" });
  const st = parseOauthState(raw);
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!st || !state || !safeEqual(state, st.s) || !code || code.length > 500) return h.loginError(c, "discord_failed");

  let profile;
  try {
    profile = await fetchDiscordProfile(discord, code, deps.fetch);
  } catch (err) {
    deps.log(`discord callback failed: ${err instanceof Error ? err.message : String(err)}`);
    return st.u ? h.accountError(c, "discord_failed") : h.loginError(c, "discord_failed");
  }
  const linked = await deps.db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(sql`${oauthAccounts.provider} = 'discord' and ${oauthAccounts.providerUserId} = ${profile.id}`)
    .limit(1);
  const linkedUserId = linked[0]?.userId;

  if (st.u) return linkDiscordAccount(deps, h, c, st, profile, linkedUserId);

  if (!linkedUserId) return resolveUnlinkedDiscord(deps, h, c, st, profile);
  try {
    await h.logIn(c, linkedUserId, st.n);
  } catch (err) {
    // A linked account that isn't confirmed (pre-0007 data) never gets a session.
    if (err instanceof HttpError && err.status === 401) return h.loginError(c, "discord_email");
    throw err;
  }
  return c.redirect(`${deps.webOrigin}${st.n}`, 302);
};

// Pending Discord signup → /signup/discord (consent checkbox) → complete. Cookie sent only to these routes.
const discordPendingHandler = (deps: AuthRouteDeps) => async (c: Ctx) => {
  const token = getCookie(c, DISCORD_PENDING_COOKIE);
  const p = token ? await peekDiscordPending(deps.db, token, deps.now()) : null;
  if (!p) throw new HttpError(404, "not_found", "This Discord sign-up has expired; please start again");
  const body: z.infer<typeof discordPendingResponse> = { email: p.email };
  return c.json(body, 200);
};

const discordCompleteHandler = (deps: AuthRouteDeps, h: AuthHelpers) => async (c: Ctx) => {
  limit(deps.limiters.tokenPerIp, deps.clientIp(c), deps.now());
  // Missing consent → 400 fields.consent before anything is touched (the pending row stays usable).
  const body = await readJson(c, discordCompleteRequest);
  const token = getCookie(c, DISCORD_PENDING_COOKIE);
  if (!token) throw h.invalidToken();
  const r = await completeDiscordSignup(deps.db, { token, displayName: body.displayName ?? null, nowMs: deps.now() });
  if (!r.ok) throw h.invalidToken();
  deps.hub?.closeUser(r.userId); // a taken-over unconfirmed row had its sessions deleted
  deleteCookie(c, DISCORD_PENDING_COOKIE, h.pendingCookie);
  return c.json(await h.logIn(c, r.userId, safeNext(r.next, "/app/onboarding")), 200);
};

export function authRoutes(deps: AuthRouteDeps) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));
  const h = makeHelpers(deps);

  app.get("/session", sessionHandler(deps));
  app.post("/signup", signupHandler(deps, h));
  app.post("/login", loginHandler(deps, h));
  app.post("/logout", logoutHandler(deps));
  app.post("/logout-all", logoutAllHandler(deps));
  app.post("/magic-link", magicLinkHandler(deps, h));
  app.get("/verify-token", verifyTokenHandler(deps, h));
  app.post("/verify", verifyHandler(deps, h));
  app.post("/resend-verification", resendVerificationHandler(deps, h));
  app.post("/forgot-password", forgotPasswordHandler(deps, h));
  app.post("/reset-password", resetPasswordHandler(deps, h));
  app.get("/providers", (c) => c.json({ discord: deps.discord !== undefined }, 200));
  app.get("/discord", discordStartHandler(deps));
  app.get("/discord/callback", discordCallbackHandler(deps, h));
  app.get("/discord/pending", discordPendingHandler(deps));
  app.post("/discord/complete", discordCompleteHandler(deps, h));

  return app;
}
