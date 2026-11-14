import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { HttpError, errorBody } from "../errors.js";
import { IngestError } from "../ingest/errors.js";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof IngestError) {
    for (const [k, v] of Object.entries(err.headers())) c.header(k, v);
    return c.json(err.body(), err.status);
  }
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json(errorBody(err.code, err.message, err.fields), err.status);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    return c.json(errorBody(status >= 500 ? "internal" : "invalid_request", err.message || "Request failed"), status);
  }
  // Only the route and the error's name/code: messages and stacks of driver/library errors can carry
  // request data (emails, SQL parameters, payload fragments). The path never includes the query string.
  const code = (err as { code?: unknown }).code;
  console.error(
    `unhandled error ${c.req.method} ${c.req.path} name=${safeToken(err?.name)} code=${typeof code === "string" || typeof code === "number" ? safeToken(String(code)) : "-"}`,
  );
  return c.json(errorBody("internal", "Something went wrong"), 500);
};

/** Short, single-line, printable token for logs. */
function safeToken(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v.replace(/[^\w.:-]/g, "_").slice(0, 60) : "-";
}

export const notFoundHandler: NotFoundHandler = (c) => c.json(errorBody("not_found", "Not found"), 404);
