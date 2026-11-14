import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { INT4_MAX, metricsRequest, stripControl } from "@tickdoctor/shared";
import { isDataException } from "../src/ingest/errors.js";
import { hotValues, scrubText, storeMetrics } from "../src/ingest/storage.js";
import { freshFixture, handle, makeApp, makeServer, resetStorage } from "./helpers.js";

// Pentest F-03/B-01: unvalidated ingest numbers/strings reached Postgres and produced 500s.

let KEY = "";
let SERVER_ID = "";

beforeAll(async () => {
  await resetStorage();
  const s = await makeServer({ plan: "network" });
  KEY = s.key;
  SERVER_ID = s.serverId;
});
afterAll(() => handle.close());

const app = makeApp();
function post(endpoint: string, body: unknown) {
  return app.request(`/v1/ingest/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
}

/** metrics body with one sample, ts offset so each test stores its own row. */
type Sample = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let n = 0;
function metrics(mutate: (s: Sample) => void) {
  const f = freshFixture("metrics");
  f.payload.samples = [f.payload.samples[0]];
  f.payload.samples[0].ts = new Date(Date.now() - 1000 * ++n).toISOString();
  mutate(f.payload.samples[0]);
  return f;
}
const rejected = async (res: Response) => {
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, error: "invalid_payload" });
};

describe("numeric bounds", () => {
  it.each([
    ["world[].entities", (s: Sample) => (s.world[0].entities = 3_000_000_000)],
    ["world[].loadedChunks", (s: Sample) => (s.world[0].loadedChunks = 3_000_000_000)],
    ["players.count", (s: Sample) => (s.players.count = 3_000_000_000)],
    ["tileEntitiesByType value", (s: Sample) => (s.world[0].tileEntitiesByType["minecraft:hopper"] = 3_000_000_000)],
    ["heapUsedBytes 1e30", (s: Sample) => (s.jvm.heapUsedBytes = 1e30)],
    ["host.memAvailableBytes 1e30", (s: Sample) => (s.host.memAvailableBytes = 1e30)],
    ["tickCount", (s: Sample) => (s.tick.tickCount = 3_000_000_000)],
    ["msptP95 1e30", (s: Sample) => (s.tick.msptP95 = 1e30)],
    ["chunk x", (s: Sample) => (s.worstChunks = [{ world: "world", x: 3_000_000_000, z: 0, entities: 1, tileEntities: 1 }])],
  ])("metrics with %s is a 400, not a 500", async (_n, mutate) => {
    await rejected(await post("metrics", metrics(mutate)));
  });

  it("events with an out-of-range count is a 400", async () => {
    const f = freshFixture("events");
    f.payload.events = [{ type: "player_join", ts: new Date().toISOString(), playerCount: 3_000_000_000 }];
    await rejected(await post("events", f));
  });

  it("stores the maximum values exactly; sums over worlds are clamped to int4", async () => {
    const body = metrics((s: Sample) => {
      s.players.count = INT4_MAX;
      s.jvm.heapUsedBytes = Number.MAX_SAFE_INTEGER;
      s.world = ["a", "b", "c"].map((name) => ({
        name,
        loadedChunks: INT4_MAX,
        entities: INT4_MAX,
        entitiesByType: { x: INT4_MAX },
        tileEntitiesByType: { hopper: INT4_MAX, chest: INT4_MAX },
        countsAgeSeconds: 1,
      }));
    });
    const res = await post("metrics", body);
    expect(res.status).toBe(200);
    const rows = await handle.db.execute<{ players: number; entities: number; loaded_chunks: number; tile_entities: number; heap_used_bytes: string }>(
      sql`select players, entities, loaded_chunks, tile_entities, heap_used_bytes from metric_samples where server_id = ${SERVER_ID} and ts = ${body.payload.samples[0].ts}::timestamptz`,
    );
    expect(rows[0]).toMatchObject({ players: INT4_MAX, entities: INT4_MAX, loaded_chunks: INT4_MAX, tile_entities: INT4_MAX });
    expect(Number(rows[0]!.heap_used_bytes)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("hotValues clamps int4 sums", () => {
    const f = metricsRequest.parse(metrics((s: Sample) => {
      s.world = [0, 1].map((i) => ({ name: `w${i}`, loadedChunks: INT4_MAX, entities: INT4_MAX, entitiesByType: {}, tileEntitiesByType: { a: INT4_MAX }, countsAgeSeconds: 0 }));
    }));
    const h = hotValues(f.payload.samples[0]!);
    expect([h.entities, h.loaded_chunks, h.tile_entities]).toEqual([INT4_MAX, INT4_MAX, INT4_MAX]);
  });
});

describe("control characters", () => {
  it("stripControl removes NUL/control chars and lone surrogates, keeps \\t \\n \\r and valid text", () => {
    expect(stripControl("a\u0000b\u0007c\u007fd\te\nf\rg")).toBe("abcd\te\nf\rg");
    expect(stripControl("ok \u{1F600} é")).toBe("ok \u{1F600} é");
    expect(stripControl("x\ud800y")).toBe("x�y");
    expect(stripControl("x\udc00y")).toBe("x�y");
  });

  it("a NUL in a world name, a record key and an exception message is cleaned, not rejected", async () => {
    const body = metrics((s: Sample) => {
      s.world[0].name = "wor\u0000ld";
      s.world[0].entitiesByType = { "minecraft:\u0000cow": 3 };
    });
    expect((await post("metrics", body)).status).toBe(200);
    const row = await handle.db.execute<{ detail: Sample }>(
      sql`select detail from metric_samples where server_id = ${SERVER_ID} and ts = ${body.payload.samples[0].ts}::timestamptz`,
    );
    expect(row[0]!.detail.world[0].name).toBe("world");
    expect(row[0]!.detail.world[0].entitiesByType).toEqual({ "minecraft:cow": 3 });

    const ev = freshFixture("events");
    ev.payload.events = [
      { type: "exception", ts: new Date().toISOString(), exceptionClass: "java.lang.Boom\u0000", message: "bad \u0000 thing \ud800", stackHash: "abc", count: 1 },
    ];
    expect((await post("events", ev)).status).toBe(200);
    const e = await handle.db.execute<{ data: Sample }>(sql`select data from events where server_id = ${SERVER_ID} and type = 'exception' order by id desc limit 1`);
    expect(e[0]!.data.exceptionClass).toBe("java.lang.Boom");
    expect(e[0]!.data.message).toBe("bad  thing �");
  });

  it("scrubText never throws on odd input", () => {
    for (const v of ["", "\u0000", "a".repeat(100_000), "::::::::", "1.1.1.1.1.1.1.1", "\ud800", undefined as unknown as string, 5 as unknown as string]) {
      expect(() => scrubText(v)).not.toThrow();
    }
  });
});

describe("storage failures", () => {
  it("a Postgres data exception from storage is recognised as the sender's fault (wrapped or not)", async () => {
    // Bypasses the contract on purpose: what storage does if something unvalidated still gets through.
    const f = freshFixture("metrics");
    f.payload.samples = [f.payload.samples[0]];
    f.payload.samples[0].players.count = 3_000_000_000;
    f.payload.samples[0].ts = new Date(Date.now() - 500).toISOString();
    const err = await storeMetrics(handle.db, { serverId: SERVER_ID, plan: "network" } as never, f, Date.now()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isDataException(err)).toBe(true);
    expect(isDataException(new Error("connection refused"))).toBe(false);
    expect(isDataException({ cause: { code: "22003" } })).toBe(true);
  });
});
