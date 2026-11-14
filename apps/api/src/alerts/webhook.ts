import { DISCORD_WEBHOOK_RE } from "@tickdoctor/shared";

// Discord webhook delivery (contract app-phase6.ts "Delivery"): 5 s timeout, at most 2 retries on 5xx / 429
// (honours retry_after, capped at 30 s), 401/404 → the webhook is gone. The URL never appears in a result, an error
// or a log line: every message below is our own text.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const MAX_RETRIES = 2;
export const RETRY_CAP_MS = 30_000;

export interface SendResult {
  ok: boolean;
  httpStatus: number | null;
  /** Plain words, never the URL. */
  error: string | null;
  /** 401/404: the webhook was deleted or the token is wrong. */
  invalid: boolean;
}

export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Removes anything URL-like (defence in depth for messages that might come from elsewhere). */
export function scrubUrl(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, "[url]").replace(/\/api\/webhooks\/\S+/gi, "[url]").slice(0, 300);
}

async function retryAfterMs(res: Response, attempt: number): Promise<number> {
  let secs: number | null = null;
  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) secs = body.retry_after;
  } catch {
    /* not JSON */
  }
  if (secs === null) {
    const raw = res.headers.get("retry-after");
    const h = raw === null || raw.trim() === "" ? NaN : Number(raw);
    if (Number.isFinite(h) && h >= 0) secs = h;
  }
  const ms = secs !== null ? Math.ceil(secs * 1000) : 1000 * 2 ** attempt;
  return Math.min(Math.max(ms, 0), RETRY_CAP_MS);
}

function describe(status: number): string {
  if (status === 401 || status === 404) return "Discord says this webhook doesn't exist any more. Paste a new webhook URL.";
  if (status === 429) return "Discord is rate limiting this webhook. Try again later.";
  if (status >= 500) return `Discord had a problem (HTTP ${status}). Try again later.`;
  if (status === 400) return "Discord refused the message (HTTP 400).";
  return `Discord answered HTTP ${status}.`;
}

export async function sendWebhook(
  url: string,
  body: unknown,
  opts: { fetch?: FetchLike; sleep?: Sleep; timeoutMs?: number; maxRetries?: number } = {},
): Promise<SendResult> {
  // SSRF guard: the API never fetches anything but a Discord webhook.
  if (!DISCORD_WEBHOOK_RE.test(url)) return { ok: false, httpStatus: null, error: "Not a Discord webhook URL.", invalid: true };
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.maxRetries ?? MAX_RETRIES;
  const payload = JSON.stringify(body);
  let last: SendResult = { ok: false, httpStatus: null, error: "Couldn't reach Discord.", invalid: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await f(`${url}?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      last = { ok: false, httpStatus: null, error: timeout ? "Discord didn't answer within 5 seconds." : "Couldn't reach Discord.", invalid: false };
      // A network/DNS error is retried once (a blip); a timeout is not (it already waited 5 s).
      if (timeout || attempt > 0 || attempt === retries) return last;
      await sleep(1000);
      continue;
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, httpStatus: res.status, error: null, invalid: false };
    }
    const invalid = res.status === 401 || res.status === 404;
    last = { ok: false, httpStatus: res.status, error: describe(res.status), invalid };
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === retries) {
      await res.body?.cancel().catch(() => {});
      return last;
    }
    const wait = await retryAfterMs(res, attempt);
    await res.body?.cancel().catch(() => {});
    await sleep(wait);
  }
  return last;
}

/** "https://discord.com/api/webhooks/1234…/••••" */
export function maskWebhook(url: string): string {
  const m = /^(https:\/\/[^/]+)\/api\/webhooks\/(\d+)\//.exec(url);
  if (!m) return "••••";
  return `${m[1]}/api/webhooks/${m[2]!.slice(0, 4)}…/••••`;
}
