import type { MiddlewareHandler } from "hono";
import { HttpError } from "../errors.js";
import type { ClientIpResolver } from "./client-ip.js";

/**
 * Storage-agnostic limiter interface so the in-memory implementation can later be swapped for a
 * Postgres/Redis-backed one without touching routes.
 */
export interface RateLimitStore {
  /** Records one hit for `key`. Returns 0 when allowed, otherwise seconds until the window resets. */
  hit(key: string, now: number): number;
}

interface Bucket {
  key: string;
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, in-memory limiter. Per process; fine for a single API instance.
 *
 * Every window has the same length and a bucket is queued when its window starts, so the FIFO
 * queue is ordered by resetAt: expired buckets always sit at the front. Sweeping pops from the front,
 * so it is O(1) amortised per hit. When the store is full of live buckets, new keys are rejected
 * (fail closed) instead of evicting live buckets.
 * (A plain Map is not enough: V8 leaves tombstones when deleting from the front, which makes
 * `keys().next()` O(deleted entries).)
 */
export class FixedWindowLimiter implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private queue: Bucket[] = [];
  private head = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Hard cap on tracked keys so memory stays bounded under key-spraying; new keys beyond it are rejected. */
    private readonly maxKeys: number = 10_000,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  hit(key: string, now: number): number {
    let b = this.buckets.get(key);
    if (b && b.resetAt <= now) {
      this.buckets.delete(key); // its queue entry becomes stale and is skipped later
      b = undefined;
    }
    if (!b) {
      this.sweep(now);
      // Still full of live buckets: fail closed for NEW keys. Evicting a live bucket would let an attacker
      // spray keys (IPs, emails) to flush a victim's bucket and reset its counter.
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.peekLive();
        return Math.max(1, Math.ceil(((oldest?.resetAt ?? now + this.windowMs) - now) / 1000));
      }
      b = { key, count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
      this.queue.push(b);
    }
    b.count++;
    if (b.count > this.limit) return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return 0;
  }

  /** Drops expired buckets from the front of the queue; stops at the first live one. */
  sweep(now: number): void {
    for (;;) {
      const front = this.peekLive();
      if (!front || front.resetAt > now) break;
      this.head++;
      this.buckets.delete(front.key);
    }
    this.compact();
  }

  /** Periodically frees expired buckets while idle. The timer is unref'd so it never keeps the process alive. */
  startSweeper(intervalMs: number, now: () => number = Date.now): () => void {
    const timer = setInterval(() => this.sweep(now()), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Front-most queue entry that is still the current bucket for its key (skips stale entries). */
  private peekLive(): Bucket | undefined {
    while (this.head < this.queue.length) {
      const e = this.queue[this.head]!;
      if (this.buckets.get(e.key) === e) return e;
      this.head++;
    }
    return undefined;
  }

  /** Reclaims the consumed prefix once it dominates the array (amortised O(1)). */
  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }
}

export interface RateLimitOptions {
  store: RateLimitStore;
  keyOf: ClientIpResolver;
  now?: () => number;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    const retryAfter = opts.store.hit(opts.keyOf(c), now());
    if (retryAfter > 0) throw rateLimited(retryAfter);
    await next();
  };
}

export function rateLimited(retryAfterSeconds: number): HttpError {
  return new HttpError(429, "rate_limited", "Too many requests, try again later", {
    "Retry-After": String(retryAfterSeconds),
  });
}
