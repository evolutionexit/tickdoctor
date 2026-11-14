import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { main } from "../src/cli.js";
import { dbKeyVerifier } from "../src/ingest/auth.js";
import { KEY_PATTERN, base62, hashApiKey } from "../src/keys.js";
import { testDatabaseUrl } from "./db-url.js";
import { PEPPER, handle, resetStorage } from "./helpers.js";

const saved = { db: process.env.DATABASE_URL, pepper: process.env.API_KEY_PEPPER };
beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.API_KEY_PEPPER = PEPPER;
});
afterAll(async () => {
  process.env.DATABASE_URL = saved.db;
  process.env.API_KEY_PEPPER = saved.pepper;
  await handle.close();
});
beforeEach(resetStorage);

async function run(...argv: string[]) {
  const lines: string[] = [];
  const code = await main(argv, (l) => lines.push(l));
  const kv = Object.fromEntries(lines.filter((l) => /^\w+=/.test(l)).map((l) => l.split("=", 2) as [string, string]));
  return { code, lines, kv };
}

describe("keys", () => {
  it("are td_live_ + 43 base62 chars, distinct", () => {
    expect(base62(Buffer.alloc(32))).toBe("0".repeat(43));
    expect(base62(Buffer.alloc(32, 0xff))).toHaveLength(43);
  });
});

describe("cli", () => {
  it("server:create makes the user (lower-cased) + server + key, printing the key once", async () => {
    const { code, kv, lines } = await run("server:create", "--name", "Pi Survival (test)", "--owner-email", "Someone@Example.TEST");
    expect(code).toBe(0);
    expect(kv.api_key).toMatch(KEY_PATTERN);
    expect(lines.filter((l) => l.includes(kv.api_key!))).toHaveLength(1);
    expect(kv.slug).toBe("pi-survival-test");

    const [u] = (await handle.db.execute(sql`select email from users`)) as unknown as { email: string }[];
    expect(u!.email).toBe("someone@example.test");
    const keys = (await handle.db.execute(sql`select key_hash, prefix from api_keys where server_id = ${kv.server_id!}`)) as unknown as Record<string, string>[];
    expect(keys).toEqual([{ key_hash: hashApiKey(kv.api_key!, PEPPER), prefix: kv.api_key!.slice(0, 12) }]);
    const dump = JSON.stringify(await handle.db.execute(sql`select * from api_keys`));
    expect(dump).not.toContain(kv.api_key);

    const principal = await dbKeyVerifier(handle.db, PEPPER).verify(kv.api_key!);
    expect(principal).toMatchObject({ serverId: kv.server_id, plan: "free" });

    // Same name again → a different slug; same owner reused.
    const again = await run("server:create", "--name", "Pi Survival (test)", "--owner-email", "someone@example.test");
    expect(again.kv.slug).toMatch(/^pi-survival-test-[0-9a-f]{6}$/);
    const [n] = (await handle.db.execute(sql`select count(*)::int as n from users`)) as unknown as { n: number }[];
    expect(n!.n).toBe(1);
  });

  it("server:rotate-key revokes the old key", async () => {
    const created = await run("server:create", "--name", "Rotate me", "--owner-email", "r@test.local");
    const rotated = await run("server:rotate-key", created.kv.server_id!);
    expect(rotated.kv.revoked_keys).toBe("1");
    expect(rotated.kv.api_key).not.toBe(created.kv.api_key);
    const v = dbKeyVerifier(handle.db, PEPPER);
    expect(await v.verify(created.kv.api_key!)).toBe("revoked");
    expect(await v.verify(rotated.kv.api_key!)).toMatchObject({ serverId: created.kv.server_id });
  });

  it("server:revoke-key revokes every active key and issues none", async () => {
    const created = await run("server:create", "--name", "Revoke me", "--owner-email", "rv@test.local");
    const r = await run("server:revoke-key", created.kv.server_id!);
    expect(r.code).toBe(0);
    expect(r.kv.revoked_keys).toBe("1");
    expect(r.kv.api_key).toBeUndefined();
    expect(await dbKeyVerifier(handle.db, PEPPER).verify(created.kv.api_key!)).toBe("revoked");
    const [n] = (await handle.db.execute(
      sql`select count(*)::int as n from api_keys where server_id = ${created.kv.server_id!} and revoked_at is null`,
    )) as unknown as { n: number }[];
    expect(n!.n).toBe(0);
    expect((await run("server:revoke-key", created.kv.server_id!)).kv.revoked_keys).toBe("0");
    await expect(run("server:revoke-key", "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/);
    await expect(run("server:revoke-key", "nope")).rejects.toThrow(/usage/);
  });

  it("validates the pepper with the API's env schema", async () => {
    const env = { pepper: process.env.API_KEY_PEPPER, node: process.env.NODE_ENV };
    try {
      process.env.API_KEY_PEPPER = "short";
      await expect(run("server:create", "--name", "x", "--owner-email", "p@test.local")).rejects.toThrow(/API_KEY_PEPPER: must be at least 16/);
      process.env.API_KEY_PEPPER = "change-me-change-me-please";
      process.env.NODE_ENV = "production";
      await expect(run("server:create", "--name", "x", "--owner-email", "p@test.local")).rejects.toThrow(/placeholder/);
    } finally {
      process.env.API_KEY_PEPPER = env.pepper;
      if (env.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env.node;
    }
  });

  it("server:list shows prefixes, never full keys", async () => {
    const created = await run("server:create", "--name", "Listed", "--owner-email", "l@test.local", "--plan", "pro");
    const { lines } = await run("server:list");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(created.kv.server_id);
    expect(lines[0]).toContain("pro");
    expect(lines[0]).toContain(created.kv.api_key!.slice(0, 12));
    expect(lines[0]).not.toContain(created.kv.api_key);
  });

  it("server:request-snapshot sets the flag", async () => {
    const created = await run("server:create", "--name", "Snap", "--owner-email", "s@test.local");
    expect((await run("server:request-snapshot", created.kv.server_id!)).code).toBe(0);
    const [row] = (await handle.db.execute(sql`select snapshot_requested_at from servers`)) as unknown as Record<string, unknown>[];
    expect(row!.snapshot_requested_at).not.toBeNull();
  });

  it("rejects bad input", async () => {
    await expect(run("server:create", "--name", "x")).rejects.toThrow(/usage/);
    await expect(run("server:rotate-key", "nope")).rejects.toThrow(/usage/);
    await expect(run("server:rotate-key", "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/);
    await expect(run("server:create", "--name", "x", "--owner-email", "a@b.c", "--plan", "gold")).rejects.toThrow(/plan/);
    await expect(run("bogus")).rejects.toThrow(/usage/);
  });
});

describe("cli (Phase 5)", () => {
  it("user:set-plan sets the user's plan and their servers' plans", async () => {
    const created = await run("server:create", "--name", "Plan test", "--owner-email", "plan@example.test");
    const r = await run("user:set-plan", "Plan@Example.test", "pro");
    expect(r.code).toBe(0);
    expect(r.kv).toMatchObject({ plan: "pro" });
    const [u] = (await handle.db.execute(sql`select u.plan as user_plan, s.plan as server_plan from users u join servers s on s.owner_id = u.id where s.id = ${created.kv.server_id!}`)) as unknown as Record<string, string>[];
    expect(u).toEqual({ user_plan: "pro", server_plan: "pro" });
    await expect(run("user:set-plan", "plan@example.test", "gold")).rejects.toThrow(/unknown plan/);
    await expect(run("user:set-plan", "nobody@example.test", "pro")).rejects.toThrow(/user not found/);
  });

  it("server:transfer moves the server and its data to another user", async () => {
    const created = await run("server:create", "--name", "Move me", "--owner-email", "from@example.test");
    await run("server:create", "--name", "Other", "--owner-email", "to@example.test");
    await run("user:set-plan", "to@example.test", "network");
    await handle.db.execute(sql`insert into metric_samples (server_id, ts, detail) values (${created.kv.server_id!}, now(), '{}'::jsonb)`);
    const r = await run("server:transfer", created.kv.server_id!, "--owner-email", "to@example.test", "--keep-key");
    expect(r.code).toBe(0);
    expect(r.kv.api_key).toBeUndefined();
    const [row] = (await handle.db.execute(sql`select u.email, s.plan, (select count(*)::int from metric_samples m where m.server_id = s.id) as samples from servers s join users u on u.id = s.owner_id where s.id = ${created.kv.server_id!}`)) as unknown as Record<string, unknown>[];
    expect(row).toEqual({ email: "to@example.test", plan: "network", samples: 1 });
    // The key keeps working (agent config unchanged).
    expect(await dbKeyVerifier(handle.db, PEPPER).verify(created.kv.api_key!)).toMatchObject({ serverId: created.kv.server_id });
    // Default: the key is rotated (printed once), the old one is revoked.
    const r2 = await run("server:transfer", created.kv.server_id!, "--owner-email", "from@example.test");
    expect(r2.kv.api_key).toMatch(KEY_PATTERN);
    expect(r2.lines.filter((l) => l.includes(r2.kv.api_key!))).toHaveLength(1);
    expect(r2.lines.some((l) => /plan server limit is not checked/.test(l))).toBe(true);
    expect(await dbKeyVerifier(handle.db, PEPPER).verify(created.kv.api_key!)).toBe("revoked");
    expect(await dbKeyVerifier(handle.db, PEPPER).verify(r2.kv.api_key!)).toMatchObject({ serverId: created.kv.server_id });
    await expect(run("server:transfer", created.kv.server_id!, "--owner-email", "ghost@example.test")).rejects.toThrow(/no user/);
    await expect(run("server:transfer", "00000000-0000-4000-8000-000000000000", "--owner-email", "to@example.test")).rejects.toThrow(/server not found/);
  });
});
