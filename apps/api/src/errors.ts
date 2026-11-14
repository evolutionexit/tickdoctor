import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    /** Field → message (400 invalid_request). */
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string, fields?: Record<string, string>): ErrorBody {
  return fields ? { error: { code, message, fields } } : { error: { code, message } };
}
