import { z } from "zod";

// POST /api/waitlist — Phase 1 contract (frozen).
// The web app calls it same-origin: Next.js rewrites /api/* and /v1/* to the API,
// so the browser never needs CORS and cookies stay first-party.

export const WAITLIST_SOURCES = ["landing-hero", "landing-footer", "pricing-dialog", "other"] as const;

export const waitlistRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  source: z.enum(WAITLIST_SOURCES).default("other"),
  /** Honeypot: hidden field that real users leave empty. Non-empty → silently accepted, not stored. */
  website: z.string().max(0).optional().or(z.string().max(500).transform(() => "__bot__")),
  /** Explicit consent checkbox for being emailed about early access (GDPR). Must be true. */
  consent: z.literal(true),
});
export type WaitlistRequest = z.input<typeof waitlistRequest>;

/**
 * Responses:
 * - 200 { ok: true }          stored, OR already on the list, OR honeypot hit.
 *                             Identical on purpose: the endpoint must not reveal who signed up.
 * - 400 { error: { code: "invalid_email" | "consent_required" | "invalid_request", message } }
 * - 403 { error: { code: "bad_origin", message } }   Origin header not WEB_PUBLIC_URL (CSRF guard; no session exists yet)
 * - 429 { error: { code: "rate_limited", message } } + Retry-After header. Limit: 5 requests / 10 min / IP.
 */
export const waitlistResponse = z.object({ ok: z.literal(true) });
export type WaitlistResponse = z.infer<typeof waitlistResponse>;

export interface ApiError {
  error: { code: string; message: string };
}
