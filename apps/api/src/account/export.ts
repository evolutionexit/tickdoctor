import type postgres from "postgres";
import type { Db } from "../db/client.js";
import { effectivePlanId, retentionFor, storedPlanId } from "../limits.js";

// GET /api/account/export (contract app-phase8.ts): everything we hold about a user and their servers, as ONE JSON
// document produced lazily, batch by batch, as the consumer reads (pull-based ReadableStream → real backpressure; the
// whole file never exists in memory). One reserved connection in a REPEATABLE READ READ ONLY transaction, so the file
// is a consistent snapshot. Postgres renders each row as JSON text (to_jsonb), with secrets left out by column:
// never password / session / token / API-key hashes, never alert_configs.webhook_enc (only the masked form).

export const EXPORT_SCHEMA_VERSION = 1;
/** Rows per cursor batch for the big per-server tables (samples, rollups, events). */
export const EXPORT_BATCH_ROWS = 500;
/** Snapshots are large JSON documents: smaller batches. */
const SNAPSHOT_BATCH_ROWS = 20;

/** At most this many exports run at once across the process (each holds one pooled connection); more → 429. */
export const MAX_CONCURRENT_EXPORTS = 2;
/** An export stream is aborted (transaction rolled back, connection released) after this long. */
export const EXPORT_MAX_DURATION_MS = 5 * 60_000;
/** Per statement on the export connection. */
export const EXPORT_STATEMENT_TIMEOUT_MS = 60_000;
/** A client that stops reading leaves the transaction idle: Postgres ends the session after this long. */
export const EXPORT_IDLE_IN_TX_TIMEOUT_MS = 60_000;

/**
 * Process-wide counter of running exports: at most `max` at once, and one per user (so one user can't take every
 * slot). tryAcquire → a release function (idempotent), "busy" when all slots are taken, "user_busy" when this
 * user already has an export running.
 */
export class ExportSlots {
  private readonly users = new Set<string>();
  constructor(readonly max: number = MAX_CONCURRENT_EXPORTS) {}
  get inUse(): number {
    return this.users.size;
  }
  tryAcquire(userId: string): (() => void) | "busy" | "user_busy" {
    if (this.users.has(userId)) return "user_busy";
    if (this.users.size >= this.max) return "busy";
    this.users.add(userId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users.delete(userId);
    };
  }
}

export interface ExportOptions {
  now: number;
  batchRows?: number;
  /** Test hook: called with the number of rows each cursor batch fetched. */
  onBatch?: (table: string, rows: number) => void;
  /** Overrides for tests (defaults: the EXPORT_* constants). */
  maxDurationMs?: number;
  statementTimeoutMs?: number;
  idleInTxTimeoutMs?: number;
  /** The request's abort signal: a client that disconnects stops the export at once. */
  signal?: AbortSignal;
  /** Called exactly once, after the export connection was released (finished, cancelled, aborted or failed). */
  onClose?: () => void;
}

type Reserved = postgres.ReservedSql;
type JRow = { j: string };

const json = (v: unknown) => JSON.stringify(v);

/** Async generator of JSON text pieces. Releases its connection when finished OR when the consumer cancels. */
export async function* exportChunks(db: Db, userId: string, opts: ExportOptions): AsyncGenerator<string> {
  const batch = Math.max(1, Math.floor(opts.batchRows ?? EXPORT_BATCH_ROWS));
  const conn: Reserved = await db.$client.reserve();
  let open = false;
  try {
    await conn`begin isolation level repeatable read read only`;
    open = true;
    // Bounded: per statement, idle between reads (a stalled client), and the whole transaction (PG17) a bit
    // after the stream's own deadline as a backstop.
    const maxMs = opts.maxDurationMs ?? EXPORT_MAX_DURATION_MS;
    await conn`select set_config('statement_timeout', ${String(opts.statementTimeoutMs ?? EXPORT_STATEMENT_TIMEOUT_MS)}, true),
                      set_config('idle_in_transaction_session_timeout', ${String(opts.idleInTxTimeoutMs ?? EXPORT_IDLE_IN_TX_TIMEOUT_MS)}, true),
                      set_config('transaction_timeout', ${String(maxMs + 10_000)}, true)`;

    const [u] = await conn<
      {
        email: string;
        display_name: string | null;
        created_at: Date;
        email_verified_at: Date | null;
        consent_at: Date | null;
        last_signup_at: Date | null;
        plan: string;
        has_password: boolean;
        discord_user_id: string | null;
      }[]
    >`select u.email, u.display_name, u.created_at, u.email_verified_at, u.consent_at, u.last_signup_at, u.plan,
             (u.password_hash is not null) as has_password,
             (select o.provider_user_id from oauth_accounts o where o.user_id = u.id and o.provider = 'discord') as discord_user_id
        from users u where u.id = ${userId}`;
    if (!u) throw new Error("export: user not found");
    const isoOrNull = (d: Date | null) => (d ? new Date(d).toISOString() : null);

    yield `{"exportedAt":${json(new Date(opts.now).toISOString())},"schemaVersion":${EXPORT_SCHEMA_VERSION},"account":`;
    yield json({
      email: u.email,
      displayName: u.display_name,
      createdAt: new Date(u.created_at).toISOString(),
      emailVerifiedAt: isoOrNull(u.email_verified_at),
      consentAt: isoOrNull(u.consent_at),
      lastSignupAt: isoOrNull(u.last_signup_at),
      plan: storedPlanId(u.plan),
      effectivePlan: effectivePlanId(u.plan),
      hasPassword: u.has_password,
      discord: { linked: u.discord_user_id !== null, discordUserId: u.discord_user_id },
    }).slice(0, -1); // reopen the object to append sessions
    yield `,"sessions":`;
    yield* array(conn<JRow[]>`
      select jsonb_build_object('createdAt', created_at, 'lastUsedAt', last_used_at, 'expiresAt', expires_at)::text as j
        from sessions where user_id = ${userId} order by created_at`, "sessions", batch, opts);
    yield `},"waitlist":`;
    yield* array(conn<JRow[]>`
      select jsonb_build_object('email', email, 'source', source, 'createdAt', created_at)::text as j
        from waitlist where email = lower(${u.email}) order by created_at`, "waitlist", batch, opts);
    // Pending "confirm your Discord sign-up" rows for the same email (never the token hash).
    yield `,"discordPendingSignups":`;
    yield* array(conn<JRow[]>`
      select jsonb_build_object('email', email, 'discordUserId', discord_user_id, 'createdAt', created_at,
               'expiresAt', expires_at, 'usedAt', used_at)::text as j
        from discord_pending_signups where email = lower(${u.email}) order by created_at`, "discord_pending_signups", batch, opts);

    yield `,"servers":[`;
    const servers = await conn<{ id: string; plan: string; j: string }[]>`
      select id, plan, jsonb_build_object('id', id, 'name', name, 'slug', slug, 'plan', plan, 'createdAt', created_at,
               'lastSeenAt', last_seen_at, 'firstHelloAt', first_hello_at, 'firstSampleAt', first_sample_at,
               'lastSampleAt', last_sample_at)::text as j
        from servers where owner_id = ${userId} order by created_at, id`;
    for (const [i, s] of servers.entries()) {
      if (i > 0) yield ",";
      yield s.j.slice(0, -1); // open the server object, sections appended below
      const id = s.id;
      const section = (name: string) => `,${json(name)}:`;

      yield section("apiKeys");
      yield* array(conn<JRow[]>`
        select jsonb_build_object('prefix', prefix, 'createdAt', created_at, 'revokedAt', revoked_at)::text as j
          from api_keys where server_id = ${id} order by created_at`, "api_keys", batch, opts);
      yield section("infoHistory");
      yield* array(conn<JRow[]>`
        select jsonb_build_object('validFrom', valid_from, 'validTo', valid_to, 'info', info)::text as j
          from server_info_history where server_id = ${id} order by valid_from`, "server_info_history", batch, opts);
      yield section("pluginInventory");
      yield* array(conn<JRow[]>`
        select jsonb_build_object('plugin', plugin, 'version', version, 'firstSeen', first_seen, 'lastSeen', last_seen)::text as j
          from plugin_inventory_history where server_id = ${id} order by plugin, first_seen`, "plugin_inventory_history", batch, opts);
      yield section("statusPage");
      yield await one(conn<JRow[]>`select (to_jsonb(p) - 'server_id')::text as j from status_pages p where server_id = ${id}`);
      yield section("alertConfig");
      // webhook_enc (the encrypted URL) is never exported; webhook_masked is what the owner sees in the app.
      yield await one(conn<JRow[]>`select (to_jsonb(a) - 'server_id' - 'webhook_enc')::text as j from alert_configs a where server_id = ${id}`);
      yield section("alertDeliveries");
      yield* array(conn<JRow[]>`
        select (to_jsonb(d) - 'server_id')::text as j from alert_deliveries d where server_id = ${id} order by created_at`,
        "alert_deliveries", batch, opts);
      yield section("analysisState");
      yield await one(conn<JRow[]>`select (to_jsonb(a) - 'server_id')::text as j from server_analysis_state a where server_id = ${id}`);
      yield section("incidents");
      yield* array(conn<JRow[]>`
        select (to_jsonb(i) - 'server_id')::text as j from incidents i where server_id = ${id} order by started_at`,
        "incidents", batch, opts);
      yield section("findings");
      yield* array(conn<JRow[]>`
        select ((to_jsonb(f) - 'server_id') || jsonb_build_object('incidentIds',
                 coalesce((select jsonb_agg(fi.incident_id order by fi.incident_id) from finding_incidents fi where fi.finding_id = f.id), '[]'::jsonb)))::text as j
          from findings f where server_id = ${id} order by first_seen_at`, "findings", batch, opts);
      yield section("events");
      yield* array(conn<JRow[]>`
        select (to_jsonb(e) - 'server_id' - 'event_hash')::text as j from events e where server_id = ${id} order by ts, id`,
        "events", batch, opts);
      yield section("snapshots");
      yield* array(conn<JRow[]>`
        select (to_jsonb(n) - 'server_id')::text as j from incident_snapshots n where server_id = ${id} order by captured_at`,
        "incident_snapshots", Math.min(batch, SNAPSHOT_BATCH_ROWS), opts);
      yield section("rollups1h");
      yield* array(conn<JRow[]>`
        select (to_jsonb(r) - 'server_id')::text as j from metric_rollups_1h r where server_id = ${id} order by bucket`,
        "metric_rollups_1h", batch, opts);
      yield section("rollups1m");
      yield* array(conn<JRow[]>`
        select (to_jsonb(r) - 'server_id')::text as j from metric_rollups_1m r where server_id = ${id} order by bucket`,
        "metric_rollups_1m", batch, opts);
      yield section("samples");
      const rawSince = new Date(opts.now - retentionFor(s.plan).raw * 86_400_000).toISOString();
      yield* array(conn<JRow[]>`
        select (to_jsonb(m) - 'server_id')::text as j from metric_samples m
         where server_id = ${id} and ts >= ${rawSince}::timestamptz order by ts`, "metric_samples", batch, opts);
      yield "}";
    }
    yield "]}\n";
    await conn`commit`;
    open = false;
  } finally {
    // Also runs when the consumer cancels (generator.return()): roll back and give the connection back.
    if (open) await conn`rollback`.catch(() => {});
    conn.release();
  }
}

async function one(q: postgres.PendingQuery<JRow[]>): Promise<string> {
  const [r] = await q;
  return r ? r.j : "null";
}

async function* array(q: postgres.PendingQuery<JRow[]>, table: string, batch: number, opts: ExportOptions): AsyncGenerator<string> {
  let first = true;
  yield "[";
  for await (const rows of q.cursor(batch)) {
    opts.onBatch?.(table, rows.length);
    let out = "";
    for (const r of rows) {
      out += first ? r.j : `,${r.j}`;
      first = false;
    }
    yield out;
  }
  yield "]";
}

/**
 * A pull-based byte stream over exportChunks: the next piece is produced only when the consumer reads.
 * Ends (rolls back, releases the connection, then calls onClose once) when finished, cancelled by the consumer
 * (the Node adapter cancels on client disconnect), on `signal` abort, on error, or after maxDurationMs.
 */
export function exportStream(db: Db, userId: string, opts: ExportOptions): ReadableStream<Uint8Array> {
  const gen = exportChunks(db, userId, opts);
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopped = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        await gen.return(undefined); // runs the generator's finally: rollback + release
      } catch {
        /* already failed: its finally ran */
      }
      opts.onClose?.();
    })());

  const abort = (err: Error) => {
    if (stopped) return;
    stopped = true;
    try {
      ctrl?.error(err);
    } catch {
      /* stream already closed */
    }
    void close();
  };
  const onAbort = () => abort(new Error("export aborted by the client"));
  const timer = setTimeout(() => abort(new Error("export took too long")), opts.maxDurationMs ?? EXPORT_MAX_DURATION_MS);
  timer.unref?.();
  if (opts.signal?.aborted) queueMicrotask(onAbort);
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        ctrl = controller;
      },
      async pull(controller) {
        try {
          for (;;) {
            if (stopped) return;
            const { value, done } = await gen.next();
            if (stopped) return;
            if (done) {
              controller.close();
              await close();
              return;
            }
            if (value.length > 0) {
              controller.enqueue(enc.encode(value));
              return;
            }
          }
        } catch (err) {
          if (!stopped) controller.error(err);
          await close();
        }
      },
      async cancel() {
        await close();
      },
    },
    { highWaterMark: 0 },
  );
}
