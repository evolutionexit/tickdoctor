import type { MiddlewareHandler } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";
import { HttpError } from "../errors.js";

export function bodyLimit(maxBytes: number): MiddlewareHandler {
  return honoBodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw new HttpError(413, "payload_too_large", `Request body must be at most ${maxBytes} bytes`);
    },
  });
}
