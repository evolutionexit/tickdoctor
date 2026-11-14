package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.model.Snapshot;
import dev.tickdoctor.agent.util.Num;
import dev.tickdoctor.agent.util.Str;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Per-thread CPU over the last metrics window; used for the snapshot's "top threads". Async. */
public final class ThreadCpuTracker {
    private final ThreadMXBean mx = ManagementFactory.getThreadMXBean();
    private Map<Long, Long> previous = new HashMap<>();
    private Map<Long, Long> lastDelta = new HashMap<>();

    /** Called once per metrics window. */
    public synchronized void tick() {
        if (!mx.isThreadCpuTimeSupported()) return;
        Map<Long, Long> now = new HashMap<>();
        Map<Long, Long> delta = new HashMap<>();
        for (long id : mx.getAllThreadIds()) {
            long cpu = mx.getThreadCpuTime(id);
            if (cpu < 0) continue;
            now.put(id, cpu);
            Long prev = previous.get(id);
            delta.put(id, prev == null ? cpu : Math.max(0, cpu - prev));
        }
        previous = now;
        lastDelta = delta;
    }

    /** Top threads by CPU in the last window (ms), ≤ 20, no stacks. */
    public synchronized List<Snapshot.ThreadCpu> top(int limit) {
        List<Map.Entry<Long, Long>> e = new ArrayList<>(lastDelta.entrySet());
        e.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
        List<Snapshot.ThreadCpu> out = new ArrayList<>();
        int n = Math.min(Math.min(limit, 20), e.size());
        if (n == 0) return out;
        long[] ids = new long[n];
        for (int i = 0; i < n; i++) ids[i] = e.get(i).getKey();
        ThreadInfo[] infos = mx.getThreadInfo(ids, 0);
        for (int i = 0; i < n; i++) {
            ThreadInfo ti = infos[i];
            if (ti == null) continue;
            out.add(new Snapshot.ThreadCpu(Str.nonEmpty(ti.getThreadName(), "?", 200), Str.cap(ti.getThreadState().name(), 30), Num.nonNeg(e.get(i).getValue() / 1e6)));
        }
        return out;
    }
}
