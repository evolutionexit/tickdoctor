import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "../db/client.js";
import { apiKeys, servers } from "../db/schema.js";
import { KEY_PATTERN, hashApiKey } from "../keys.js";
import { IngestError } from "./errors.js";

/** Identity of an authenticated agent key. */
export interface IngestPrincipal {
  /** api_keys.id: stable, non-secret; used for per-key rate limiting and logs. */
  keyId: string;
  serverId: string;
  plan: string;
}

export type IngestEnv = { Variables: { ingest: IngestPrincipal } };

/**
 * Swappable key check (the single place agent keys are verified).
 * Returns the principal, "invalid" for an unknown/malformed key, "revoked" for a revoked one.
 */
export interface IngestKeyVerifier {
  verify(token: string): Promise<IngestPrincipal | "invalid" | "revoked">;
}

/** Negative cache for unknown / revoked keys: repeated identical bad keys skip the DB. */
export const NEGATIVE_CACHE_TTL_MS = 60_000;
export const NEGATIVE_CACHE_MAX = 10_000;

/**
 * Hashed per-server keys in Postgres: looks up sha256(key + pepper) via the unique key_hash index.
 * No timing oracle: the lookup is by a peppered hash, never by a prefix of the secret.
 * Unknown and revoked hashes are remembered for NEGATIVE_CACHE_TTL_MS (at most NEGATIVE_CACHE_MAX entries, oldest
 * evicted first), so a client hammering with the same bad key costs no DB lookups. Safe: an unknown key can't
 * become valid (new keys are random) and a revoked key stays revoked. Valid keys are never cached.
 */
export function dbKeyVerifier(
  db: Db,
  pepper: string,
  opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): IngestKeyVerifier {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? NEGATIVE_CACHE_TTL_MS;
  const max = Math.max(1, opts.maxEntries ?? NEGATIVE_CACHE_MAX);
  const negative = new Map<string, { result: "invalid" | "revoked"; until: number }>();
  const remember = (hash: string, result: "invalid" | "revoked") => {
    negative.delete(hash);
    while (negative.size >= max) negative.delete(negative.keys().next().value!);
    negative.set(hash, { result, until: now() + ttl });
    return result;
  };
  return {
    async verify(token) {
      if (!KEY_PATTERN.test(token)) return "invalid";
      const hash = hashApiKey(token, pepper);
      const hit = negative.get(hash);
      if (hit) {
        if (hit.until > now()) return hit.result;
        negative.delete(hash);
      }
      const rows = await db
        .select({ keyId: apiKeys.id, serverId: apiKeys.serverId, revokedAt: apiKeys.revokedAt, plan: servers.plan })
        .from(apiKeys)
        .innerJoin(servers, eq(servers.id, apiKeys.serverId))
        .where(eq(apiKeys.keyHash, hash))
        .limit(1);
      const row = rows[0];
      if (!row) return remember(hash, "invalid");
      if (row.revokedAt) return remember(hash, "revoked");
      return { keyId: row.keyId, serverId: row.serverId, plan: row.plan };
    },
  };
}

/**
 * The single auth checkpoint for agent routes; sets `c.var.ingest`.
 * `onFailure` runs for every request that fails auth, before the 401 is thrown; it may throw its own
 * error instead (the failed-auth per-IP limiter answers 429 there).
 */
export function ingestAuth(
  verifier: IngestKeyVerifier,
  onFailure?: (c: Context<IngestEnv>) => void,
): MiddlewareHandler<IngestEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S{1,512})$/i.exec(header.trim());
    const result = m ? await verifier.verify(m[1]!) : "invalid";
    if (result === "revoked" || result === "invalid") onFailure?.(c);
    if (result === "revoked") throw new IngestError(401, "revoked_key", "API key has been revoked");
    if (result === "invalid") throw new IngestError(401, "invalid_key", "Missing or invalid API key");
    c.set("ingest", result);
    await next();
  };
}
