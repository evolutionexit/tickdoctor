import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { waitlist } from "../src/db/schema.js";
import { PEPPER, WEB_ORIGIN, freshIp, handle, makeApp, resetDb } from "./helpers.js";

type App = ReturnType<typeof makeApp>;

function post(app: App, body: unknown, opts: { origin?: string | null; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? WEB_ORIGIN;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return app.request("/api/waitlist", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

const valid = { email: "Owner@Example.com", source: "landing-hero", consent: true, website: "" };

async function rows() {
  return handle.db.select().from(waitlist);
}

beforeEach(resetDb);
afterAll(() => handle.close());

describe("POST /api/waitlist", () => {
  it("stores a new signup, lower-cased, with only email/source/created_at", async () => {
    const res = await post(makeApp(), valid, { ip: freshIp() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ email: "owner@example.com", source: "landing-hero" });
    expect(Object.keys(r[0]!).sort()).toEqual(["createdAt", "email", "id", "source"]);
  });

  it("defaults source to 'other' when omitted", async () => {
    const res = await post(makeApp(), { email: "a@b.co", consent: true }, { ip: freshIp() });
    expect(res.status).toBe(200);
    const [row] = await handle.db.select().from(waitlist).where(eq(waitlist.email, "a@b.co"));
    expect(row?.source).toBe("other");
  });

  it("returns the identical response for a duplicate and keeps one row", async () => {
    const app = makeApp();
    const ip = freshIp();
    const first = await post(app, valid, { ip });
    const second = await post(app, { ...valid, email: "  OWNER@example.COM ", source: "landing-footer" }, { ip });
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe("landing-hero");
  });

  it("accepts but does not store honeypot submissions", async () => {
    const app = makeApp();
    const res = await post(app, { ...valid, website: "http://spam.example" }, { ip: freshIp() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Even with otherwise-invalid fields, bots get the success response.
    const res2 = await post(app, { email: "nope", website: "x".repeat(600) }, { ip: freshIp() });
    expect(res2.status).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects an invalid email with invalid_email", async () => {
    const res = await post(makeApp(), { ...valid, email: "not-an-email" }, { ip: freshIp() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_email");
    expect(await rows()).toHaveLength(0);
  });

  it("rejects missing or false consent with consent_required", async () => {
    const app = makeApp();
    const { consent: _omit, ...noConsent } = valid;
    const a = await post(app, noConsent, { ip: freshIp() });
    const b = await post(app, { ...valid, consent: false }, { ip: freshIp() });
    for (const res of [a, b]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("consent_required");
    }
    expect(await rows()).toHaveLength(0);
  });

  it("rejects an unknown source and non-JSON bodies with invalid_request", async () => {
    const app = makeApp();
    const a = await post(app, { ...valid, source: "twitter" }, { ip: freshIp() });
    const b = await post(app, null, { ip: freshIp(), raw: "{not json" });
    for (const res of [a, b]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
  });

  it("rejects a foreign or missing Origin with 403 bad_origin", async () => {
    const app = makeApp();
    const a = await post(app, valid, { ip: freshIp(), origin: "https://evil.example" });
    const b = await post(app, valid, { ip: freshIp(), origin: null });
    const c = await post(app, valid, { ip: freshIp(), origin: `${WEB_ORIGIN}.evil.example` });
    for (const res of [a, b, c]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "bad_origin", message: expect.any(String) } });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("rate limits to 5 requests per 10 minutes per IP, with Retry-After", async () => {
    let now = 1_000_000;
    const app = makeApp({ now: () => now });
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect((await post(app, { ...valid, email: `u${i}@example.com` }, { ip })).status).toBe(200);
    }
    const limited = await post(app, valid, { ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect((await limited.json()).error.code).toBe("rate_limited");

    // Other IPs are unaffected.
    expect((await post(app, valid, { ip: freshIp() })).status).toBe(200);

    // Window resets after 10 minutes.
    now += 4 * 60 * 1000;
    expect((await post(app, valid, { ip })).headers.get("retry-after")).toBe("360");
    now += 6 * 60 * 1000;
    expect((await post(app, valid, { ip })).status).toBe(200);
  });

  describe("client IP behind Caddy (TRUST_PROXY=true)", () => {
    // Real topology: browser -> Caddy -> API. The API port is not published, so Caddy is the only
    // peer. Caddy has no trusted_proxies, so it REPLACES any client-supplied X-Forwarded-For with
    // the peer address: the API sees exactly one entry, the real client IP.
    it("keys the per-IP limit on the X-Forwarded-For value Caddy sets", async () => {
      const app = makeApp();
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < 5; i++) await post(app, valid, { ip: a });
      expect((await post(app, valid, { ip: a })).status).toBe(429);
      expect((await post(app, valid, { ip: b })).status).toBe(200);
    });

    it("uses the right-most entry if a header ever arrives with several", async () => {
      // Caddy never forwards multiple entries, but if it did, only the right-most (added by the
      // trusted hop) is trustworthy; left-most entries are client-controlled and are ignored.
      const app = makeApp();
      const real = freshIp();
      for (let i = 0; i < 5; i++) await post(app, valid, { ip: `10.0.0.${i}, ${real}` });
      expect((await post(app, valid, { ip: `10.9.9.9, ${real}` })).status).toBe(429);
      expect((await post(app, valid, { ip: real })).status).toBe(429);
    });
  });

  it("ignores X-Forwarded-For when TRUST_PROXY is false (no proxy in front)", async () => {
    const app = makeApp({ env: { WEB_PUBLIC_URL: WEB_ORIGIN, API_KEY_PEPPER: PEPPER, TRUST_PROXY: false } });
    // app.request has no socket, so every request resolves to the same "unknown" peer:
    // rotating X-Forwarded-For values must not buy extra requests.
    for (let i = 0; i < 5; i++) await post(app, valid, { ip: freshIp() });
    expect((await post(app, valid, { ip: freshIp() })).status).toBe(429);
  });

  describe("global cap on new signups", () => {
    const HOUR = 60 * 60 * 1000;
    const withIp = (app: App, email: string, ip = freshIp()) => post(app, { ...valid, email }, { ip });

    it("defaults to 200 new signups per rolling hour, then 429 with Retry-After", async () => {
      let now = 5_000_000;
      const app = makeApp({ now: () => now });
      for (let i = 0; i < 200; i++) {
        expect((await withIp(app, `g${i}@example.com`, `198.51.${Math.floor(i / 4)}.${i % 4}`)).status).toBe(200);
      }
      now += 10 * 60 * 1000;
      const over = await withIp(app, "over@example.com");
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe(String(50 * 60));
      expect((await over.json()).error.code).toBe("rate_limited");
      expect(await rows()).toHaveLength(200);
    });

    it("is configurable and rolls: slots free up an hour after each insert", async () => {
      let now = 1_000_000;
      const app = makeApp({ now: () => now, env: { WEB_PUBLIC_URL: WEB_ORIGIN, API_KEY_PEPPER: PEPPER, TRUST_PROXY: true, WAITLIST_GLOBAL_CAP_PER_HOUR: 2 } });
      expect((await withIp(app, "a@example.com")).status).toBe(200);
      now += 30 * 60 * 1000;
      expect((await withIp(app, "b@example.com")).status).toBe(200);
      const over = await withIp(app, "c@example.com");
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe(String(30 * 60));
      now += 30 * 60 * 1000; // first insert is now an hour old
      expect((await withIp(app, "c@example.com")).status).toBe(200);
      expect((await withIp(app, "d@example.com")).status).toBe(429);
      now += HOUR;
      expect((await withIp(app, "d@example.com")).status).toBe(200);
      expect(await rows()).toHaveLength(4);
    });

    it("counts only real inserts, not duplicates or honeypot hits", async () => {
      const app = makeApp({ env: { WEB_PUBLIC_URL: WEB_ORIGIN, API_KEY_PEPPER: PEPPER, TRUST_PROXY: true, WAITLIST_GLOBAL_CAP_PER_HOUR: 2 } });
      expect((await withIp(app, "dup@example.com")).status).toBe(200);
      for (let i = 0; i < 4; i++) expect((await withIp(app, "DUP@example.com")).status).toBe(200);
      for (let i = 0; i < 4; i++) {
        expect((await post(app, { ...valid, website: "spam" }, { ip: freshIp() })).status).toBe(200);
      }
      expect((await withIp(app, "second@example.com")).status).toBe(200);
      expect((await withIp(app, "third@example.com")).status).toBe(429);
      expect(await rows()).toHaveLength(2);
    });
  });

  it("rejects bodies over 10 KB with 413", async () => {
    const res = await post(makeApp(), { ...valid, padding: "x".repeat(11 * 1024) }, { ip: freshIp() });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(await rows()).toHaveLength(0);
  });
});

describe("GET /health", () => {
  it("reports db: true when Postgres is reachable", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });

  it("reports db: false when the query fails", async () => {
    const brokenDb = { execute: () => Promise.reject(new Error("down")) } as never;
    const res = await makeApp({ db: brokenDb }).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: false });
  });
});

describe("route groups", () => {
  it("unknown /v1 routes return 404 in the standard shape", async () => {
    const res = await makeApp().request("/v1/nope", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("uses limiters passed in via deps", async () => {
    const calls: string[] = [];
    const app = makeApp({
      limiters: {
        waitlistPerIp: { hit: (key) => (calls.push(key), 42) },
        waitlistGlobal: { reserve: () => ({ ok: true, release: () => {} }) },
      },
    });
    const res = await post(app, valid, { ip: "192.0.2.7" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(calls).toEqual(["192.0.2.7"]);
  });
});

describe("unknown routes", () => {
  it("return the standard error shape", async () => {
    const res = await makeApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});
