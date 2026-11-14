import { Hono } from "hono";
import { waitlistRequest, type WaitlistResponse } from "@tickdoctor/shared";
import type { ZodError } from "zod";
import type { Db } from "../db/client.js";
import { waitlist } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { bodyLimit } from "../middleware/body-limit.js";
import { originCheck } from "../middleware/origin-check.js";
import { rateLimit, rateLimited, type RateLimitStore } from "../middleware/rate-limit.js";
import type { GlobalCap } from "../middleware/global-cap.js";
import type { ClientIpResolver } from "../middleware/client-ip.js";

export interface WaitlistRouteDeps {
  db: Db;
  webOrigin: string;
  clientIp: ClientIpResolver;
  now: () => number;
  perIpLimiter: RateLimitStore;
  globalCap: GlobalCap;
}

const MAX_BODY_BYTES = 10 * 1024;
const OK: WaitlistResponse = { ok: true };

function toHttpError(err: ZodError): HttpError {
  const fields = new Set(err.issues.map((i) => String(i.path[0] ?? "")));
  if (fields.has("email")) return new HttpError(400, "invalid_email", "Please enter a valid email address");
  if (fields.has("consent")) return new HttpError(400, "consent_required", "Consent is required to join the waitlist");
  return new HttpError(400, "invalid_request", "Invalid request body");
}

function isHoneypotHit(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const website = (body as Record<string, unknown>).website;
  return website !== undefined && website !== null && website !== "";
}

export function waitlistRoutes(deps: WaitlistRouteDeps) {
  const app = new Hono();

  app.post(
    "/",
    bodyLimit(MAX_BODY_BYTES),
    originCheck(deps.webOrigin),
    rateLimit({ store: deps.perIpLimiter, keyOf: deps.clientIp, now: deps.now }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new HttpError(400, "invalid_request", "Body must be JSON");
      }

      // Bots fill the hidden field: answer exactly like a real signup, store nothing.
      if (isHoneypotHit(body)) return c.json(OK, 200);

      const parsed = waitlistRequest.safeParse(body);
      if (!parsed.success) throw toHttpError(parsed.error);
      if (parsed.data.website === "__bot__") return c.json(OK, 200);

      // Global cap on new rows (defence in depth against IP-spraying). Reserve before inserting so
      // concurrent requests can't overshoot; give the slot back if nothing was inserted (duplicate).
      const slot = deps.globalCap.reserve(deps.now());
      if (!slot.ok) throw rateLimited(slot.retryAfter);
      let inserted: { id: string }[];
      try {
        inserted = await deps.db
          .insert(waitlist)
          .values({ email: parsed.data.email, source: parsed.data.source })
          .onConflictDoNothing({ target: waitlist.email })
          .returning({ id: waitlist.id });
      } catch (err) {
        slot.release();
        throw err;
      }
      if (inserted.length === 0) slot.release();

      // Same response for new and existing emails so the endpoint can't reveal who signed up.
      return c.json(OK, 200);
    },
  );

  return app;
}
