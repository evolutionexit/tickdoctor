import { z } from "zod";

// Plugin → API ingest payloads. v1, frozen in Phase 2.
// Changes go through the lead and bump INGEST_SCHEMA_VERSION.
// The API validates with these schemas; the Java plugin's tests validate its JSON against
// the generated JSON Schema in docs/contracts/ingest.schema.json (`pnpm --filter @tickdoctor/shared gen:schema`).
// Every array has a max length so a broken or hostile agent can't send unbounded data.

export const INGEST_SCHEMA_VERSION = 1;

/** Largest value of a Postgres int4 column. */
export const INT4_MAX = 2_147_483_647;
/** Largest float accepted for a measurement (far above anything real, far below overflow in sums). */
export const FLOAT_MAX = 1e15;

/**
 * Removes control characters (C0 except \t \n \r, DEL, C1) and replaces lone UTF-16 surrogates with U+FFFD.
 * Postgres text/jsonb refuse NUL and lone surrogates; a stray one in an exception message must not get a whole
 * batch rejected, so the contract cleans strings instead of rejecting them.
 */
export function stripControl(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}
/** Free text / name: length-limited on the raw input, then cleaned with stripControl. */
const str = (max: number, min = 0) => (min > 0 ? z.string().min(min) : z.string()).max(max).transform(stripControl);

const isoTs = z.string().datetime({ offset: true }); // ISO-8601, UTC "Z" preferred
const nonNeg = z.number().finite().nonnegative().max(FLOAT_MAX);
/** Counts stored in int4 columns (or summed into them; the API clamps the sums). */
const nonNegInt = z.number().int().nonnegative().max(INT4_MAX);
/** Byte counts: bigint columns read back as JS numbers, so they must stay safe integers. */
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const coord = z.number().int().min(-INT4_MAX - 1).max(INT4_MAX);
const ratio = z.number().finite().min(0).max(1);
const shortStr = str(200, 1);
const countMap = z.record(str(100), nonNegInt).refine((m) => Object.keys(m).length <= 200, "max 200 keys");

// ---------- envelope ----------
export const envelope = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    schemaVersion: z.literal(INGEST_SCHEMA_VERSION),
    agentVersion: str(40), // plugin version, e.g. "0.1.0"
    sentAt: isoTs, // plugin clock
    bootId: z.string().uuid(), // random per server start
    payload,
  });

// ---------- POST /v1/ingest/hello ----------
export const helloPayload = z.object({
  server: z.object({
    software: shortStr, // "Paper"
    softwareVersion: shortStr, // "26.2-83-main@f9fb80b"
    minecraftVersion: str(40), // "26.2"
    onlineMode: z.boolean(),
    maxPlayers: nonNegInt,
  }),
  jvm: z.object({
    javaVersion: str(80),
    vendor: str(200),
    flags: z.array(str(1000)).max(200), // JVM input arguments (no -D values that look like secrets: agent redacts *password*, *token*, *secret*, *key*)
    heapMaxBytes: byteCount,
    heapInitBytes: byteCount,
    availableProcessors: nonNegInt,
  }),
  host: z.object({
    os: str(100),
    arch: str(50),
    model: str(200).optional(), // /proc/device-tree/model
    totalMemoryBytes: byteCount.optional(),
  }),
  config: z.object({
    viewDistance: nonNegInt,
    simulationDistance: nonNegInt,
    entityActivationRange: z.record(str(50), coord).optional(), // spigot.yml
    paperWorldDefaults: z.record(str(100), z.union([str(200), z.number().finite().min(-FLOAT_MAX).max(FLOAT_MAX), z.boolean()])).optional(), // allow-listed keys only
  }),
  worlds: z
    .array(z.object({ name: shortStr, environment: z.enum(["NORMAL", "NETHER", "THE_END", "CUSTOM"]) }))
    .max(100),
  plugins: z.array(z.object({ name: shortStr, version: str(100), enabled: z.boolean() })).max(500),
  privacyMode: z.enum(["hashed", "none"]),
});

// ---------- POST /v1/ingest/metrics ----------
export const hostSample = z.object({
  cpuLoad1m: nonNeg.optional(),
  cpuUsage: ratio.optional(), // /proc/stat delta, whole machine
  cpuTempC: z.number().finite().min(-50).max(150).optional(),
  throttled: z
    .object({ now: z.boolean(), sinceBoot: z.boolean(), raw: str(20).optional() })
    .optional(), // vcgencmd get_throttled
  memTotalBytes: byteCount.optional(),
  memAvailableBytes: byteCount.optional(),
  swapTotalBytes: byteCount.optional(),
  swapUsedBytes: byteCount.optional(),
  diskTotalBytes: byteCount.optional(), // filesystem holding the server dir
  diskUsedBytes: byteCount.optional(),
  diskReadBytesPerSec: nonNeg.optional(),
  diskWriteBytesPerSec: nonNeg.optional(),
  netRxBytesPerSec: nonNeg.optional(),
  netTxBytesPerSec: nonNeg.optional(),
});

export const worstChunk = z.object({
  world: shortStr,
  x: coord,
  z: coord,
  entities: nonNegInt,
  tileEntities: nonNegInt,
  topEntityType: str(100).optional(),
});

export const metricSample = z.object({
  ts: isoTs, // end of the sampling window
  windowSeconds: z.number().int().min(1).max(300), // usually 10
  tick: z.object({
    tps1m: nonNeg,
    tps5m: nonNeg,
    tps15m: nonNeg,
    msptAvg: nonNeg,
    msptP95: nonNeg,
    msptP99: nonNeg,
    msptMax: nonNeg,
    tickCount: nonNegInt, // ticks measured in this window
    slowTicks: z.array(z.object({ ts: isoTs, durationMs: nonNeg })).max(100), // ticks > 50 ms, capped
  }),
  jvm: z.object({
    heapUsedBytes: byteCount,
    heapCommittedBytes: byteCount,
    heapMaxBytes: byteCount,
    gcPauses: z
      .array(z.object({ collector: shortStr, count: nonNegInt, totalMs: nonNeg, maxMs: nonNeg }))
      .max(10), // per collector, during this window
    threadCount: nonNegInt,
    processCpuLoad: ratio,
  }),
  world: z
    .array(
      z.object({
        name: shortStr,
        loadedChunks: nonNegInt,
        entities: nonNegInt,
        entitiesByType: countMap, // top 20 types + "other"
        tileEntitiesByType: countMap, // hopper, furnace, chest, ...
        chunkGenPerMinute: nonNeg.optional(), // newly generated chunks
        countsAgeSeconds: nonNeg, // entity/chunk counts are gathered incrementally; how old they are
      }),
    )
    .max(100),
  worstChunks: z.array(worstChunk).max(10), // ranked by entities + tile entities, all worlds
  players: z.object({
    count: nonNegInt,
    pings: z.array(z.object({ id: z.string().length(64).optional(), pingMs: nonNegInt })).max(1000).optional(), // id is DEPRECATED (hex sha256(serverSalt + uuid), sent by agents < 0.1.5, ignored by the API); current agents send pingMs only
  }),
  host: hostSample.optional(),
  agentOverhead: z.object({
    mainThreadMsPerTick: nonNeg, // average main-thread time the agent itself used per tick
    mainThreadMsMax: nonNeg, // worst single tick
    asyncCpuMs: nonNeg, // agent's async CPU time in this window
  }),
});

export const metricsPayload = z.object({ samples: z.array(metricSample).min(1).max(60) });

// ---------- POST /v1/ingest/events ----------
const pluginRef = z.object({ name: shortStr, version: str(100) });
const playerId = z.string().length(64).optional(); // omitted in privacy mode "none"

export const agentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("server_start"), ts: isoTs, uncleanPreviousShutdown: z.boolean() }),
  z.object({ type: z.literal("server_stop"), ts: isoTs, reason: str(200).optional() }),
  z.object({ type: z.literal("crash"), ts: isoTs, detail: str(2000).optional() }), // reported on next start
  z.object({ type: z.literal("player_join"), ts: isoTs, playerId, playerCount: nonNegInt }),
  z.object({ type: z.literal("player_leave"), ts: isoTs, playerId, playerCount: nonNegInt }),
  z.object({ type: z.literal("cant_keep_up"), ts: isoTs, behindMs: nonNeg, ticksSkipped: nonNegInt }),
  z.object({
    type: z.literal("exception"),
    ts: isoTs,
    plugin: str(200).optional(), // best guess from the stack trace
    exceptionClass: str(300),
    message: str(500).optional(),
    stackHash: str(64), // groups repeats
    topFrames: z.array(str(300)).max(5).optional(),
    count: z.number().int().min(1).max(INT4_MAX), // repeats folded together within the batch
  }),
  z.object({
    type: z.literal("plugins_changed"),
    ts: isoTs,
    added: z.array(pluginRef).max(500),
    removed: z.array(pluginRef).max(500),
    updated: z.array(z.object({ name: shortStr, from: str(100), to: str(100) })).max(500),
  }),
]);

export const eventsPayload = z.object({ events: z.array(agentEvent).min(1).max(500) });

// ---------- POST /v1/ingest/snapshot ----------
export const snapshotPayload = z.object({
  trigger: z.enum(["threshold", "manual", "requested"]), // "requested" = API asked via response config
  ts: isoTs,
  msptP95AtTrigger: nonNeg,
  sample: metricSample, // fresh, full-pass counts (countsAgeSeconds small)
  worldsDetail: z
    .array(
      z.object({
        name: shortStr,
        entitiesByType: countMap, // all types
        tileEntitiesByType: countMap,
        topChunks: z
          .array(
            z.object({
              x: coord,
              z: coord,
              entities: nonNegInt,
              tileEntities: nonNegInt,
              byType: countMap,
            }),
          )
          .max(50),
      }),
    )
    .max(100),
  threads: z
    .array(z.object({ name: str(200), state: str(30), cpuMs: nonNeg.optional() }))
    .max(20)
    .optional(), // top by CPU, no stacks in v1
  recentEvents: z.array(agentEvent).max(500), // last 5 minutes
});

// ---------- full request bodies ----------
export const helloRequest = envelope(helloPayload);
export const metricsRequest = envelope(metricsPayload);
export const eventsRequest = envelope(eventsPayload);
export const snapshotRequest = envelope(snapshotPayload);

// ---------- responses ----------
export const ingestAccepted = z.object({
  ok: z.literal(true),
  /** Lets the API tune the agent without a plugin update. Agent applies values within safe bounds. */
  config: z
    .object({
      metricsIntervalSeconds: z.number().int().min(5).max(300).optional(),
      snapshotMsptThreshold: z.number().min(20).max(1000).optional(),
      requestSnapshot: z.boolean().optional(), // incident opened server-side → send a snapshot now
    })
    .optional(),
});
export const ingestRejected = z.object({
  ok: z.literal(false),
  error: z.enum(["invalid_key", "revoked_key", "invalid_payload", "rate_limited", "plan_limit", "payload_too_large"]),
  message: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export type HelloPayload = z.infer<typeof helloPayload>;
export type HostSample = z.infer<typeof hostSample>;
export type WorstChunk = z.infer<typeof worstChunk>;
export type MetricSample = z.infer<typeof metricSample>;
export type MetricsPayload = z.infer<typeof metricsPayload>;
export type AgentEvent = z.infer<typeof agentEvent>;
export type EventsPayload = z.infer<typeof eventsPayload>;
export type SnapshotPayload = z.infer<typeof snapshotPayload>;
export type IngestEnvelope<T> = { schemaVersion: number; agentVersion: string; sentAt: string; bootId: string; payload: T };
export type IngestAccepted = z.infer<typeof ingestAccepted>;
export type IngestRejected = z.infer<typeof ingestRejected>;
