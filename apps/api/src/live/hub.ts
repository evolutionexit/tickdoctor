import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { MetricSample, liveSampleEvent, liveStatusEvent } from "@tickdoctor/shared";
import type { Exec } from "../db/query.js";
import { loadServerState, type ServerState } from "../health.js";

// In-process live bus (contract app.ts "Live"): the ingest route publishes stored samples, SSE streams subscribe
// per server. One API process; multi-instance would need LISTEN/NOTIFY (later).

export type LiveSampleEvent = z.infer<typeof liveSampleEvent>;
export type LiveStatusEvent = z.infer<typeof liveStatusEvent>;
export type LiveMessage = { event: "sample"; data: LiveSampleEvent } | { event: "status"; data: LiveStatusEvent };
export type LiveListener = (msg: LiveMessage) => void;

export const LIVE_CHECK_INTERVAL_MS = 15_000;
export const MAX_STREAMS_PER_USER = 5;

export function toLiveSample(s: MetricSample): LiveSampleEvent {
  const h = s.host ?? {};
  return {
    ts: new Date(s.ts).toISOString(),
    tps1m: s.tick.tps1m,
    msptAvg: s.tick.msptAvg,
    msptP95: s.tick.msptP95,
    players: s.players.count,
    hostCpu: h.cpuUsage ?? null,
    cpuTempC: h.cpuTempC ?? null,
    heapUsedBytes: s.jvm.heapUsedBytes,
    heapMaxBytes: s.jvm.heapMaxBytes,
    memAvailableBytes: h.memAvailableBytes ?? null,
    swapUsedBytes: h.swapUsedBytes ?? null,
  };
}

export function toLiveStatus(s: ServerState): LiveStatusEvent {
  return { health: s.health, lastSeenAt: s.lastSeenAt, openIncidentId: s.openIncidentId };
}

const statusKey = (s: LiveStatusEvent) => `${s.health}|${s.openIncidentId ?? ""}`;

/** One open stream. Status changes are tracked per subscriber, so a new viewer never resets another's baseline. */
export interface LiveSubscriber {
  serverId: string;
  /** null = dev admin bearer (no session). */
  userId: string | null;
  sessionIdHash: string | null;
  send: LiveListener;
  /** Ends the stream (used when the session or ownership is gone). */
  close: () => void;
  /** Last status key sent to THIS subscriber; undefined until its initial status was sent. */
  lastStatusKey?: string;
}

export class LiveHub {
  private readonly subs = new Map<string, Set<LiveSubscriber>>();
  private readonly streamsPerUser = new Map<string, number>();

  constructor(
    private readonly deps: { db: Exec; now: () => number; log?: (line: string) => void; maxStreamsPerUser?: number },
  ) {}

  /** Reserves a stream slot for the user; false when the user already has the maximum open. */
  acquireStream(userKey: string): boolean {
    const n = this.streamsPerUser.get(userKey) ?? 0;
    if (n >= (this.deps.maxStreamsPerUser ?? MAX_STREAMS_PER_USER)) return false;
    this.streamsPerUser.set(userKey, n + 1);
    return true;
  }

  releaseStream(userKey: string): void {
    const n = (this.streamsPerUser.get(userKey) ?? 1) - 1;
    if (n <= 0) this.streamsPerUser.delete(userKey);
    else this.streamsPerUser.set(userKey, n);
  }

  openStreams(userKey?: string): number {
    if (userKey !== undefined) return this.streamsPerUser.get(userKey) ?? 0;
    let n = 0;
    for (const v of this.streamsPerUser.values()) n += v;
    return n;
  }

  subscriberCount(serverId: string): number {
    return this.subs.get(serverId)?.size ?? 0;
  }

  subscribe(sub: LiveSubscriber): () => void {
    let set = this.subs.get(sub.serverId);
    if (!set) {
      set = new Set();
      this.subs.set(sub.serverId, set);
    }
    set.add(sub);
    return () => {
      const s = this.subs.get(sub.serverId);
      if (!s) return;
      s.delete(sub);
      if (s.size === 0) this.subs.delete(sub.serverId);
    };
  }

  /** Loads the current state for a new subscriber and makes it that subscriber's status baseline. */
  async initSubscriber(sub: LiveSubscriber): Promise<ServerState> {
    const state = await loadServerState(this.deps.db, sub.serverId, this.deps.now());
    sub.lastStatusKey = statusKey(toLiveStatus(state));
    return state;
  }

  private deliver(sub: LiveSubscriber, msg: LiveMessage) {
    try {
      sub.send(msg);
    } catch (err) {
      this.deps.log?.(`live listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Recomputes health; sends `status` to every initialised subscriber whose last status differs. */
  async refreshStatus(serverId: string): Promise<void> {
    if (!this.subs.has(serverId)) return;
    const status = toLiveStatus(await loadServerState(this.deps.db, serverId, this.deps.now()));
    const key = statusKey(status);
    for (const sub of this.subs.get(serverId) ?? []) {
      if (sub.lastStatusKey === undefined || sub.lastStatusKey === key) continue;
      sub.lastStatusKey = key;
      this.deliver(sub, { event: "status", data: status });
    }
  }

  /** Called by the ingest metrics route after the samples were stored (ts ascending). */
  async publishSamples(serverId: string, samples: MetricSample[]): Promise<void> {
    if (!this.subs.has(serverId) || samples.length === 0) return;
    const events = samples.map((s) => ({ event: "sample" as const, data: toLiveSample(s) }));
    for (const sub of this.subs.get(serverId) ?? []) for (const e of events) this.deliver(sub, e);
    await this.refreshStatus(serverId);
  }

  private closeWhere(pred: (s: LiveSubscriber) => boolean): number {
    let n = 0;
    for (const set of [...this.subs.values()]) {
      for (const sub of [...set]) {
        if (!pred(sub)) continue;
        n++;
        try {
          sub.close();
        } catch {
          /* already closed */
        }
      }
    }
    return n;
  }

  /** Logout-all / password reset / password change: end the user's streams (optionally keeping one session's). */
  closeUser(userId: string, exceptSessionIdHash?: string): number {
    return this.closeWhere((s) => s.userId === userId && (exceptSessionIdHash === undefined || s.sessionIdHash !== exceptSessionIdHash));
  }

  closeSession(sessionIdHash: string): number {
    return this.closeWhere((s) => s.sessionIdHash === sessionIdHash);
  }

  /** Server deleted: its streams end (they must not fall back to "waiting"). */
  closeServer(serverId: string): number {
    return this.closeWhere((s) => s.serverId === serverId);
  }

  /**
   * Re-validates every stream: the session must still be live and the server still owned by that user
   * (catches server:transfer from the CLI process and anything the immediate close calls missed).
   */
  async revalidate(): Promise<void> {
    const ids = [...this.subs.keys()];
    if (ids.length === 0) return;
    const now = new Date(this.deps.now()).toISOString();
    const owners = (await this.deps.db.execute(
      sql`select id, owner_id from servers where id = any(${`{${ids.join(",")}}`}::uuid[])`,
    )) as unknown as { id: string; owner_id: string }[];
    const ownerOf = new Map(owners.map((r) => [r.id, r.owner_id]));
    const hashes = [...new Set([...this.subs.values()].flatMap((set) => [...set].map((s) => s.sessionIdHash).filter((h): h is string => h !== null)))];
    const live = hashes.length
      ? ((await this.deps.db.execute(
          sql`select id_hash, user_id from sessions where id_hash = any(${`{${hashes.join(",")}}`}::text[]) and expires_at > ${now}::timestamptz`,
        )) as unknown as { id_hash: string; user_id: string }[])
      : [];
    const sessionUser = new Map(live.map((r) => [r.id_hash, r.user_id]));
    this.closeWhere((s) => {
      const owner = ownerOf.get(s.serverId);
      if (owner === undefined) return true;
      if (s.userId === null) return false; // dev admin: server exists is enough
      return owner !== s.userId || s.sessionIdHash === null || sessionUser.get(s.sessionIdHash) !== s.userId;
    });
  }

  /** Every LIVE_CHECK_INTERVAL_MS: re-validate streams, then catch offline transitions (no ingest when a server goes away). */
  async checkAll(): Promise<void> {
    try {
      await this.revalidate();
    } catch (err) {
      this.deps.log?.(`live revalidation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const id of [...this.subs.keys()]) {
      try {
        await this.refreshStatus(id);
      } catch (err) {
        this.deps.log?.(`live status check failed server=${id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  start(intervalMs = LIVE_CHECK_INTERVAL_MS): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.checkAll().finally(() => {
        running = false;
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
