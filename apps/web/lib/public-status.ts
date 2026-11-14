import { headers } from "next/headers";
import { cache } from "react";
import { STATUS_SLUG_RE, publicStatus, type PublicStatus } from "@tickdoctor/shared";

/** Server-side base URL of the API (in docker the web container reaches it at http://api:4000; same env as the /api rewrite). */
const apiBase = () => (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");

/**
 * GET /api/public/status/:slug. null = unknown or disabled (404). Throws on any other failure so the error page shows.
 * Forwards the visitor's IP (Caddy sets X-Forwarded-For; the web container is only reachable through it) so the API's
 * per-IP rate limit counts visitors, not our container. No Next data cache (the API caches and limits; a disabled
 * page must stop showing at once). cache() makes one render = one API call (page + metadata).
 */
/** The visitor hit the API's per-IP limit (60/min): show a friendly "try again" view, not the error page. */
export class StatusRateLimited extends Error {}

export const fetchPublicStatus = cache(async (rawSlug: string): Promise<PublicStatus | null> => {
  const slug = rawSlug.toLowerCase(); // the API is case-insensitive
  if (!STATUS_SLUG_RE.test(slug)) return null;
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  const res = await fetch(`${apiBase()}/api/public/status/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json", ...(xff ? { "X-Forwarded-For": xff } : {}) },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (res.status === 429) throw new StatusRateLimited("rate limited");
  if (!res.ok) throw new Error(`Status API answered ${res.status}`);
  return publicStatus.parse(await res.json());
});

export const STATE_VIEW = {
  operational: { health: "healthy", word: "Operational", line: "is up and running normally." },
  degraded: { health: "degraded", word: "Degraded", line: "is up but running a little slower than usual." },
  lagging: { health: "lagging", word: "Lagging", line: "is up but lagging right now. Players may notice delays." },
  offline: { health: "offline", word: "Offline", line: "is offline right now." },
} as const;

export const pct = (v: number | null) => (v === null ? null : `${v.toFixed(1)}%`);
