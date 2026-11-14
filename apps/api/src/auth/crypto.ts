import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Password hashing and random tokens (contracts §3). scrypt from node:crypto, parameters encoded in the hash so
// they can be raised later without breaking existing hashes.

export const SCRYPT_DEFAULTS = { log2N: 15, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmemFor = (N: number, r: number) => 256 * N * r; // 2x the 128*N*r scrypt needs

/** `scrypt$<log2N>$<r>$<p>$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const { log2N, r, p, keyLen, saltLen } = SCRYPT_DEFAULTS;
  const salt = randomBytes(saltLen);
  const N = 2 ** log2N;
  const key = await scrypt(password, salt, keyLen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${log2N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time check. A malformed hash never throws; it just doesn't match. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [log2N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![log2N, r, p].every((n) => Number.isInteger(n) && n > 0) || log2N > 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || expected.length < 16) return false;
  const N = 2 ** log2N;
  const key = await scrypt(password, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/**
 * Checked for unknown emails (and accounts without a password) so login takes the same time either way.
 * Same parameters as real hashes.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummy);
  return false;
}

/** 32 random bytes, base64url (43 chars): session ids, email tokens, CSRF tokens, OAuth state. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time string equality (hashes both sides so lengths don't leak either). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
