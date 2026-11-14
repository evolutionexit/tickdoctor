import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { scrubJvmFlag, scrubText } from "../src/ingest/storage.js";
import { handle, fixture, makeApp, makeServer, piReal, resetStorage, type Endpoint } from "./helpers.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

afterAll(() => handle.close());
beforeEach(resetStorage);

/** The hand-made fixtures are stamped 2026-11-09T14:00Z; never let them count as "future". */
const FIXTURE_NOW = Date.parse("2026-11-09T14:05:00Z");

function post(key: string, endpoint: Endpoint, body: unknown, opts: { now?: () => number; log?: (l: string) => void } = {}) {
  return makeApp({ log: opts.log ?? (() => {}), now: opts.now ?? (() => Math.max(Date.now(), FIXTURE_NOW)) }).request(`/v1/ingest/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

/** Shifts every sample ts so the newest is ~1 min ago (fixtures are dated; plan raw retention would drop them). */
function shiftToNow(bodies: Json[]): Json[] {
  const all = bodies.flatMap((b) => b.payload.samples.map((s: Json) => Date.parse(s.ts)));
  const delta = Date.now() - 60_000 - Math.max(...all);
  return bodies.map((b) => {
    const c = structuredClone(b);
    for (const s of c.payload.samples) s.ts = new Date(Date.parse(s.ts) + delta).toISOString();
    return c;
  });
}

const q = async <T = Json>(query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as T[];
const count = async (table: string, serverId: string) =>
  Number((await q<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)} where server_id = ${serverId}`))[0]!.n);

describe("hello", () => {
  it("stores info history only when the normalised info changes, and the plugin inventory", async () => {
    const s = await makeServer();
    const [hello] = piReal("hello") as Json[];
    expect((await post(s.key, "hello", hello)).status).toBe(200);
    expect((await post(s.key, "hello", hello)).status).toBe(200);
    expect(await count("server_info_history", s.serverId)).toBe(1);
    expect(await count("plugin_inventory_history", s.serverId)).toBe(hello!.payload.plugins.length);
    const [srv] = await q(sql`select boot_id, last_seen_at from servers where id = ${s.serverId}`);
    expect(srv!.boot_id).toBe(hello!.bootId);
    expect(srv!.last_seen_at).not.toBeNull();

    // Plugin order doesn't matter; a new plugin and a changed view distance do.
    const changed = structuredClone(hello!);
    changed.payload.plugins.push({ name: "spark", version: "1.10.142", enabled: true });
    changed.payload.config.viewDistance = 12;
    changed.payload.plugins.reverse();
    expect((await post(s.key, "hello", changed)).status).toBe(200);
    const rows = await q(sql`select valid_from, valid_to, info from server_info_history where server_id = ${s.serverId} order by id`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.valid_to).not.toBeNull();
    expect(rows[1]!.valid_to).toBeNull();
    expect(rows[1]!.info.config.viewDistance).toBe(12);
    expect(await count("plugin_inventory_history", s.serverId)).toBe(hello!.payload.plugins.length + 1);
  });
});

describe("hello: JVM flags are scrubbed server-side", () => {
  it("keeps heap/GC/log flags and allow-listed -D values, masks other -D values, home paths, IPs, userinfo", async () => {
    const s = await makeServer();
    const [hello] = piReal("hello") as Json[];
    const body = structuredClone(hello!);
    body.payload.jvm.flags = [
      "-Xms4G",
      "-Xmx4G",
      "-Xss1M",
      "-XX:+UseG1GC",
      "-XX:MaxGCPauseMillis=200",
      "-XX:HeapDumpPath=/home/bob/dumps",
      "-Xlog:gc*:file=/Users/alice/logs/gc.log",
      "-Dusing.aikars.flags=https://mcflags.emc.gs",
      "-Dfile.encoding=UTF-8",
      "-Ddb.url=jdbc:mysql://root:hunter2@10.0.0.5/mc",
      "-Dmy.webhook=https://discord.com/api/webhooks/1/abc",
      "-Dnovalue",
      "-javaagent:C:\\Users\\bob\\agent.jar",
      "-Dproxy=http://u:p@192.168.1.2:3128",
    ];
    expect((await post(s.key, "hello", body)).status).toBe(200);
    const [row] = await q(sql`select info from server_info_history where server_id = ${s.serverId}`);
    expect(row!.info.jvm.flags).toEqual([
      "-Xms4G",
      "-Xmx4G",
      "-Xss1M",
      "-XX:+UseG1GC",
      "-XX:MaxGCPauseMillis=200",
      "-XX:HeapDumpPath=/home/~/dumps",
      "-Xlog:gc*:file=/Users/~/logs/gc.log",
      "-Dusing.aikars.flags=https://mcflags.emc.gs",
      "-Dfile.encoding=UTF-8",
      "-Ddb.url=***",
      "-Dmy.webhook=***",
      "-Dnovalue",
      "-javaagent:C:\\Users\\~\\agent.jar",
      "-Dproxy=***",
    ]);
    const raw = JSON.stringify(row!.info);
    for (const leak of ["hunter2", "bob", "alice", "10.0.0.5", "192.168.1.2", "webhooks/1/abc"]) expect(raw).not.toContain(leak);
  });

  it("scrubJvmFlag also scrubs allow-listed values and -XX values", () => {
    expect(scrubJvmFlag("-Dusing.aikars.flags=https://u:p@mcflags.emc.gs")).toBe("-Dusing.aikars.flags=https://***@mcflags.emc.gs");
    expect(scrubJvmFlag("-XX:ErrorFile=/home/carol/hs_err.log")).toBe("-XX:ErrorFile=/home/~/hs_err.log");
    expect(scrubJvmFlag("-Xmx6G")).toBe("-Xmx6G");
  });
});

describe("metrics", () => {
  it("stores the real Pi payloads, one row per sample, idempotent on re-send", async () => {
    const s = await makeServer({ plan: "network" });
    const bodies = shiftToNow(piReal("metrics") as Json[]);
    const total = bodies.reduce((n, b) => n + b.payload.samples.length, 0);
    for (const b of bodies) expect((await post(s.key, "metrics", b)).status).toBe(200);
    expect(await count("metric_samples", s.serverId)).toBe(total);
    for (const b of bodies.slice(0, 5)) expect((await post(s.key, "metrics", b)).status).toBe(200);
    expect(await count("metric_samples", s.serverId)).toBe(total);

    const first = bodies[0]!.payload.samples[0];
    const [row] = await q(sql`select * from metric_samples where server_id = ${s.serverId} and ts = ${first.ts}`);
    expect(row!.tps_1m).toBe(first.tick.tps1m);
    expect(row!.mspt_p95).toBe(first.tick.msptP95);
    expect(row!.players).toBe(0);
    expect(row!.ping_avg).toBeNull(); // no pings → no average
    expect(row!.loaded_chunks).toBe(0);
    expect(row!.entities).toBe(0);
    expect(Number(row!.heap_used_bytes)).toBe(first.jvm.heapUsedBytes);
    expect(row!.cpu_temp_c).toBe(first.host.cpuTempC);
    expect(row!.host_cpu).toBe(first.host.cpuUsage);
    expect(Number(row!.disk_used_bytes)).toBe(first.host.diskUsedBytes);
    expect(row!.agent_ms_per_tick).toBe(first.agentOverhead.mainThreadMsPerTick);
    expect(row!.detail.world).toHaveLength(first.world.length);
    expect(row!.detail.jvm.gcPauses).toHaveLength(first.jvm.gcPauses.length);
    expect(row!.detail.host.memTotalBytes).toBe(first.host.memTotalBytes);
    expect(row!.detail.host.cpuTempC).toBeUndefined(); // hot columns aren't duplicated
    expect(row!.detail.players).toBeUndefined();
  });

  it("maps a busy sample to hot columns (sums over worlds, ping_avg, gc sum) and NULLs missing host values", async () => {
    const s = await makeServer();
    const [body] = shiftToNow([fixture("metrics")]);
    delete body!.payload.samples[1].host;
    expect((await post(s.key, "metrics", body)).status).toBe(200);
    const rows = await q(sql`select * from metric_samples where server_id = ${s.serverId} order by ts`);
    expect(rows).toHaveLength(2);
    const r = rows[0]!;
    expect(r.players).toBe(2);
    expect(r.ping_avg).toBe(75); // (38 + 112) / 2
    expect(r.entities).toBe(412 + 37);
    expect(r.loaded_chunks).toBe(1156 + 121);
    expect(r.tile_entities).toBe(140 + 88 + 17);
    expect(r.chunk_gen_per_min).toBe(3); // only "world" reports it
    expect(r.gc_pause_ms).toBe(18.5);
    expect(r.slow_ticks).toBe(1);
    expect(r.process_cpu).toBe(0.31);
    expect(r.detail.worstChunks).toHaveLength(2);
    expect(r.detail.host.throttled).toEqual({ now: false, sinceBoot: false, raw: "0x0" });
    const r2 = rows[1]!;
    for (const col of ["host_cpu", "cpu_temp_c", "mem_available_bytes", "swap_used_bytes", "disk_used_bytes"]) {
      expect(r2[col]).toBeNull();
    }
    expect(r2.detail.host).toBeUndefined();
  });

  it("drops samples older than the plan's raw retention", async () => {
    const s = await makeServer({ plan: "free" }); // raw 1 day
    const body = fixture("metrics");
    body.payload.samples[0].ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
    body.payload.samples[1].ts = new Date(Date.now() - 60_000).toISOString();
    expect((await post(s.key, "metrics", body)).status).toBe(200);
    expect(await count("metric_samples", s.serverId)).toBe(1);
  });
});

describe("events", () => {
  it("stores the real Pi events and dedupes re-sends", async () => {
    const s = await makeServer();
    const bodies = piReal("events") as Json[];
    const total = bodies.reduce((n, b) => n + b.payload.events.length, 0);
    for (const b of bodies) expect((await post(s.key, "events", b)).status).toBe(200);
    for (const b of bodies) expect((await post(s.key, "events", b)).status).toBe(200);
    expect(await count("events", s.serverId)).toBe(total);
    const types = (await q(sql`select type from events where server_id = ${s.serverId} order by ts`)).map((r) => r.type);
    expect(types).toContain("plugins_changed");
  });

  it("keeps only playerCount from join/leave", async () => {
    const s = await makeServer();
    expect((await post(s.key, "events", fixture("events"))).status).toBe(200);
    const joins = await q(sql`select data from events where server_id = ${s.serverId} and type = 'player_join' order by ts`);
    expect(joins.map((j) => j.data)).toEqual([{ playerCount: 1 }, { playerCount: 2 }]);
  });
});

describe("snapshot", () => {
  it("stores the real Pi snapshot with incident_id NULL, idempotent per captured_at", async () => {
    const s = await makeServer();
    const [snap] = piReal("snapshot") as Json[];
    expect((await post(s.key, "snapshot", snap)).status).toBe(200);
    expect((await post(s.key, "snapshot", snap)).status).toBe(200); // fresh app → fresh limiter; deduped by captured_at
    const rows = await q(sql`select * from incident_snapshots where server_id = ${s.serverId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.incident_id).toBeNull();
    expect(rows[0]!.trigger).toBe("requested");
    expect(new Date(rows[0]!.captured_at).toISOString()).toBe(snap!.payload.ts);
    expect(rows[0]!.snapshot.worldsDetail).toBeDefined();
  });
});

describe("player data minimisation", () => {
  it("stores no player id anywhere in the database", async () => {
    const s = await makeServer();
    const ids = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) ids.add(v);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    const bodies = { metrics: shiftToNow([fixture("metrics")])[0], events: fixture("events"), snapshot: fixture("snapshot") };
    for (const b of Object.values(bodies)) collect(b);
    expect(ids.size).toBeGreaterThanOrEqual(2);

    for (const [ep, b] of Object.entries(bodies)) expect((await post(s.key, ep as Endpoint, b)).status).toBe(200);
    const [snapRow] = await q(sql`select snapshot from incident_snapshots where server_id = ${s.serverId}`);
    expect(snapRow!.snapshot.sample.players).toEqual({ count: 2, pingAvg: 72.5 });

    // Dump every table in the public schema as text and grep.
    const tables = await q<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public'`);
    let dump = "";
    for (const { t } of tables) {
      const rows = await q<{ r: string }>(sql`select x::text as r from ${sql.identifier(t)} x`);
      dump += rows.map((r) => r.r).join("\n");
    }
    expect(dump.length).toBeGreaterThan(1000);
    for (const id of ids) expect(dump).not.toContain(id);
    expect(dump).not.toContain("playerId");
    expect(dump).not.toContain("pings");
  });
});

describe("future timestamps (> now + 10 min) are dropped, request still 200", () => {
  const NOW = Date.parse("2026-11-09T12:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = () => NOW;

  it("metrics: keeps the valid samples, counts + logs the future ones", async () => {
    const s = await makeServer();
    const body = structuredClone(fixture("metrics")) as Json;
    const base = body.payload.samples[0];
    body.payload.samples = [
      { ...structuredClone(base), ts: iso(NOW - 60_000) },
      { ...structuredClone(base), ts: iso(NOW + 9 * 60_000) }, // within tolerance
      { ...structuredClone(base), ts: iso(NOW + 11 * 60_000) },
      { ...structuredClone(base), ts: iso(NOW + 86_400_000) },
    ];
    const logs: string[] = [];
    expect((await post(s.key, "metrics", body, { now, log: (l) => logs.push(l) })).status).toBe(200);
    expect(await count("metric_samples", s.serverId)).toBe(2);
    expect(logs.join("\n")).toContain("future=2");

    // Everything in the future: still 200 (retrying can't fix the agent's clock), nothing stored.
    body.payload.samples = [{ ...structuredClone(base), ts: iso(NOW + 3_600_000) }];
    expect((await post(s.key, "metrics", body, { now })).status).toBe(200);
    expect(await count("metric_samples", s.serverId)).toBe(2);
  });

  it("events: drops future events, stores the rest; all-future is still 200", async () => {
    const s = await makeServer();
    const body = structuredClone(fixture("events")) as Json;
    body.payload.events = [
      { type: "server_start", ts: iso(NOW - 1000), uncleanPreviousShutdown: false },
      { type: "cant_keep_up", ts: iso(NOW + 20 * 60_000), behindMs: 2000, ticksSkipped: 40 },
    ];
    const logs: string[] = [];
    expect((await post(s.key, "events", body, { now, log: (l) => logs.push(l) })).status).toBe(200);
    expect(await count("events", s.serverId)).toBe(1);
    expect(logs.join("\n")).toContain("future=1");
    body.payload.events = [body.payload.events[1]];
    expect((await post(s.key, "events", body, { now })).status).toBe(200);
    expect(await count("events", s.serverId)).toBe(1);
  });

  it("snapshot: a future snapshot is not stored but answered 200", async () => {
    const s = await makeServer();
    const body = structuredClone(fixture("snapshot")) as Json;
    body.payload.ts = iso(NOW + 15 * 60_000);
    expect((await post(s.key, "snapshot", body, { now })).status).toBe(200);
    expect(await count("incident_snapshots", s.serverId)).toBe(0);
    body.payload.ts = iso(NOW - 1000);
    expect((await post(s.key, "snapshot", body, { now })).status).toBe(200);
    expect(await count("incident_snapshots", s.serverId)).toBe(1);
  });
});

describe("too-old cutoff is rounded up to the next full hour", () => {
  it("drops a sample older than (now - raw retention) ceiled to the hour", async () => {
    const s = await makeServer({ plan: "free" }); // raw retention 1 day
    const NOW = Date.parse("2026-11-09T12:20:00Z");
    const cutoff = Date.parse("2026-11-08T13:00:00Z"); // now - 1 d = 12:20 → ceiled to 13:00
    const body = structuredClone(fixture("metrics")) as Json;
    const base = body.payload.samples[0];
    body.payload.samples = [
      { ...structuredClone(base), ts: new Date(cutoff - 10_000).toISOString() }, // inside the 1 d window, but before the hour
      { ...structuredClone(base), ts: new Date(cutoff).toISOString() },
    ];
    const logs: string[] = [];
    expect((await post(s.key, "metrics", body, { now: () => NOW, log: (l) => logs.push(l) })).status).toBe(200);
    const rows = await q(sql`select ts from metric_samples where server_id = ${s.serverId}`);
    expect(rows.map((r) => new Date(r.ts).getTime())).toEqual([cutoff]);
    expect(logs.join("\n")).toContain("tooOld=1");
  });
});

describe("GDPR scrubbing of free text", () => {
  const UUID = "069a79f9-44e9-4726-a5be-fca90e38aaf5";

  it("scrubText replaces uuids, IPs and standalone 32/64-hex", () => {
    expect(scrubText(`Player Steve (${UUID}) lost connection from /1.2.3.4:5555`)).toBe(
      "Player Steve (<uuid>) lost connection from /<ip>:5555",
    );
    expect(scrubText("id 069a79f944e94726a5befca90e38aaf5 ok")).toBe("id <uuid> ok"); // undashed v4
    expect(scrubText(`hash ${"ab".repeat(32)} and ${"0f".repeat(16)}`)).toBe("hash <hex> and <hex>");
    expect(scrubText("from [2001:db8::1]:25565 and fe80::1ff:fe23:4567:890a%eth0")).toBe("from [<ip>]:25565 and <ip>%eth0");
    expect(scrubText("full 2001:0db8:85a3:0000:0000:8a2e:0370:7334 / mapped ::ffff:10.0.0.7")).toBe("full <ip> / mapped <ip>");
    expect(scrubText("10.0.0.255 and 192.168.1.20")).toBe("<ip> and <ip>");
    // Things that must survive.
    const keep = [
      "at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:1234)",
      "[12:34:56] Can't keep up!",
      "Foo::bar Cache::add",
      "Paper 1.21.4 build 232, java 21.0.5",
      "stackHash deadbeef",
      "0x" + "ab".repeat(16),
    ];
    for (const k of keep) expect(scrubText(k)).toBe(k);
  });

  it("scrubText redacts home-folder names, URL userinfo and secret key=value pairs", () => {
    expect(scrubText("Could not open /home/bob/server/world/level.dat")).toBe("Could not open /home/~/server/world/level.dat");
    expect(scrubText("at /Users/alice.smith/mc/plugins/X.jar")).toBe("at /Users/~/mc/plugins/X.jar");
    expect(scrubText("file C:\\Users\\Bob Smith\\mc\\paper.jar")).toBe("file C:\\Users\\~\\mc\\paper.jar");
    expect(scrubText("file C:\\Users\\bob\\mc and c:/Users/eve/x")).toBe("file C:\\Users\\~\\mc and c:/Users/~/x");
    expect(scrubText("connect jdbc:mysql://root:hunter2@db.example.com:3306/mc failed")).toBe(
      "connect jdbc:mysql://***@db.example.com:3306/mc failed",
    );
    expect(scrubText("proxy http://user@proxy.local:8080")).toBe("proxy http://***@proxy.local:8080");
    expect(scrubText("auth failed password=hunter2 for x")).toBe("auth failed password=*** for x");
    expect(scrubText("Token: abc.def; DB_PASSWORD = s3cr3t api_key=XYZ secret:shh pwd=1")).toBe(
      "Token=***; DB_PASSWORD=*** api_key=*** secret=*** pwd=***",
    );
    // Lookalikes that must survive.
    for (const k of ["bypass: true", "monkey=1", "Missing keys for chunk", "https://papermc.io/downloads", "/opt/minecraft/server"]) {
      expect(scrubText(k)).toBe(k);
    }
  });

  it("scrubText: camelCase keys, JSON key/value pairs, Authorization / Bearer tokens and td_ agent keys", () => {
    expect(scrubText("cfg apiKey: abc123 dbPassword=hunter2 authToken: y.z")).toBe("cfg apiKey=*** dbPassword=*** authToken=***");
    expect(scrubText('body {"password":"hunter2","user":"x"}')).toBe('body {"password": "***","user":"x"}');
    expect(scrubText("{ 'token': 'abc def', \"secret\" : \"s\" }")).toBe("{ 'token': \"***\", \"secret\": \"***\" }");
    expect(scrubText("Authorization: Bearer eyJhbGciOi.payload.sig rest")).toBe("Authorization: *** rest");
    expect(scrubText('"authorization": "Basic dXNlcjpwYXNz"')).toBe('"authorization": "***"');
    expect(scrubText("sent Bearer abc.DEF-123_~+/= to host")).toBe("sent Bearer *** to host");
    expect(scrubText("key td_live_AbCdEf0123456789 and td_test_xyz")).toBe("key td_live_*** and td_test_***");
    for (const k of ["bypass: true", "monkey=1", "monkey: 2", "Missing keys for chunk", "Keyboard: ok", "the token bucket"]) {
      expect(scrubText(k)).toBe(k);
    }
  });

  it("scrubs events (before hashing) and snapshot thread names / recent events", async () => {
    const s = await makeServer();
    const msg = `Player Steve (${UUID}) lost connection from /1.2.3.4:5555`;
    const evs = {
      ...fixture("events"),
      payload: {
        events: [
          { type: "exception", ts: "2026-11-09T14:00:01.000Z", exceptionClass: "java.io.IOException", message: msg, stackHash: "abc", topFrames: [`at x.Y.z(${UUID})`, "at a.B.c(B.java:10)"], count: 1 },
          { type: "crash", ts: "2026-11-09T14:00:02.000Z", detail: `crash near 2001:db8::7 key ${"c".repeat(64)}` },
          { type: "server_stop", ts: "2026-11-09T14:00:03.000Z", reason: "kicked 10.1.2.3" },
        ],
      },
    };
    expect((await post(s.key, "events", evs)).status).toBe(200);
    const rows = await q(sql`select type, data from events where server_id = ${s.serverId} order by ts`);
    expect(rows[0]!.data.message).toBe("Player Steve (<uuid>) lost connection from /<ip>:5555");
    expect(rows[0]!.data.topFrames).toEqual(["at x.Y.z(<uuid>)", "at a.B.c(B.java:10)"]);
    expect(rows[1]!.data.detail).toBe("crash near <ip> key <hex>");
    expect(rows[2]!.data.reason).toBe("kicked <ip>");
    // Two messages that differ only in the scrubbed part hash (and dedupe) the same.
    const again = structuredClone(evs);
    again.payload.events = [{ ...evs.payload.events[0]!, message: msg.replace("1.2.3.4", "5.6.7.8") }];
    await post(s.key, "events", again);
    expect(await count("events", s.serverId)).toBe(3);

    const snap = structuredClone(fixture("snapshot")) as Json;
    snap.payload.threads = [{ name: `Netty Epoll #3 /9.8.7.6`, state: "RUNNABLE" }, { name: "Server thread", state: "RUNNABLE" }];
    snap.payload.recentEvents = [evs.payload.events[0]];
    expect((await post(s.key, "snapshot", snap)).status).toBe(200);
    const [row] = await q(sql`select snapshot::text as t, snapshot from incident_snapshots where server_id = ${s.serverId}`);
    expect(row!.snapshot.threads.map((t: Json) => t.name)).toEqual(["Netty Epoll #3 /<ip>", "Server thread"]);
    expect(row!.snapshot.recentEvents[0].message).toBe("Player Steve (<uuid>) lost connection from /<ip>:5555");
    expect(row!.t).not.toContain(UUID);
    expect(row!.t).not.toContain("1.2.3.4");
  });
});
