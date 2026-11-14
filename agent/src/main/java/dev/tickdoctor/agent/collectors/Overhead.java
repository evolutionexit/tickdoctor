package dev.tickdoctor.agent.collectors;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The agent's own cost. Every main-thread task adds its nanoTime delta via {@link #addMain}; at
 * each tick start the previous tick's total is folded into the window (avg + max). Async tasks
 * add their thread CPU time via {@link #timeAsync}.
 */
public final class Overhead {
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private static final boolean CPU_TIME = THREADS.isCurrentThreadCpuTimeSupported();

    private long tickNanos; // main thread only
    private final AtomicLong winTotal = new AtomicLong();
    private final AtomicLong winTicks = new AtomicLong();
    private final AtomicLong winMax = new AtomicLong();
    private final AtomicLong asyncNanos = new AtomicLong();
    private volatile Window last = new Window(0, 0, 0);
    private final AtomicLong lifetimeMax = new AtomicLong();

    public record Window(double mainThreadMsPerTick, double mainThreadMsMax, double asyncCpuMs) {}

    /** Main thread only. */
    public void addMain(long nanos) {
        tickNanos += nanos;
    }

    /** Main thread only: called once per tick (at tick start) to close the previous tick. */
    public void endTick() {
        long t = tickNanos;
        tickNanos = 0;
        winTotal.addAndGet(t);
        winTicks.incrementAndGet();
        if (t > winMax.get()) winMax.accumulateAndGet(t, Math::max);
    }

    public void addAsyncNanos(long nanos) {
        if (nanos > 0) asyncNanos.addAndGet(nanos);
    }

    /** Runs {@code r} and charges its thread CPU time (or wall time if CPU time is unsupported). */
    public void timeAsync(Runnable r) {
        long c0 = cpuNow();
        try {
            r.run();
        } finally {
            addAsyncNanos(cpuNow() - c0);
        }
    }

    private static long cpuNow() {
        return CPU_TIME ? THREADS.getCurrentThreadCpuTime() : System.nanoTime();
    }

    /** Returns and resets the window. */
    public Window drain() {
        long total = winTotal.getAndSet(0);
        long ticks = winTicks.getAndSet(0);
        long max = winMax.getAndSet(0);
        long async = asyncNanos.getAndSet(0);
        lifetimeMax.accumulateAndGet(max, Math::max);
        Window w = new Window(ticks == 0 ? 0 : total / 1e6 / ticks, max / 1e6, async / 1e6);
        last = w;
        return w;
    }

    /** Current window without resetting (for snapshots). */
    public Window peek() {
        long ticks = winTicks.get();
        return new Window(ticks == 0 ? 0 : winTotal.get() / 1e6 / ticks, winMax.get() / 1e6, asyncNanos.get() / 1e6);
    }

    public Window lastWindow() {
        return last;
    }

    public double lifetimeMaxMs() {
        return Math.max(lifetimeMax.get(), winMax.get()) / 1e6;
    }
}
