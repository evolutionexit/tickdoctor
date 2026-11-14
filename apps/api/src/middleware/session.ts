import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { HttpError } from "../errors.js";
import { randomToken, safeEqual } from "../auth/crypto.js";
import { SESSION_TTL_MS, resolveSession, type ActiveSession, type UserRow } from "../auth/store.js";

export type SessionEnv = { Variables: { session: ActiveSession | null } };

export interface CookieOpts {
  secure: boolean;
}

export function setSessionCookie(c: Context, token: string, opts: CookieOpts) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: opts.secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, opts: CookieOpts) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: opts.secure, httpOnly: true, sameSite: "Lax" });
}

/** Issues td_csrf (readable by the web app) when the request has none. */
export function ensureCsrfCookie(c: Context, opts: CookieOpts) {
  if (getCookie(c, CSRF_COOKIE)) return;
  setCookie(c, CSRF_COOKIE, randomToken(), {
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
    secure: opts.secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Always issues a fresh td_csrf (on login: the token from before login must not stay valid). */
export function rotateCsrfCookie(c: Context, opts: CookieOpts) {
  setCookie(c, CSRF_COOKIE, randomToken(), {
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
    secure: opts.secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Resolves td_session (30-day sliding expiry) into c.var.session; never rejects by itself. */
export function sessionMiddleware(deps: { db: Db; now: () => number; cookies: CookieOpts }): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    let session: ActiveSession | null = null;
    if (token) {
      session = await resolveSession(deps.db, token, deps.now());
      if (!session) clearSessionCookie(c, deps.cookies);
      else if (session.refreshed) setSessionCookie(c, token, deps.cookies);
    }
    c.set("session", session);
    await next();
  };
}

/** The logged-in user, or 401 unauthorized. */
export function requireUser(c: Context<SessionEnv>): UserRow {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Please sign in");
  return s.user;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF for every state-changing /api request (contract app.ts): Origin must equal WEB_PUBLIC_URL (missing → reject)
 * AND x-csrf-token must equal the td_csrf cookie (double submit). `skip` exempts paths (the Phase 1 waitlist).
 */
export function csrfProtection(opts: { webOrigin: string; skip: (path: string) => boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE.has(c.req.method) || opts.skip(c.req.path)) return next();
    const origin = c.req.header("origin");
    const cookie = getCookie(c, CSRF_COOKIE);
    const header = c.req.header(CSRF_HEADER);
    const ok = origin === opts.webOrigin && !!cookie && !!header && cookie.length >= 16 && safeEqual(cookie, header);
    if (!ok) throw new HttpError(403, "csrf_failed", "Security check failed; reload the page and try again");
    await next();
  };
}
