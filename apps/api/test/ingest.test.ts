import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventsRequest, helloRequest, metricsRequest, snapshotRequest } from "@tickdoctor/shared";
import type { AppDeps } from "../src/app.js";
import { rotateKey } from "../src/servers.js";
import { dbKeyVerifier } from "../src/ingest/auth.js";
import type { Db } from "../src/db/client.js";
import { ENDPOINTS, PEPPER, WEB_ORIGIN, fixture, handle, makeApp, makeServer, resetStorage } from "./helpers.js";

let KEY = "";
let SERVER_ID = "";

beforeAll(async () => {
  await resetStorage();
  const s = await makeServer({ plan: "network" });
  KEY = s.key;
  SERVER_ID = s.serverId;
});

function app(env: Partial<AppDeps["env"]> = {}, extra: Partial<AppDeps> = {}) {
  const lines: string[] = [];
  const a = makeApp({
    env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: PEPPER, ...env },
    log: (l) => lines.push(l),
    ...extra,
  });
  return { a, lines };
}

/** Same payload, fresh timestamps, so stored rows differ per call (not needed for acceptance, but realistic). */
function send(
  a: ReturnType<typeof makeApp>,
  endpoint: string,
  body: unknown,
  opts: { key?: string | null; gzip?: boolean; raw?: BodyInit; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? KEY}`;
  let payload: BodyInit = opts.raw ?? JSON.stringify(body);
  if (opts.gzip) {
    headers["content-encoding"] = "gzip";
    payload = gzipSync(typeof payload === "string" ? payload : JSON.stringify(body));
  }
  return a.request(`/v1/ingest/${endpoint}`, { method: "POST", headers, body: payload });
}

/** Fixture samples are dated 2026-11-09; move them to "now" so plan raw retention never drops them. */
function fresh(ep: (typeof ENDPOINTS)[number]) {
  const f = fixture(ep);
  if (ep === "metrics") {
    const base = Date.now() - 60_000;
    f.payload.samples.forEach((s: { ts: string }, i: number) => (s.ts = new Date(base + i * 10_000).toISOString()));
  }
  return f;
}

afterAll(() => handle.close());

describe("fixtures", () => {
  it("pass the shared zod schemas", () => {
    expect(helloRequest.safeParse(fixture("hello")).success).toBe(true);
    expect(metricsRequest.safeParse(fixture("metrics")).success).toBe(true);
    expect(eventsRequest.safeParse(fixture("events")).success).toBe(true);
    expect(snapshotRequest.safeParse(fixture("snapshot")).success).toBe(true);
  });
});

describe("POST /v1/ingest/*", () => {
  it.each(ENDPOINTS)("accepts a valid %s payload", async (ep) => {
    const { a, lines } = app();
    const res = await send(a, ep, fresh(ep));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`ingest ${ep} boot=6f1c2a9e`);
  });

  it("logs one summary line with the latest sample's numbers and no player ids", async () => {
    const { a, lines } = app();
    await send(a, "metrics", fresh("metrics"));
    await send(a, "events", fixture("events"));
    expect(lines[0]).toMatch(/n=2 p95=38\.6ms players=2 heapMB=1434 agentMsPerTick=0\.043 bytes=\d+/);
    for (const l of lines) {
      expect(l).not.toMatch(/[0-9a-f]{64}/);
      expect(l).not.toContain("{");
    }
  });

  it("rejects an invalid payload with a value-free issue summary", async () => {
    const { a } = app();
    const bad = fixture("metrics");
    bad.payload.samples[0].tick.msptP95 = -5;
    bad.payload.samples[0].players.pings[0].id = "secret-player-id";
    bad.schemaVersion = 99;
    const res = await send(a, "metrics", bad);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_payload");
    expect(body.message).toContain("schemaVersion");
    expect(body.message).toContain("payload.samples.0.tick.msptP95");
    expect(body.message).not.toContain("secret-player-id");
    expect(body.message).not.toContain("-5");
  });

  it("caps the issue summary at 5 issues", async () => {
    const { a } = app();
    const res = await send(a, "hello", { payload: {} });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.message.split(",").length).toBe(5);
    expect(body.message).toMatch(/\+\d+ more/);
  });

  it("rejects a non-JSON body and unknown encodings", async () => {
    const { a } = app();
    expect((await send(a, "hello", null, { raw: "not json" })).status).toBe(400);
    const res = await send(a, "hello", fixture("hello"), { headers: { "content-encoding": "br" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_payload");
  });

  it.each([
    ["missing", null],
    ["malformed", "td_stub_wrong_key_wrong_key_wrong"],
    ["unknown", "td_live_" + "0".repeat(43)],
    ["empty", ""],
  ])("401 invalid_key for a %s key", async (_, key) => {
    const { a } = app();
    const res = await send(a, "metrics", fixture("metrics"), { key });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_key", message: "Missing or invalid API key" });
  });

  it("401 revoked_key after rotation; the new key works", async () => {
    const s = await makeServer();
    const { a } = app();
    expect((await send(a, "hello", fixture("hello"), { key: s.key })).status).toBe(200);
    const rotated = await rotateKey(handle.db, PEPPER, s.serverId);
    const res = await send(a, "hello", fixture("hello"), { key: s.key });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "revoked_key", message: "API key has been revoked" });
    expect((await send(a, "hello", fixture("hello"), { key: rotated!.key })).status).toBe(200);
  });

  it("a key hashed with another pepper is unknown", async () => {
    const { a } = app({ API_KEY_PEPPER: "another-pepper-0123456789" });
    expect((await send(a, "hello", fixture("hello"))).status).toBe(401);
  });

  it("accepts gzip bodies", async () => {
    const { a, lines } = app();
    const res = await send(a, "snapshot", fixture("snapshot"), { gzip: true });
    expect(res.status).toBe(200);
    const [, wire, json] = /bytes=(\d+)\/(\d+)/.exec(lines[0]!)!;
    expect(Number(wire)).toBeLessThan(Number(json));
  });

  it("413 for a gzip bomb that inflates beyond 1 MB", async () => {
    const { a, lines } = app();
    // ~50 MB of JSON-ish padding compresses to ~50 KB.
    const bomb = gzipSync(Buffer.from(`{"x":"${"a".repeat(50 * 1024 * 1024)}"}`));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const res = await send(a, "metrics", null, { raw: bomb, headers: { "content-encoding": "gzip" } });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: "payload_too_large" });
    expect(lines).toHaveLength(0);
  });

  it("413 for a raw body over 1 MB", async () => {
    const { a } = app();
    const big = JSON.stringify({ x: "a".repeat(1024 * 1024 + 10) });
    const res = await send(a, "metrics", null, { raw: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("413 for an oversized body even without Content-Length (streamed)", async () => {
    const { a } = app();
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ >= 8) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    const res = await a.request("/v1/ingest/metrics", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: stream,
      // @ts-expect-error Node fetch needs duplex for stream bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  it("rate limits per key at 30/min with retryAfterSeconds and Retry-After", async () => {
    let now = 1_000_000;
    const { a } = app({}, { now: () => now });
    const body = fixture("hello");
    for (let i = 0; i < 30; i++) expect((await send(a, "hello", body)).status).toBe(200);
    const res = await send(a, "hello", body);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, error: "rate_limited" });
    expect(json.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(json.retryAfterSeconds));
    now += 60_000;
    expect((await send(a, "hello", body)).status).toBe(200);
  });

  it("rate limits failed-auth attempts per IP at 60/min (429 with Retry-After), valid keys still pass", async () => {
    let now = 1_000_000;
    const { a } = app({}, { now: () => now });
    const ip = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 60; i++) {
      expect((await send(a, "hello", {}, { key: "wrong-key", headers: ip })).status).toBe(401);
    }
    const res = await send(a, "hello", {}, { key: "wrong-key", headers: ip });
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, error: "rate_limited" });
    expect(json.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(json.retryAfterSeconds));
    // Missing and well-formed-but-unknown keys are failed attempts too.
    expect((await send(a, "hello", {}, { key: null, headers: ip })).status).toBe(429);
    expect((await send(a, "hello", {}, { key: `td_live_${"A".repeat(43)}`, headers: ip })).status).toBe(429);
    // A valid key is verified first and never blocked by the failed-auth bucket, from that IP or another.
    expect((await send(a, "hello", fixture("hello"), { headers: ip })).status).toBe(200);
    expect(
      (await send(a, "hello", fixture("hello"), { headers: { "x-forwarded-for": "198.51.100.8" } })).status,
    ).toBe(200);
    now += 60_000;
    expect((await send(a, "hello", {}, { key: "wrong-key", headers: ip })).status).toBe(401);
  });

  it("does not count authenticated traffic per IP: 120 valid requests from one NAT IP across 6 keys succeed", async () => {
    const { a } = app({}, { now: () => 2_000_000 });
    const ip = { "x-forwarded-for": "198.51.100.20" };
    const keys = await Promise.all(Array.from({ length: 6 }, () => makeServer({ plan: "network" })));
    for (let i = 0; i < 120; i++) {
      const res = await send(a, "hello", fixture("hello"), { key: keys[i % keys.length]!.key, headers: ip });
      expect(res.status).toBe(200);
    }
  });

  it("an attacker spraying bad keys from a shared IP cannot lock out valid agents on that IP", async () => {
    const { a } = app({}, { now: () => 3_000_000 });
    const ip = { "x-forwarded-for": "198.51.100.30" };
    for (let i = 0; i < 80; i++) await send(a, "hello", {}, { key: "junk", headers: ip });
    expect((await send(a, "hello", {}, { key: "junk", headers: ip })).status).toBe(429);
    const s = await makeServer();
    expect((await send(a, "hello", fixture("hello"), { key: s.key, headers: ip })).status).toBe(200);
  });

  it("negative cache: repeated identical unknown / revoked keys skip the DB (60 s, bounded); valid keys always hit it", async () => {
    let selects = 0;
    const counting = new Proxy(handle.db, {
      get(target, prop, recv) {
        if (prop === "select") selects++;
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    let now = 1_000_000;
    const v = dbKeyVerifier(counting, PEPPER, { now: () => now, maxEntries: 3 });
    const unknown = `td_live_${"Z".repeat(43)}`;
    for (let i = 0; i < 50; i++) expect(await v.verify(unknown)).toBe("invalid");
    expect(selects).toBe(1);
    const s = await makeServer();
    await rotateKey(handle.db, PEPPER, s.serverId);
    for (let i = 0; i < 20; i++) expect(await v.verify(s.key)).toBe("revoked");
    expect(selects).toBe(2);
    // Malformed tokens never reach the DB; valid keys are never cached.
    expect(await v.verify("junk")).toBe("invalid");
    for (let i = 0; i < 3; i++) expect(await v.verify(KEY)).toMatchObject({ serverId: SERVER_ID });
    expect(selects).toBe(5);
    // TTL: after 60 s the unknown key is looked up again.
    now += 60_001;
    expect(await v.verify(unknown)).toBe("invalid");
    expect(selects).toBe(6);
    // Bounded: with 3 entries max, the oldest is evicted.
    for (const c of ["A", "B", "C"]) await v.verify(`td_live_${c.repeat(43)}`);
    expect(selects).toBe(9);
    await v.verify(unknown); // evicted → DB again
    expect(selects).toBe(10);
  });

  it("returns config.requestSnapshot once after it was requested, then clears it", async () => {
    const { a } = app();
    const { requestSnapshot } = await import("../src/ingest/storage.js");
    expect(await (await send(a, "metrics", fresh("metrics"))).json()).toEqual({ ok: true });
    expect(await requestSnapshot(handle.db, SERVER_ID)).toBe(true);
    expect(await (await send(a, "metrics", fresh("metrics"))).json()).toEqual({ ok: true, config: { requestSnapshot: true } });
    expect(await (await send(a, "metrics", fresh("metrics"))).json()).toEqual({ ok: true });
  });

  it("snapshots: at most one per 2 minutes per server", async () => {
    let now = 5_000_000;
    const { a } = app({}, { now: () => now });
    const s = await makeServer();
    const snap = fixture("snapshot");
    expect((await send(a, "snapshot", snap, { key: s.key })).status).toBe(200);
    snap.payload.ts = "2026-11-09T14:10:00.000Z";
    const res = await send(a, "snapshot", snap, { key: s.key });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    now += 120_000;
    expect((await send(a, "snapshot", snap, { key: s.key })).status).toBe(200);
  });
});

describe("GET /v1/debug/last", () => {
  const get = (a: ReturnType<typeof makeApp>, q = "", key: string | null = KEY) =>
    a.request(`/v1/debug/last${q}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  it("404 when INGEST_DEBUG is off", async () => {
    const { a } = app();
    const res = await get(a, "?endpoint=metrics");
    expect(res.status).toBe(404);
  });

  it("returns the stored payloads (bounded to the last 20) when on", async () => {
    let now = 0;
    const { a } = app({ INGEST_DEBUG: true }, { now: () => (now += 3000) }); // stays under 30/min
    const m = fresh("metrics");
    for (let i = 0; i < 22; i++) {
      m.agentVersion = `0.1.${i}`;
      expect((await send(a, "metrics", m)).status).toBe(200);
    }
    await send(a, "hello", fixture("hello"));
    const res = await get(a, "?endpoint=metrics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe("metrics");
    expect(body.count).toBe(20);
    expect(body.items[0].body.agentVersion).toBe("0.1.2");
    expect(body.items[19].body.agentVersion).toBe("0.1.21");
    expect(body.items[19].body.payload.samples).toHaveLength(2);
    expect((await (await get(a, "?endpoint=hello")).json()).count).toBe(1);
  });

  it("only shows the caller's own server", async () => {
    const { a } = app({ INGEST_DEBUG: true });
    const other = await makeServer();
    expect((await send(a, "hello", fixture("hello"))).status).toBe(200);
    const mine = await (await get(a, "?endpoint=hello")).json();
    expect(mine.count).toBe(1);
    const theirs = await (await get(a, "?endpoint=hello", other.key)).json();
    expect(theirs.count).toBe(0);
  });

  it("requires the key and a known endpoint", async () => {
    const { a } = app({ INGEST_DEBUG: true });
    expect((await get(a, "", null)).status).toBe(401);
    expect((await get(a, "?endpoint=nope")).status).toBe(400);
  });
});
