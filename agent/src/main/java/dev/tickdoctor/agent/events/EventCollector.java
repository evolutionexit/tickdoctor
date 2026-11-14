package dev.tickdoctor.agent.events;

import dev.tickdoctor.agent.model.AgentEvent;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Thread-safe event queue. Exceptions are folded by stackHash until the next drain (the
 * {@code count} field). Keeps the last 5 minutes (≤ 500 events) for snapshots.
 */
public final class EventCollector {
    public static final int MAX_BATCH = 500;
    static final int MAX_PENDING = 5000;
    static final int MAX_DISTINCT_EXCEPTIONS = 500;
    static final long RECENT_MS = 5 * 60_000L;
    static final int MAX_RECENT = 500;

    private record Timed(long ms, AgentEvent event) {}

    private final ArrayDeque<Timed> pending = new ArrayDeque<>();
    private final LinkedHashMap<String, AgentEvent.ExceptionEvent> exceptions = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> exceptionFirstMs = new LinkedHashMap<>();
    private final ArrayDeque<Timed> recent = new ArrayDeque<>();
    private long dropped;

    public synchronized void add(AgentEvent e, long nowMs) {
        if (pending.size() >= MAX_PENDING) {
            dropped++;
            return;
        }
        pending.add(new Timed(nowMs, e));
    }

    public synchronized void addException(AgentEvent.ExceptionEvent e, long nowMs) {
        AgentEvent.ExceptionEvent prev = exceptions.get(e.stackHash());
        if (prev != null) {
            exceptions.put(e.stackHash(), prev.withCount(prev.count() + e.count()));
        } else if (exceptions.size() < MAX_DISTINCT_EXCEPTIONS) {
            exceptions.put(e.stackHash(), e);
            exceptionFirstMs.put(e.stackHash(), nowMs);
        } else {
            dropped++;
        }
    }

    public synchronized boolean isEmpty() {
        return pending.isEmpty() && exceptions.isEmpty();
    }

    /** Everything pending (exceptions folded), oldest first; also remembered as "recent". */
    public synchronized List<AgentEvent> drain(long nowMs) {
        List<Timed> all = new ArrayList<>(pending);
        pending.clear();
        for (var e : exceptions.entrySet()) all.add(new Timed(exceptionFirstMs.getOrDefault(e.getKey(), nowMs), e.getValue()));
        exceptions.clear();
        exceptionFirstMs.clear();
        all.sort((a, b) -> Long.compare(a.ms, b.ms));
        recent.addAll(all);
        prune(nowMs);
        List<AgentEvent> out = new ArrayList<>(all.size());
        for (Timed t : all) out.add(t.event);
        return out;
    }

    /** Last 5 minutes incl. not-yet-sent events, oldest first, ≤ 500. */
    public synchronized List<AgentEvent> recent(long nowMs) {
        prune(nowMs);
        List<Timed> all = new ArrayList<>(recent);
        all.addAll(pending);
        for (var e : exceptions.entrySet()) all.add(new Timed(exceptionFirstMs.getOrDefault(e.getKey(), nowMs), e.getValue()));
        all.removeIf(t -> t.ms < nowMs - RECENT_MS);
        all.sort((a, b) -> Long.compare(a.ms, b.ms));
        int from = Math.max(0, all.size() - MAX_RECENT);
        List<AgentEvent> out = new ArrayList<>();
        for (Timed t : all.subList(from, all.size())) out.add(t.event);
        return out;
    }

    public synchronized long dropped() {
        return dropped;
    }

    private void prune(long nowMs) {
        while (!recent.isEmpty() && (recent.peekFirst().ms < nowMs - RECENT_MS || recent.size() > MAX_RECENT)) recent.pollFirst();
    }
}
