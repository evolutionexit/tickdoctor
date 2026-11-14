import type { IngestRejected } from "@tickdoctor/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Error for the agent-facing /v1/ingest routes. Rendered by the app error handler in the ingest
 * shape `{ ok: false, error, message?, retryAfterSeconds? }` (not the app's `{ error: { code } }`).
 */
export class IngestError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly error: IngestRejected["error"],
    readonly detail?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail ?? error);
  }

  body(): IngestRejected {
    const b: IngestRejected = { ok: false, error: this.error };
    if (this.detail !== undefined) b.message = this.detail;
    if (this.retryAfterSeconds !== undefined) b.retryAfterSeconds = this.retryAfterSeconds;
    return b;
  }

  headers(): Record<string, string> {
    return this.retryAfterSeconds !== undefined ? { "Retry-After": String(this.retryAfterSeconds) } : {};
  }
}

/**
 * True for a Postgres "data exception" (SQLSTATE class 22: numeric out of range, invalid text representation,
 * untranslatable character, ...): the INPUT was unstorable, not the server broken. Drivers/ORMs may wrap the
 * pg error in `cause`.
 */
export function isDataException(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^22[0-9A-Z]{3}$/.test(code)) return true;
  }
  return false;
}
