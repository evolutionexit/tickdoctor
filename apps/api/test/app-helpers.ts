import { CSRF_COOKIE, CSRF_HEADER } from "@tickdoctor/shared";
import { MemoryMailer } from "../src/auth/mailer.js";
import type { AppDeps } from "../src/app.js";
import { LiveHub } from "../src/live/hub.js";
import { WEB_ORIGIN, fixture, freshIp, handle, makeApp } from "./helpers.js";

// Phase 5 test harness: an app with an injected clock, an in-memory mailer and a cookie-jar client.

export type TestApp = ReturnType<typeof makeApp>;

export interface Harness {
  app: TestApp;
  mailer: MemoryMailer;
  hub: LiveHub;
  clock: { now: number };
  logs: string[];
}

export function makeHarness(overrides: Partial<AppDeps> = {}, startMs = Date.now()): Harness {
  const clock = { now: startMs };
  const mailer = new MemoryMailer();
  const logs: string[] = [];
  const now = () => clock.now;
  const hub = new LiveHub({ db: handle.db, now });
  const app = makeApp({ now, mailer, hub, log: (l) => logs.push(l), detect: false, ...overrides });
  return { app, mailer, hub, clock, logs };
}

/** Browser-like client: keeps cookies, sends Origin + the double-submit CSRF header, one IP per client. */
export class Client {
  readonly cookies = new Map<string, string>();
  constructor(
    readonly app: TestApp,
    readonly ip: string = freshIp(),
  ) {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async req(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; csrf?: boolean; origin?: string | null; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "x-forwarded-for": this.ip };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (opts.origin !== null) headers.origin = opts.origin ?? WEB_ORIGIN;
    const csrf = this.cookies.get(CSRF_COOKIE);
    if (opts.csrf !== false && csrf) headers[CSRF_HEADER] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, opts.headers ?? {});
    const res = await this.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    this.absorb(res);
    return res;
  }

  get(path: string) {
    return this.req("GET", path);
  }
  post(path: string, body?: unknown) {
    return this.req("POST", path, body ?? {});
  }

  /** Loads the session once (issues td_csrf), like the web app does on load. */
  async init() {
    await this.get("/api/auth/session");
    return this;
  }
}

export const tokenFrom = (text: string | undefined): string => {
  const m = /token=([A-Za-z0-9_-]+)/.exec(text ?? "");
  if (!m) throw new Error(`no token in mail: ${text}`);
  return m[1]!;
};

let emailCounter = 0;
export const freshEmail = (tag = "user") => `${tag}${++emailCounter}-${Date.now() % 100000}@test.local`;
export const PASSWORD = "correct horse battery";

/** Signs up (email only) and confirms via the emailed link, choosing PASSWORD → a logged-in, confirmed client. */
export async function verifiedUser(h: Harness, email = freshEmail(), password = PASSWORD): Promise<{ client: Client; email: string; id: string }> {
  const client = await new Client(h.app).init();
  const s = await client.post("/api/auth/signup", { email });
  if (s.status !== 200) throw new Error(`signup ${s.status}`);
  await flush();
  const v = await client.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)?.text), password, consent: true });
  if (v.status !== 200) throw new Error(`verify ${v.status}`);
  const body = (await v.json()) as { user: { id: string } };
  return { client, email, id: body.user.id };
}

/** Waits until queued fire-and-forget work (mail sends, live publishes) has run. */
export const flush = () => new Promise((r) => setTimeout(r, 20));

/** A metrics payload with `n` samples ending at `endMs` (10 s apart), from the hand-made fixture. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON, tweaked freely by tests
export function metricsPayload(endMs: number, n = 1, tweak: (s: Record<string, any>, i: number) => void = () => {}) {
  const base = fixture("metrics");
  const tpl = base.payload.samples[0];
  const samples = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = structuredClone(tpl);
    s.ts = new Date(endMs - i * 10_000).toISOString();
    s.tick.slowTicks = [];
    tweak(s, i);
    samples.push(s);
  }
  return { ...base, sentAt: new Date(endMs).toISOString(), payload: { samples } };
}

export async function ingest(app: TestApp, key: string, endpoint: "hello" | "metrics", body: unknown) {
  return app.request(`/v1/ingest/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-forwarded-for": freshIp() },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed event JSON, asserted by tests
export type SseEvent = { event: string; data: any };

/** Incremental SSE reader over a streaming response. `until` is re-checked after every chunk. */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const state = { raw: "", events: [] as SseEvent[] };
  // A read that lost a race against the timeout stays pending; reuse it so no chunk is dropped.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const parse = () => {
    state.events = [];
    for (const block of state.raw.split("\n\n")) {
      const ev = /^event: (.+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      if (ev && data) state.events.push({ event: ev[1]!, data: JSON.parse(data[1]!) });
    }
  };
  return {
    state,
    async until(pred: (events: SseEvent[], raw: string) => boolean, timeoutMs = 5000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (!pred(state.events, state.raw)) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        pending ??= reader.read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([pending, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), left)))]);
        clearTimeout(timer);
        if (chunk === "timeout") return pred(state.events, state.raw);
        pending = null;
        if (chunk.done) return pred(state.events, state.raw);
        state.raw += dec.decode(chunk.value, { stream: true });
        parse();
      }
      return true;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}
