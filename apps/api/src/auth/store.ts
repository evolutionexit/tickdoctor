import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { EMAIL_TOKEN_TTL, SESSION_TTL_DAYS, type SessionUser } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import type { Tx } from "../db/query.js";
import { discordPendingSignups, emailTokens, sessions, users } from "../db/schema.js";
import { randomToken, sha256Hex } from "./crypto.js";
import { effectivePlanId, planSource, storedPlanId } from "../limits.js";

// Users, sessions and single-use email tokens. Every time comes from the caller's clock (tests inject one).

export const SESSION_TTL_MS = SESSION_TTL_DAYS * 86_400_000;
/** Sliding expiry: last_used_at / expires_at are written at most once per minute per session. */
export const SESSION_TOUCH_MS = 60_000;

export type EmailTokenKind = "verify" | "magic" | "reset";
export const TOKEN_TTL_MS: Record<EmailTokenKind, number> = {
  verify: EMAIL_TOKEN_TTL.verifyHours * 3_600_000,
  magic: EMAIL_TOKEN_TTL.magicLinkMinutes * 60_000,
  reset: EMAIL_TOKEN_TTL.resetMinutes * 60_000,
};

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  plan: string;
  createdAt: Date;
  discordLinked: boolean;
}

const userCols = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  passwordHash: users.passwordHash,
  emailVerifiedAt: users.emailVerifiedAt,
  plan: users.plan,
  createdAt: users.createdAt,
  // Written out as "users"."id": drizzle renders ${users.id} unqualified in single-table selects, which inside this
  // subquery would resolve to o.id (always false).
  discordLinked: sql<boolean>`exists (select 1 from oauth_accounts o where o.user_id = "users"."id" and o.provider = 'discord')`,
};

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const r = await db.select(userCols).from(users).where(eq(users.email, email)).limit(1);
  return r[0];
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const r = await db.select(userCols).from(users).where(eq(users.id, id)).limit(1);
  return r[0];
}

export function toSessionUser(u: UserRow): SessionUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    emailVerified: u.emailVerifiedAt !== null,
    plan: storedPlanId(u.plan),
    effectivePlan: effectivePlanId(u.plan),
    planSource: planSource(u.plan),
    hasPassword: u.passwordHash !== null,
    discordLinked: Boolean(u.discordLinked),
    createdAt: new Date(u.createdAt).toISOString(),
  };
}

// ---------- sessions ----------

/** Creates a session; returns the cookie value (never stored). */
export async function createSession(db: Db, userId: string, nowMs: number): Promise<string> {
  const token = randomToken();
  await db.insert(sessions).values({
    idHash: sha256Hex(token),
    userId,
    createdAt: new Date(nowMs),
    lastUsedAt: new Date(nowMs),
    expiresAt: new Date(nowMs + SESSION_TTL_MS),
  });
  return token;
}

export interface ActiveSession {
  idHash: string;
  user: UserRow;
  /** True when this request slid the expiry (the cookie's Max-Age should be refreshed). */
  refreshed: boolean;
}

/** Looks up a live session; slides its expiry when last used more than a minute ago. */
export async function resolveSession(db: Db, token: string, nowMs: number): Promise<ActiveSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const idHash = sha256Hex(token);
  const now = new Date(nowMs);
  const r = await db
    .select({ ...userCols, lastUsedAt: sessions.lastUsedAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), sql`${sessions.expiresAt} > ${now.toISOString()}::timestamptz`))
    .limit(1);
  const row = r[0];
  if (!row) return null;
  const { lastUsedAt, ...user } = row;
  // Defence in depth: an unconfirmed account can never hold a session (contract app.ts).
  if (!user.emailVerifiedAt) {
    await db.delete(sessions).where(eq(sessions.idHash, idHash));
    return null;
  }
  let refreshed = false;
  if (nowMs - new Date(lastUsedAt).getTime() >= SESSION_TOUCH_MS) {
    await db
      .update(sessions)
      .set({ lastUsedAt: now, expiresAt: new Date(nowMs + SESSION_TTL_MS) })
      .where(eq(sessions.idHash, idHash));
    refreshed = true;
  }
  return { idHash, user, refreshed };
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.idHash, sha256Hex(token)));
}

/** Ends every session of the user, optionally keeping one (the caller's). */
export async function deleteUserSessions(db: Db, userId: string, keepIdHash?: string): Promise<void> {
  await db
    .delete(sessions)
    .where(keepIdHash ? and(eq(sessions.userId, userId), ne(sessions.idHash, keepIdHash)) : eq(sessions.userId, userId));
}

/** Housekeeping: expired sessions, used/expired email tokens and pending Discord signups (hourly auth job). */
export async function purgeExpiredAuth(db: Db, nowMs: number): Promise<{ sessions: number; tokens: number; discordPending: number }> {
  const now = new Date(nowMs).toISOString();
  const s = await db.execute(sql`delete from sessions where expires_at <= ${now}::timestamptz`);
  const t = await db.execute(
    sql`delete from email_tokens where expires_at <= ${now}::timestamptz or (used_at is not null and used_at <= ${now}::timestamptz - interval '1 day')`,
  );
  const d = await db.execute(sql`delete from discord_pending_signups where expires_at <= ${now}::timestamptz or used_at is not null`);
  return { sessions: s.count ?? 0, tokens: t.count ?? 0, discordPending: d.count ?? 0 };
}

// ---------- email tokens ----------

/**
 * Issues a single-use token (stored as sha256). Older unused tokens of the same kind are voided; a confirm
 * ("verify") token voids every unused token of the user (contract: a new confirm link replaces all earlier links).
 */
export async function issueEmailToken(
  db: Db,
  userId: string,
  kind: EmailTokenKind,
  nowMs: number,
  next?: string,
): Promise<string> {
  return db.transaction((tx) => issueEmailTokenTx(tx, userId, kind, nowMs, next));
}

/**
 * Same inside a caller's transaction. Locks the user row first, so concurrent issuing paths for one user
 * (signup, magic-link, forgot, resend) are serialised and "only the newest link works" holds.
 */
export async function issueEmailTokenTx(tx: Tx, userId: string, kind: EmailTokenKind, nowMs: number, next?: string): Promise<string> {
  const token = randomToken();
  await tx.execute(sql`select 1 from users where id = ${userId} for update`);
  await tx
    .update(emailTokens)
    .set({ usedAt: new Date(nowMs) })
    .where(
      kind === "verify"
        ? and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt))
        : and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)),
    );
  await tx.insert(emailTokens).values({
    tokenHash: sha256Hex(token),
    kind,
    userId,
    next: next ?? null,
    createdAt: new Date(nowMs),
    expiresAt: new Date(nowMs + TOKEN_TTL_MS[kind]),
  });
  return token;
}

/** Atomically consumes a token of one of `kinds` (unused, unexpired). Null otherwise. */
export async function consumeEmailToken(
  db: Db,
  token: string,
  kinds: EmailTokenKind[],
  nowMs: number,
): Promise<{ userId: string; kind: EmailTokenKind; next: string | null } | null> {
  const now = new Date(nowMs).toISOString();
  const kindList = `{${kinds.join(",")}}`;
  const r = await db.execute<{ user_id: string; kind: EmailTokenKind; next: string | null }>(sql`
    update email_tokens set used_at = ${now}::timestamptz
     where token_hash = ${sha256Hex(token)} and used_at is null and expires_at > ${now}::timestamptz
       and kind = any(${kindList}::text[])
    returning user_id, kind, next`);
  const row = r[0];
  return row ? { userId: row.user_id, kind: row.kind, next: row.next } : null;
}

export interface TokenInfo {
  id: string;
  userId: string;
  kind: EmailTokenKind;
  next: string | null;
  userConfirmed: boolean;
}

/** Read-only lookup of a live (unused, unexpired) token of one of `kinds`. Consumes nothing. */
export async function peekEmailToken(db: Db, token: string, kinds: EmailTokenKind[], nowMs: number): Promise<TokenInfo | null> {
  const now = new Date(nowMs).toISOString();
  const r = await db.execute<{ id: string; user_id: string; kind: EmailTokenKind; next: string | null; confirmed: boolean }>(sql`
    select t.id, t.user_id, t.kind, t.next, u.email_verified_at is not null as confirmed
      from email_tokens t join users u on u.id = t.user_id
     where t.token_hash = ${sha256Hex(token)} and t.used_at is null and t.expires_at > ${now}::timestamptz
       and t.kind = any(${`{${kinds.join(",")}}`}::text[])`);
  const row = r[0];
  return row ? { id: row.id, userId: row.user_id, kind: row.kind, next: row.next, userConfirmed: row.confirmed } : null;
}

/**
 * Confirm link + chosen password + binding consent, in one transaction: consume the token (still unused/unexpired),
 * set the password, email_verified_at, consent_at = now and display_name (this request's value or null), and delete
 * every session, other token and oauth link of the user. False when the token was used/expired in the meantime or
 * the user is already confirmed (nothing is changed then).
 */
export async function confirmAccount(
  db: Db,
  opts: { tokenId: string; userId: string; passwordHash: string; displayName: string | null; nowMs: number },
): Promise<boolean> {
  const now = new Date(opts.nowMs).toISOString();
  const { tokenId, userId } = opts;
  return db
    .transaction(async (tx) => {
      const used = await tx.execute(sql`
        update email_tokens set used_at = ${now}::timestamptz
         where id = ${tokenId} and user_id = ${userId} and kind = 'verify' and used_at is null and expires_at > ${now}::timestamptz
        returning id`);
      if (used.length === 0) return false;
      const confirmed = await tx.execute(sql`
        update users set password_hash = ${opts.passwordHash}, email_verified_at = ${now}::timestamptz,
               consent_at = ${now}::timestamptz, display_name = ${opts.displayName}
         where id = ${userId} and email_verified_at is null
        returning id`);
      if (confirmed.length === 0) throw new AlreadyConfirmed(); // roll the token consumption back too
      await tx.execute(sql`delete from sessions where user_id = ${userId}`);
      await tx.execute(sql`delete from oauth_accounts where user_id = ${userId}`);
      await tx.execute(sql`delete from email_tokens where user_id = ${userId} and id <> ${tokenId}`);
      return true;
    })
    .catch((err: unknown) => {
      if (err instanceof AlreadyConfirmed) return false;
      throw err;
    });
}

class AlreadyConfirmed extends Error {}

export interface SignupResult {
  userId: string;
  /** true = new or reset pending row (confirm link); false = confirmed account (magic link). */
  pending: boolean;
  /** Plaintext token to mail, or null when the per-email send limit is reached. */
  token: string | null;
}

/**
 * Signup in ONE transaction (contract b0964f3), with the same statements whatever the account state, so timing
 * doesn't tell new / pending / confirmed apart:
 *   1. upsert: new email → pending row; unconfirmed → reset (last_signup_at = now; consent_at, name and password
 *      cleared — signup records no consent, contract 38dc933); confirmed → untouched. Returns the user id either way.
 *   2. delete sessions + oauth links (no-op for confirmed: guarded by the pending flag).
 *   3. lock + void earlier tokens (all of them for pending, magic ones for confirmed) + insert the new token — or, over
 *      the send limit, only the void (old links still die).
 */
export async function signupTx(db: Db, email: string, nowMs: number, mayMail: boolean, next?: string): Promise<SignupResult> {
  const now = new Date(nowMs).toISOString();
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; pending: boolean }>(sql`
      with up as (
        insert into users (email, consent_at, last_signup_at, created_at)
        values (${email}, null, ${now}::timestamptz, ${now}::timestamptz)
        on conflict (email) do update
           set consent_at = null, last_signup_at = excluded.last_signup_at,
               display_name = null, password_hash = null
         where users.email_verified_at is null
        returning id
      )
      select id, true as pending from up
      union all
      select id, false as pending from users where email = ${email} and not exists (select 1 from up)`);
    const row = r[0];
    if (!row) throw new Error("signup: user row vanished");
    const pending = row.pending === true;
    await tx.execute(sql`delete from sessions where user_id = ${row.id} and ${pending}::boolean`);
    await tx.execute(sql`delete from oauth_accounts where user_id = ${row.id} and ${pending}::boolean`);
    const kind: EmailTokenKind = pending ? "verify" : "magic";
    let token: string | null = null;
    if (mayMail) {
      token = await issueEmailTokenTx(tx, row.id, kind, nowMs, next);
    } else {
      await tx.execute(sql`select 1 from users where id = ${row.id} for update`);
      await tx.execute(sql`
        update email_tokens set used_at = ${now}::timestamptz
         where user_id = ${row.id} and used_at is null and (${pending}::boolean or kind = 'magic')`);
    }
    return { userId: row.id, pending, token };
  });
}

/** Hourly: pending (unconfirmed) users without servers, 7 days after their last signup; tokens cascade. */
export const PENDING_USER_TTL_MS = 7 * 86_400_000;
export async function purgePendingUsers(db: Db, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - PENDING_USER_TTL_MS).toISOString();
  const r = await db.execute(sql`
    delete from users u
     where u.email_verified_at is null
       and coalesce(u.last_signup_at, u.created_at) < ${cutoff}::timestamptz
       and not exists (select 1 from servers s where s.owner_id = u.id)`);
  return r.count ?? 0;
}

// ---------- pending Discord signups (contract app.ts, Discord) ----------

export const DISCORD_PENDING_TTL_MS = 10 * 60_000;

/** Stores a pending Discord signup; returns the cookie token (only its sha256 is kept). Earlier unused rows of the same Discord id are dropped. */
export async function createDiscordPending(
  db: Db,
  opts: { discordUserId: string; email: string; next: string | null; nowMs: number },
): Promise<string> {
  const token = randomToken();
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from discord_pending_signups where discord_user_id = ${opts.discordUserId} and used_at is null`);
    await tx.insert(discordPendingSignups).values({
      tokenHash: sha256Hex(token),
      discordUserId: opts.discordUserId,
      email: opts.email,
      next: opts.next,
      createdAt: new Date(opts.nowMs),
      expiresAt: new Date(opts.nowMs + DISCORD_PENDING_TTL_MS),
    });
  });
  return token;
}

/** Read-only lookup of a live (unused, unexpired) pending Discord signup. */
export async function peekDiscordPending(db: Db, token: string, nowMs: number): Promise<{ email: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = new Date(nowMs).toISOString();
  const r = await db.execute<{ email: string }>(sql`
    select email from discord_pending_signups
     where token_hash = ${sha256Hex(token)} and used_at is null and expires_at > ${now}::timestamptz`);
  return r[0] ? { email: r[0].email } : null;
}

export type DiscordCompleteResult = { ok: true; userId: string; next: string | null } | { ok: false };

/**
 * ONE transaction: consume the pending row (unused, unexpired), then create the confirmed user (consent_at = now) — or,
 * when an UNCONFIRMED user (pending signup / CLI-created) has the email, take that row over: confirm it, clear any
 * password, delete its tokens, sessions and oauth links (contract caa14d7; Discord's verified email proves the inbox) —
 * and link the Discord id. `{ok:false}` when the row is gone/used/expired, a CONFIRMED user has the email, or the Discord
 * id is linked to someone (the pending row is consumed in those cases: single use).
 */
export async function completeDiscordSignup(
  db: Db,
  opts: { token: string; displayName: string | null; nowMs: number },
): Promise<DiscordCompleteResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(opts.token)) return { ok: false };
  const now = new Date(opts.nowMs).toISOString();
  return db.transaction(async (tx) => {
    const used = await tx.execute<{ discord_user_id: string; email: string; next: string | null }>(sql`
      update discord_pending_signups set used_at = ${now}::timestamptz
       where token_hash = ${sha256Hex(opts.token)} and used_at is null and expires_at > ${now}::timestamptz
      returning discord_user_id, email, next`);
    const row = used[0];
    if (!row) return { ok: false } as const;
    // New email → insert; unconfirmed row → takeover (the upsert row-locks it, serialising with signupTx); confirmed
    // row → nothing returned. xmax <> 0 marks an updated (taken-over) row.
    const u = await tx.execute<{ id: string; taken_over: boolean }>(sql`
      insert into users (email, display_name, email_verified_at, consent_at, created_at)
      values (${row.email}, ${opts.displayName}, ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
      on conflict (email) do update
         set email_verified_at = excluded.email_verified_at, consent_at = excluded.consent_at,
             display_name = excluded.display_name, password_hash = null
       where users.email_verified_at is null
      returning id, (xmax <> 0) as taken_over`);
    const userId = u[0]?.id;
    if (!userId) return { ok: false } as const;
    if (u[0]!.taken_over) {
      await tx.execute(sql`delete from email_tokens where user_id = ${userId}`);
      await tx.execute(sql`delete from sessions where user_id = ${userId}`);
      await tx.execute(sql`delete from oauth_accounts where user_id = ${userId}`);
    }
    const l = await tx.execute<{ id: string }>(sql`
      insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${row.discord_user_id}, ${userId})
      on conflict do nothing
      returning id`);
    if (l.length === 0) throw new DiscordIdTaken(); // roll the user back; consume the row below
    return { ok: true, userId, next: row.next } as const;
  }).catch(async (err: unknown) => {
    if (!(err instanceof DiscordIdTaken)) throw err;
    await db.execute(sql`update discord_pending_signups set used_at = ${now}::timestamptz where token_hash = ${sha256Hex(opts.token)} and used_at is null`);
    return { ok: false } as const;
  });
}

class DiscordIdTaken extends Error {}
