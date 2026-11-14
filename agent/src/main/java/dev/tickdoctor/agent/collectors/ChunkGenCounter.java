package dev.tickdoctor.agent.collectors;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.LongAdder;

/** Newly generated chunks per world (from ChunkLoadEvent#isNewChunk), as a per-minute rate. */
public final class ChunkGenCounter {
    private final ConcurrentHashMap<String, LongAdder> counts = new ConcurrentHashMap<>();
    private final Map<String, Long> baseline = new HashMap<>();
    private long baselineNanos;

    public ChunkGenCounter(long nowNanos) {
        baselineNanos = nowNanos;
    }

    /** Main thread (event handler); lock-free. */
    public void newChunk(String world) {
        counts.computeIfAbsent(world, k -> new LongAdder()).increment();
    }

    /** Rate per world since the last consuming call. {@code consume=false} peeks. */
    public synchronized Map<String, Double> perMinute(long nowNanos, boolean consume) {
        double minutes = (nowNanos - baselineNanos) / 60e9;
        Map<String, Double> out = new HashMap<>();
        for (Map.Entry<String, LongAdder> e : counts.entrySet()) {
            long total = e.getValue().sum();
            long delta = total - baseline.getOrDefault(e.getKey(), 0L);
            out.put(e.getKey(), minutes <= 0 ? 0.0 : Math.round(delta / minutes * 10) / 10.0);
            if (consume) baseline.put(e.getKey(), total);
        }
        if (consume) baselineNanos = nowNanos;
        return out;
    }
}
