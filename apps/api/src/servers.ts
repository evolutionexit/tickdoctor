import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { apiKeys, servers, users } from "./db/schema.js";
import { displayPrefix, generateApiKey, hashApiKey } from "./keys.js";
import { isPlanId, planOf } from "./limits.js";
import type { Tx } from "./db/query.js";

// Server + key management (used by the CLI until Phase 5 onboarding).

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "server";
}

export async function ensureUser(db: Db, email: string, displayName?: string): Promise<string> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e) || e.length > 254) throw new Error("invalid email");
  await db.insert(users).values({ email: e, displayName: displayName ?? null }).onConflictDoNothing({ target: users.email });
  const row = await db.select({ id: users.id }).from(users).where(eq(users.email, e)).limit(1);
  return row[0]!.id;
}

export interface CreatedServer {
  serverId: string;
  slug: string;
  ownerId: string;
  /** Plaintext key: show once, never store or log. */
  key: string;
  keyPrefix: string;
}

export async function createServer(
  db: Db,
  pepper: string,
  opts: { name: string; ownerEmail: string; plan?: string; id?: string; slug?: string },
): Promise<CreatedServer> {
  const name = opts.name.trim();
  if (name.length < 1 || name.length > 100) throw new Error("name must be 1-100 characters");
  const plan = opts.plan ?? "free";
  if (!isPlanId(plan)) throw new Error(`unknown plan ${plan}`);
  const ownerId = await ensureUser(db, opts.ownerEmail);
  return db.transaction((tx) => insertServer(tx, pepper, { name, ownerId, plan, id: opts.id, slug: opts.slug }));
}

/** Inserts a server + its first key inside `tx` (free slug picked here). */
export async function insertServer(
  tx: Tx,
  pepper: string,
  opts: { name: string; ownerId: string; plan: string; id?: string; slug?: string },
): Promise<CreatedServer> {
  const base = opts.slug ?? slugify(opts.name);
  const key = generateApiKey();
  // Slug is claimed by the insert itself (ON CONFLICT DO NOTHING): a check-then-insert raced with parallel signups
  // choosing the same name and surfaced as a 500 on the unique index.
  let slug = base;
  let srv: { id: string } | undefined;
  for (let i = 0; ; i++) {
    [srv] = await tx
      .insert(servers)
      .values({ ...(opts.id ? { id: opts.id } : {}), ownerId: opts.ownerId, name: opts.name, slug, plan: opts.plan })
      .onConflictDoNothing({ target: servers.slug })
      .returning({ id: servers.id });
    if (srv) break;
    if (i >= 5) throw new Error("could not find a free slug");
    slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  await tx.insert(apiKeys).values({ serverId: srv!.id, keyHash: hashApiKey(key, pepper), prefix: displayPrefix(key) });
  return { serverId: srv!.id, slug, ownerId: opts.ownerId, key, keyPrefix: displayPrefix(key) };
}

export type CreateForUserResult = CreatedServer | "plan_limit" | "email_not_verified" | "no_user";

/**
 * App onboarding (POST /api/servers): needs a verified email and a free slot in the user's plan. The user row is
 * locked so two parallel requests can't both take the last slot. The new server gets the user's plan.
 */
export async function createServerForUser(db: Db, pepper: string, userId: string, name: string): Promise<CreateForUserResult> {
  return db.transaction(async (tx) => {
    const u = await tx.execute<{ plan: string; verified: boolean }>(
      sql`select plan, email_verified_at is not null as verified from users where id = ${userId} for update`,
    );
    const user = u[0];
    if (!user) return "no_user";
    if (!user.verified) return "email_not_verified";
    const used = await tx.execute<{ n: number }>(sql`select count(*)::int as n from servers where owner_id = ${userId}`);
    if ((used[0]?.n ?? 0) >= planOf(user.plan).servers) return "plan_limit";
    return insertServer(tx, pepper, { name, ownerId: userId, plan: isPlanId(user.plan) ? user.plan : "free" });
  });
}

/** CLI user:set-plan: sets the user's plan and the per-server plan of every server they own. */
export async function setUserPlan(db: Db, email: string, plan: string): Promise<{ servers: number } | null> {
  if (!isPlanId(plan)) throw new Error(`unknown plan ${plan} (free, pro, network)`);
  return db.transaction(async (tx) => {
    const u = await tx.update(users).set({ plan }).where(eq(users.email, email.trim().toLowerCase())).returning({ id: users.id });
    if (!u[0]) return null;
    const s = await tx.update(servers).set({ plan }).where(eq(servers.ownerId, u[0].id)).returning({ id: servers.id });
    return { servers: s.length };
  });
}

/**
 * CLI server:transfer: moves a server (and with it every row hanging off servers.id: keys, samples, rollups,
 * incidents, findings, history) to another existing user. The server takes the new owner's plan.
 */
export async function transferServer(db: Db, serverId: string, ownerEmail: string): Promise<{ ownerId: string; plan: string } | "no_server" | "no_user"> {
  return db.transaction(async (tx) => {
    const u = await tx.select({ id: users.id, plan: users.plan }).from(users).where(eq(users.email, ownerEmail.trim().toLowerCase())).limit(1);
    if (!u[0]) return "no_user";
    const s = await tx.update(servers).set({ ownerId: u[0].id, plan: u[0].plan }).where(eq(servers.id, serverId)).returning({ id: servers.id });
    if (!s[0]) return "no_server";
    return { ownerId: u[0].id, plan: u[0].plan };
  });
}

/** Revokes every active key of the server and issues a new one. Returns null for an unknown server. */
export async function rotateKey(db: Db, pepper: string, serverId: string): Promise<{ key: string; keyPrefix: string; revoked: number } | null> {
  const key = generateApiKey();
  return db.transaction(async (tx) => {
    const srv = await tx.execute(sql`select id from servers where id = ${serverId} for update`);
    if (srv.length === 0) return null;
    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.serverId, serverId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    await tx.insert(apiKeys).values({ serverId, keyHash: hashApiKey(key, pepper), prefix: displayPrefix(key) });
    return { key, keyPrefix: displayPrefix(key), revoked: revoked.length };
  });
}

/** Revokes every active key of the server without issuing a new one. Returns null for an unknown server. */
export async function revokeKeys(db: Db, serverId: string): Promise<{ revoked: number } | null> {
  return db.transaction(async (tx) => {
    const srv = await tx.execute(sql`select id from servers where id = ${serverId} for update`);
    if (srv.length === 0) return null;
    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.serverId, serverId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return { revoked: revoked.length };
  });
}

export async function listServers(db: Db) {
  return db
    .select({
      id: servers.id,
      name: servers.name,
      slug: servers.slug,
      plan: servers.plan,
      ownerEmail: users.email,
      lastSeenAt: servers.lastSeenAt,
      activeKeyPrefix: sql<string | null>`(select prefix from api_keys k where k.server_id = ${servers.id} and k.revoked_at is null order by k.created_at desc limit 1)`,
    })
    .from(servers)
    .innerJoin(users, eq(users.id, servers.ownerId))
    .orderBy(desc(servers.createdAt));
}
