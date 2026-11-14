import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export type ClientIpResolver = (c: Context) => string;

/**
 * Resolves the client IP.
 *
 * Topology with TRUST_PROXY=true: browser -> Caddy -> API, and the API port is not published, so
 * Caddy is the only peer that can reach us. Caddy has no trusted_proxies configured, so it
 * REPLACES any client-supplied X-Forwarded-For with the address of its own peer (the browser).
 *
 * - trustProxy=true: the right-most X-Forwarded-For entry. Behind Caddy there is exactly one entry,
 *   the real peer address. Taking the right-most entry (the one added by our single trusted hop)
 *   rather than the left-most stays safe even if a proxy in front were ever to append instead of
 *   replace: left-most entries are client-controlled.
 * - trustProxy=false: the TCP peer address only; X-Forwarded-For is ignored entirely because
 *   without a trusted proxy in front it is just a client-controlled header.
 */
export function clientIpResolver(trustProxy: boolean): ClientIpResolver {
  return (c) => rateLimitKey(rawClientIp(c, trustProxy));
}

function rawClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Expands an IPv6 address to 8 groups (no zone id); null if it isn't one. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  // Embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two hex groups.
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(2, 6).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${v4[1]}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Rate-limit key for an address: IPv4 as is; IPv6 by its /64 (one subscriber usually gets a whole /64, so
 * per-address keys would be trivially bypassed); IPv4-mapped IPv6 → the IPv4 address.
 */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const g = expandIpv6(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
