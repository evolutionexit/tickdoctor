import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { CSRF_COOKIE, changePasswordRequest, deleteAccountRequest, updateAccountRequest } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { emailTokens, users } from "../db/schema.js";
import type { LiveHub } from "../live/hub.js";
import { HttpError } from "../errors.js";
import { bodyLimit } from "../middleware/body-limit.js";
import { clearSessionCookie, requireUser, type CookieOpts, type SessionEnv } from "../middleware/session.js";
import { mails, type Mailer } from "../auth/mailer.js";
import { ExportSlots, exportStream } from "../account/export.js";
import { deleteAccount } from "../account/delete.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { deleteUserSessions, findUserById, toSessionUser } from "../auth/store.js";
import type { RateLimitStore } from "../middleware/rate-limit.js";
import { rateLimited } from "../middleware/rate-limit.js";
import { MAX_JSON_BYTES, readJson } from "./json.js";

// /api/account: Phase 5 profile + password, Phase 8 export + deletion (contract app-phase8.ts).

export function accountRoutes(deps: {
  db: Db;
  now: () => number;
  passwordPerUser: RateLimitStore;
  /** GET /export per user (3 / hour). */
  exportPerUser: RateLimitStore;
  /** Concurrent exports across the process (default: a fresh cap of MAX_CONCURRENT_EXPORTS). */
  exportSlots?: ExportSlots;
  hub?: Pick<LiveHub, "closeUser" | "closeServer">;
  /** Needed by DELETE / (the "account deleted" email + clearing cookies). */
  mailer?: Mailer;
  cookies?: CookieOpts;
  log?: (line: string) => void;
}) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));
  const exportSlots = deps.exportSlots ?? new ExportSlots();

  const current = async (id: string) => {
    const u = await findUserById(deps.db, id);
    if (!u) throw new HttpError(401, "unauthorized", "Please sign in");
    return { user: toSessionUser(u) };
  };

  app.get("/", async (c) => c.json(await current(requireUser(c).id), 200));

  app.patch("/", async (c) => {
    const user = requireUser(c);
    const body = await readJson(c, updateAccountRequest);
    await deps.db.update(users).set({ displayName: body.displayName }).where(eq(users.id, user.id));
    return c.json(await current(user.id), 200);
  });

  /** currentPassword is required when the account has one (wrong/missing → 400 with fields.currentPassword). */
  app.post("/password", async (c) => {
    const user = requireUser(c);
    const retryAfter = deps.passwordPerUser.hit(user.id, deps.now());
    if (retryAfter > 0) throw rateLimited(retryAfter);
    const body = await readJson(c, changePasswordRequest);
    if (user.passwordHash) {
      const ok = body.currentPassword ? await verifyPassword(body.currentPassword, user.passwordHash) : false;
      if (!ok) {
        throw new HttpError(400, "invalid_request", "Your current password is not correct", {}, { currentPassword: "Your current password is not correct" });
      }
    }
    const keep = c.get("session")!.idHash;
    await deps.db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, user.id));
    // Outstanding reset / magic links would bypass the new password: void them.
    await deps.db
      .update(emailTokens)
      .set({ usedAt: new Date(deps.now()) })
      .where(and(eq(emailTokens.userId, user.id), inArray(emailTokens.kind, ["reset", "magic"]), isNull(emailTokens.usedAt)));
    await deleteUserSessions(deps.db, user.id, keep);
    deps.hub?.closeUser(user.id, keep);
    return c.json({ ok: true as const }, 200);
  });

  /** Streamed JSON with everything we hold (never hashes or the decrypted webhook). */
  app.get("/export", async (c) => {
    const user = requireUser(c);
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="tickdoctor-export-${day}.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    // HEAD is routed here too, and its body is dropped without being cancelled: answer before taking a slot or
    // spending the hourly budget.
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    // Caps first (global + one running export per user), so a busy server doesn't burn the user's hourly budget.
    const release = exportSlots.tryAcquire(user.id);
    if (release === "busy") throw rateLimited(30);
    if (release === "user_busy") throw rateLimited(10);
    const retryAfter = deps.exportPerUser.hit(user.id, deps.now());
    if (retryAfter > 0) {
      release();
      throw rateLimited(retryAfter);
    }
    const body = exportStream(deps.db, user.id, { now: deps.now(), signal: c.req.raw.signal, onClose: release });
    return new Response(body, { status: 200, headers });
  });

  /** Immediate, final erasure: confirmEmail (+ password when the account has one), then ONE transaction. */
  app.delete("/", async (c) => {
    const user = requireUser(c);
    const body = await readJson(c, deleteAccountRequest);
    if (body.confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
      throw new HttpError(400, "invalid_request", "Type your account's email address to confirm", {}, { confirmEmail: "Doesn't match your account's email" });
    }
    if (user.passwordHash) {
      // Same budget as changing the password: guessing it here is a login attempt too.
      const retryAfter = deps.passwordPerUser.hit(user.id, deps.now());
      if (retryAfter > 0) throw rateLimited(retryAfter);
      const ok = body.password ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!ok) throw new HttpError(400, "invalid_request", "Your password is not correct", {}, { password: "Your password is not correct" });
    }
    const deleted = await deleteAccount(deps.db, user.id);
    if (!deleted) throw new HttpError(401, "unauthorized", "Please sign in");
    deps.hub?.closeUser(user.id);
    for (const id of deleted.serverIds) deps.hub?.closeServer(id);
    const cookieOpts = deps.cookies ?? { secure: false };
    clearSessionCookie(c, cookieOpts);
    deleteCookie(c, CSRF_COOKIE, { path: "/", secure: cookieOpts.secure, sameSite: "Lax" });
    if (deps.mailer) {
      void deps.mailer.send(mails.accountDeleted(deleted.email)).catch((err: unknown) => {
        deps.log?.(`mail send failed (account deleted): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return c.json({ ok: true as const }, 200);
  });

  return app;
}
