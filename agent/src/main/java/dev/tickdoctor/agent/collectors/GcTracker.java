package dev.tickdoctor.agent.collectors;

import com.sun.management.GarbageCollectionNotificationInfo;
import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.util.Num;
import dev.tickdoctor.agent.util.Str;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.management.ListenerNotFoundException;
import javax.management.Notification;
import javax.management.NotificationEmitter;
import javax.management.NotificationListener;
import javax.management.openmbean.CompositeData;

/**
 * GC pauses per collector via JMX GC notifications (gives real per-pause durations, so maxMs is
 * exact). Collectors that report whole concurrent cycles rather than pauses (ZGC/Shenandoah
 * "... Cycles") are skipped. Falls back to MXBean count/time deltas when notifications fail.
 */
public final class GcTracker implements NotificationListener {
    private static final class Acc {
        long count;
        double totalMs;
        double maxMs;
        long beanCount; // fallback baseline
        long beanTime;
    }

    private final Map<String, Acc> accs = new LinkedHashMap<>();
    private final List<NotificationEmitter> emitters = new ArrayList<>();
    private boolean notifications;

    public synchronized void start() {
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (!isPauseCollector(gc.getName())) continue;
            Acc a = new Acc();
            a.beanCount = gc.getCollectionCount();
            a.beanTime = gc.getCollectionTime();
            accs.put(gc.getName(), a);
            if (gc instanceof NotificationEmitter em) {
                try {
                    em.addNotificationListener(this, null, null);
                    emitters.add(em);
                    notifications = true;
                } catch (RuntimeException ignored) {
                    // fall back to deltas
                }
            }
        }
    }

    public synchronized void stop() {
        for (NotificationEmitter em : emitters) {
            try {
                em.removeNotificationListener(this);
            } catch (ListenerNotFoundException ignored) {
                // already gone
            }
        }
        emitters.clear();
    }

    static boolean isPauseCollector(String name) {
        return !name.contains("Cycles");
    }

    @Override
    public void handleNotification(Notification n, Object handback) {
        if (!GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION.equals(n.getType())) return;
        GarbageCollectionNotificationInfo info = GarbageCollectionNotificationInfo.from((CompositeData) n.getUserData());
        record(info.getGcName(), info.getGcInfo().getDuration());
    }

    synchronized void record(String collector, double ms) {
        Acc a = accs.get(collector);
        if (a == null) return;
        a.count++;
        a.totalMs += ms;
        a.maxMs = Math.max(a.maxMs, ms);
    }

    /** Pauses since the last drain, one entry per collector (≤ 10). */
    public synchronized List<MetricSample.GcPause> drain() {
        List<MetricSample.GcPause> out = snapshot();
        for (Acc a : accs.values()) {
            a.count = 0;
            a.totalMs = 0;
            a.maxMs = 0;
        }
        return out;
    }

    public synchronized List<MetricSample.GcPause> peek() {
        return snapshot();
    }

    private List<MetricSample.GcPause> snapshot() {
        if (!notifications) fallbackDeltas();
        List<MetricSample.GcPause> out = new ArrayList<>();
        for (Map.Entry<String, Acc> e : accs.entrySet()) {
            if (out.size() >= 10) break;
            Acc a = e.getValue();
            out.add(new MetricSample.GcPause(Str.nonEmpty(e.getKey(), "gc", 200), a.count, Num.nonNeg(a.totalMs), Num.nonNeg(Math.min(a.maxMs, a.totalMs))));
        }
        return out;
    }

    private void fallbackDeltas() {
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            Acc a = accs.get(gc.getName());
            if (a == null) continue;
            long c = gc.getCollectionCount();
            long t = gc.getCollectionTime();
            long dc = Math.max(0, c - a.beanCount);
            long dt = Math.max(0, t - a.beanTime);
            a.beanCount = c;
            a.beanTime = t;
            a.count += dc;
            a.totalMs += dt;
            // without per-pause data the best bound we have is the average pause
            if (dc > 0) a.maxMs = Math.max(a.maxMs, (double) dt / dc);
        }
    }
}
