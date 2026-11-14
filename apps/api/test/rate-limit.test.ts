import { describe, expect, it, vi } from "vitest";
import { FixedWindowLimiter } from "../src/middleware/rate-limit.js";
import { RollingWindowCap } from "../src/middleware/global-cap.js";

describe("FixedWindowLimiter", () => {
  it("never tracks more than maxKeys keys", () => {
    const l = new FixedWindowLimiter(5, 60_000, 100);
    for (let i = 0; i < 10_000; i++) l.hit(`ip-${i}`, 0);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it("drops expired windows to make room for new keys", () => {
    const l = new FixedWindowLimiter(1, 1000, 2);
    l.hit("old", 0);
    l.hit("live", 1500);
    l.hit("live", 1500); // over the limit
    l.hit("new", 1600); // "old" expired → evicted, "live" kept
    expect(l.hit("live", 1700)).toBeGreaterThan(0);
  });

  it("fails closed for new keys when full of live keys (never evicts a live bucket)", () => {
    const l = new FixedWindowLimiter(1, 10_000, 2);
    l.hit("a", 0);
    l.hit("a", 0);
    l.hit("b", 10);
    expect(l.hit("c", 20)).toBe(10); // rejected until "a" expires (Retry-After 10 s)
    expect(l.size).toBe(2);
    expect(l.hit("a", 30)).toBeGreaterThan(0); // victim's bucket NOT flushed: still limited
    expect(l.hit("b", 30)).toBeGreaterThan(0);
    expect(l.hit("c", 10_001)).toBe(0); // "a" expired and swept → room again
  });

  it("keeps a re-started window at the back so expiry order stays insertion order", () => {
    const l = new FixedWindowLimiter(5, 1000, 10);
    l.hit("a", 0);
    l.hit("b", 500);
    l.hit("a", 1200); // a's window restarts at 1200 (expires 2200), b expires 1500
    l.sweep(1600);
    expect(l.size).toBe(1); // b swept, a kept
    l.sweep(2200);
    expect(l.size).toBe(0);
  });

  it("sweeps expired buckets on an unref'd interval", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const l = new FixedWindowLimiter(5, 1000, 10);
      for (let i = 0; i < 5; i++) l.hit(`k${i}`, 0);
      const stop = l.startSweeper(500, () => now);
      now = 1000;
      vi.advanceTimersByTime(500);
      expect(l.size).toBe(0);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays fast when full (no full scan per new key)", () => {
    const l = new FixedWindowLimiter(5, 60_000, 10_000);
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) l.hit(`ip-${i}`, i);
    expect(l.size).toBe(10_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("RollingWindowCap", () => {
  it("allows `limit` reservations per window and reports Retry-After", () => {
    const cap = new RollingWindowCap(2, 60_000);
    expect(cap.reserve(0).ok).toBe(true);
    expect(cap.reserve(10_000).ok).toBe(true);
    expect(cap.reserve(20_000)).toEqual({ ok: false, retryAfter: 40 });
    expect(cap.reserve(60_000).ok).toBe(true); // first slot expired
    expect(cap.used).toBe(2);
  });

  it("release() gives back exactly that slot", () => {
    const cap = new RollingWindowCap(1, 60_000);
    const a = cap.reserve(0);
    if (!a.ok) throw new Error("expected ok");
    a.release();
    a.release(); // idempotent
    expect(cap.used).toBe(0);
    expect(cap.reserve(1).ok).toBe(true);
  });
});

describe("rateLimitKey", () => {
  it("IPv4 as is, IPv6 by /64, IPv4-mapped → IPv4", async () => {
    const { rateLimitKey } = await import("../src/middleware/client-ip.js");
    expect(rateLimitKey("203.0.113.5")).toBe("203.0.113.5");
    expect(rateLimitKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:DB8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("not:an::ip::")).toBe("not:an::ip::");
  });
});
