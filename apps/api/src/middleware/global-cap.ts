/**
 * Global (not per-IP) cap on an action within a rolling window, e.g. new waitlist rows per hour.
 * Defence in depth against IP-spraying bots that stay under the per-IP limit.
 */
export interface GlobalCap {
  /**
   * Reserves one slot. On success, call `release()` if the action turned out not to count
   * (e.g. a duplicate email that inserted nothing).
   */
  reserve(now: number): { ok: true; release: () => void } | { ok: false; retryAfter: number };
}

/** In-memory rolling-window cap. Memory is bounded by `limit` timestamps. */
export class RollingWindowCap implements GlobalCap {
  // Ascending by time (callers pass a monotonic clock); objects so release() removes the exact slot.
  private readonly slots: { at: number }[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get used(): number {
    return this.slots.length;
  }

  reserve(now: number): { ok: true; release: () => void } | { ok: false; retryAfter: number } {
    while (this.slots.length > 0 && this.slots[0]!.at + this.windowMs <= now) this.slots.shift();
    if (this.slots.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((this.slots[0]!.at + this.windowMs - now) / 1000));
      return { ok: false, retryAfter };
    }
    const slot = { at: now };
    this.slots.push(slot);
    return {
      ok: true,
      release: () => {
        const i = this.slots.indexOf(slot);
        if (i !== -1) this.slots.splice(i, 1);
      },
    };
  }
}
