import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rows } from "../db/query.js";

// Account erasure (contract app-phase8.ts, DELETE /api/account and `cli user:delete`). ONE transaction:
//  - waitlist rows with the account's email (stored lower-case),
//  - pending Discord signups for that email or for the linked Discord user id,
//  - the user row, which cascades (schema.ts FKs, ON DELETE CASCADE) to sessions, email tokens, oauth accounts
//    (Discord links) and servers → every per-server table (samples, rollups, events, snapshots, incidents, findings,
//    finding links, info / plugin history, API keys, status pages (frees the slugs), alert configs + deliveries,
//    analysis state).
// A schema-driven test (test/account.test.ts) checks that no table keeps the user id, a server id or the email.

export interface DeletedAccount {
  userId: string;
  email: string;
  serverIds: string[];
}

export async function deleteAccount(db: Db, userId: string): Promise<DeletedAccount | null> {
  return db.transaction(async (tx) => {
    // Lock the user row: a concurrent server create / Discord link waits and then finds no user.
    const [u] = await rows<{ email: string; discord_id: string | null }>(
      tx,
      sql`select u.email,
                 (select o.provider_user_id from oauth_accounts o where o.user_id = u.id and o.provider = 'discord') as discord_id
            from users u where u.id = ${userId} for update`,
    );
    if (!u) return null;
    const email = u.email.toLowerCase();
    const servers = await rows<{ id: string }>(tx, sql`select id from servers where owner_id = ${userId} for update`);
    await tx.execute(sql`delete from waitlist where email = ${email}`);
    await tx.execute(
      sql`delete from discord_pending_signups where email = ${email}
             or (${u.discord_id}::text is not null and discord_user_id = ${u.discord_id}::text)`,
    );
    await tx.execute(sql`delete from users where id = ${userId}`);
    return { userId, email, serverIds: servers.map((s) => s.id) };
  });
}

export async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const [u] = await rows<{ id: string }>(db, sql`select id from users where email = ${email.trim().toLowerCase()}`);
  return u?.id ?? null;
}
