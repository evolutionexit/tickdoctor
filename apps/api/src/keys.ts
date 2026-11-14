import { createHash, randomBytes } from "node:crypto";

export const KEY_PREFIX = "td_live_";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 32 bytes = 256 bits → ceil(256 / log2(62)) = 43 base62 digits (left-padded so every key has the same length). */
export const KEY_BODY_LENGTH = 43;
export const KEY_PATTERN = /^td_live_[0-9A-Za-z]{43}$/;
/** Chars of the key kept for display (contracts §5.1). */
export const DISPLAY_PREFIX_LENGTH = 12;

export function base62(bytes: Buffer, length = KEY_BODY_LENGTH): string {
  let n = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)]! + out;
    n /= 62n;
  }
  return out.padStart(length, "0");
}

/** New agent key: `td_live_` + 32 random bytes in base62. Shown once; only its hash is stored. */
export function generateApiKey(): string {
  return KEY_PREFIX + base62(randomBytes(32));
}

/** hex sha256(key + pepper) — what api_keys.key_hash stores. */
export function hashApiKey(key: string, pepper: string): string {
  return createHash("sha256").update(key + pepper, "utf8").digest("hex");
}

export function displayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH);
}
