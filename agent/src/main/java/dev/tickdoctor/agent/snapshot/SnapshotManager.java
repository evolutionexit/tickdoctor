package dev.tickdoctor.agent.snapshot;

import dev.tickdoctor.agent.collectors.Overhead;
import dev.tickdoctor.agent.collectors.SampleBuilder;
import dev.tickdoctor.agent.collectors.ScanTally;
import dev.tickdoctor.agent.collectors.ThreadCpuTracker;
import dev.tickdoctor.agent.collectors.TickRing;
import dev.tickdoctor.agent.collectors.WorldScanner;
import dev.tickdoctor.agent.events.EventCollector;
import dev.tickdoctor.agent.model.Json;
import dev.tickdoctor.agent.model.Snapshot;
import dev.tickdoctor.agent.util.Iso;
import dev.tickdoctor.agent.util.Num;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Lag-incident snapshots. Triggers: the 5-second MSPT p95 above the threshold on 3 consecutive
 * one-second checks (≈ 5–7 s of sustained lag), {@code /tickdoctor snapshot}, or the API asking via
 * {@code config.requestSnapshot}. Each snapshot runs a fresh full world pass (spread over ticks,
 * 1 ms budget per tick) and is assembled async. At most one per 2 minutes (API limit); threshold
 * snapshots also re-arm only after 30 s below the threshold and at most every 5 minutes, and are
 * suppressed for the first 60 s after the agent starts (world loading).
 */
public final class SnapshotManager {
    static final long MIN_GAP_MS = 120_000;
    static final long THRESHOLD_COOLDOWN_MS = 300_000;
    static final long REARM_BELOW_MS = 30_000;
    static final long TIMEOUT_MS = 60_000;
    static final int CONSECUTIVE_CHECKS = 3;
    /** World loading makes the first ticks slow; don't treat startup as an incident. */
    static final long STARTUP_GRACE_MS = 60_000;

    private final TickRing ring;
    private final WorldScanner scanner;
    private final SampleBuilder samples;
    private final EventCollector events;
    private final ThreadCpuTracker threads;
    private final Overhead overhead;
    private final Executor async;
    private final Consumer<String> submit;
    private final Logger log;
    private volatile double thresholdMs;
    private volatile long windowMs;

    private int above;
    private boolean armed = true;
    private long belowSinceMs;
    private long lastThresholdMs = -THRESHOLD_COOLDOWN_MS;
    private volatile long lastSnapshotMs = -MIN_GAP_MS;
    private volatile boolean inProgress;
    private volatile long startedMs;
    private final long createdMs = System.currentTimeMillis();

    public SnapshotManager(TickRing ring, WorldScanner scanner, SampleBuilder samples, EventCollector events, ThreadCpuTracker threads,
                           Overhead overhead, Executor async, Consumer<String> submit, Logger log, double thresholdMs, long windowMs) {
        this.ring = ring;
        this.scanner = scanner;
        this.samples = samples;
        this.events = events;
        this.threads = threads;
        this.overhead = overhead;
        this.async = async;
        this.submit = submit;
        this.log = log;
        this.thresholdMs = thresholdMs;
        this.windowMs = windowMs;
    }

    public void setThresholdMs(double ms) {
        thresholdMs = ms;
    }

    public double thresholdMs() {
        return thresholdMs;
    }

    public void setWindowMs(long ms) {
        windowMs = ms;
    }

    public double currentP95(long nowMs) {
        TickRing.Stats s = ring.stats(ring.seqSince(nowMs - 5_000), ring.written());
        return s.count() >= 5 ? s.p95() : 0;
    }

    /** Collector thread, once a second. */
    public synchronized void check(long nowMs) {
        if (inProgress && nowMs - startedMs > TIMEOUT_MS) {
            inProgress = false;
            log.warning("snapshot pass did not finish within 60 s; giving up on it.");
        }
        double p95 = currentP95(nowMs);
        if (nowMs - createdMs < STARTUP_GRACE_MS) return;
        if (p95 > thresholdMs) {
            belowSinceMs = 0;
            above++;
            if (armed && above >= CONSECUTIVE_CHECKS && nowMs - lastThresholdMs >= THRESHOLD_COOLDOWN_MS) {
                if (request("threshold", p95, nowMs) == null) {
                    armed = false;
                    lastThresholdMs = nowMs;
                }
            }
        } else {
            above = 0;
            if (belowSinceMs == 0) belowSinceMs = nowMs;
            if (!armed && nowMs - belowSinceMs >= REARM_BELOW_MS) armed = true;
        }
    }

    /** Starts a snapshot. Returns null when started, otherwise why not. Thread-safe. */
    public synchronized String request(String trigger, double p95, long nowMs) {
        if (inProgress) return "a snapshot is already being collected";
        long wait = lastSnapshotMs + MIN_GAP_MS - nowMs;
        if (wait > 0) return "the next snapshot is possible in " + ((wait + 999) / 1000) + " s (max one per 2 minutes)";
        inProgress = true;
        startedMs = nowMs;
        scanner.requestFullPass(tally -> {
            try {
                async.execute(() -> overhead.timeAsync(() -> build(trigger, p95, tally)));
            } catch (java.util.concurrent.RejectedExecutionException e) {
                inProgress = false; // agent is stopping
            }
        });
        return null;
    }

    public boolean inProgress() {
        return inProgress;
    }

    public long lastSnapshotMs() {
        return lastSnapshotMs < 0 ? 0 : lastSnapshotMs;
    }

    private void build(String trigger, double p95, ScanTally tally) {
        try {
            long now = System.currentTimeMillis();
            Snapshot snap = new Snapshot(
                    trigger,
                    Iso.ts(now),
                    Num.nonNeg(p95),
                    samples.peek(now, System.nanoTime(), windowMs, tally),
                    tally.worldDetails(),
                    threads.top(20),
                    events.recent(now));
            submit.accept(Json.toJson(snap));
            lastSnapshotMs = now;
            log.info(trigger + " snapshot collected (" + tally.totalChunks() + " chunks in "
                    + (tally.finishedAtMs() - tally.startedAtMs) + " ms)" + (p95 > 0 ? String.format(", MSPT p95 %.1f ms", p95) : "") + ".");
        } catch (RuntimeException e) {
            log.log(Level.WARNING, "could not build snapshot", e);
        } finally {
            inProgress = false;
        }
    }
}
