import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Webhook URLs at rest: AES-256-GCM with SECRETS_KEY (32 bytes, base64). Format "v1:" + base64(iv(12) | tag(16) | ct).
// `aad` (the server id) is bound into the tag: a ciphertext copied to another server's row doesn't decrypt.

const PREFIX = "v1:";

/** SECRETS_KEY → 32-byte key. Throws on anything else (env.ts validates it the same way). */
export function parseSecretsKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== b64.trim().replace(/=+$/, "")) {
    throw new Error("SECRETS_KEY must be 32 bytes, base64 (generate: openssl rand -base64 32)");
  }
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string, aad?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

/** Throws (without echoing anything secret) when the key is wrong or the value was tampered with. */
export function decryptSecret(key: Buffer, stored: string, aad?: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error("unknown secret format");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (buf.length < 29) throw new Error("secret too short");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  if (aad !== undefined) d.setAAD(Buffer.from(aad, "utf8"));
  try {
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    throw new Error("could not decrypt (wrong SECRETS_KEY or another server's value?)");
  }
}
