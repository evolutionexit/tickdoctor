import type { MiddlewareHandler } from "hono";
import { HttpError } from "../errors.js";

/**
 * CSRF guard for session-less, state-changing endpoints: the Origin header must equal
 * the allowed origin exactly. A missing Origin is rejected too (browsers always send it on POST).
 */
export function originCheck(allowedOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin || origin !== allowedOrigin) {
      throw new HttpError(403, "bad_origin", "Request origin not allowed");
    }
    await next();
  };
}
