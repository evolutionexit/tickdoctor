import { gunzip } from "node:zlib";
import { IngestError } from "./errors.js";

export const MAX_INGEST_BODY_BYTES = 1024 * 1024;

function tooLarge(what: string, max: number) {
  return new IngestError(413, "payload_too_large", `${what} body must be at most ${max} bytes`);
}

/** Reads the raw request body, aborting as soon as it exceeds `max` bytes. */
async function readCapped(req: Request, max: number): Promise<Buffer> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw tooLarge("Request", max);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge("Request", max);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Decompresses with a hard output cap. zlib stops inflating as soon as the output would exceed
 * `maxOutputLength` (it never materialises the whole bomb), so a tiny gzip that expands to
 * gigabytes costs at most ~`max` bytes of memory.
 */
function gunzipCapped(input: Buffer, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(input, { maxOutputLength: max }, (err, out) => {
      if (!err) return resolve(out);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) reject(tooLarge("Decompressed", max));
      else reject(new IngestError(400, "invalid_payload", "Body is not valid gzip"));
    });
  });
}

export interface IngestBody {
  json: unknown;
  /** Bytes on the wire (compressed size when gzip). */
  rawBytes: number;
  /** Bytes of JSON after decompression. */
  jsonBytes: number;
}

/** Reads, optionally gunzips (Content-Encoding: gzip) and parses a JSON ingest body; both sizes capped. */
export async function readIngestBody(req: Request, max = MAX_INGEST_BODY_BYTES): Promise<IngestBody> {
  const raw = await readCapped(req, max);
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  let decoded: Buffer;
  if (encoding === "" || encoding === "identity") decoded = raw;
  else if (encoding === "gzip" || encoding === "x-gzip") decoded = await gunzipCapped(raw, max);
  else throw new IngestError(400, "invalid_payload", "Unsupported Content-Encoding (use gzip or none)");

  let json: unknown;
  try {
    json = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new IngestError(400, "invalid_payload", "Body must be JSON");
  }
  return { json, rawBytes: raw.byteLength, jsonBytes: decoded.byteLength };
}
