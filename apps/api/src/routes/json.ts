import type { Context } from "hono";
import type { ZodError, ZodTypeAny, z } from "zod";
import { HttpError } from "../errors.js";

export const MAX_JSON_BYTES = 10 * 1024;

/** zod error → 400 invalid_request with `fields` (first message per top-level field). */
export function invalidRequest(err: ZodError): HttpError {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.length ? String(i.path[0]) : "_";
    fields[k] ??= i.message.slice(0, 200);
  }
  return new HttpError(400, "invalid_request", "Please check the highlighted fields", {}, fields);
}

/** Reads a JSON body (≤ 10 KB, enforced by bodyLimit on the router) and validates it. */
export async function readJson<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request", "Body must be JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}

export function parseQuery<S extends ZodTypeAny>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}
