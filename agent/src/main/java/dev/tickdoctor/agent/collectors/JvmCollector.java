package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.util.Num;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.lang.management.OperatingSystemMXBean;
import java.util.List;

/** Heap, threads and process CPU from JMX. Async. */
public final class JvmCollector {
    public MetricSample.Jvm sample(List<MetricSample.GcPause> gc) {
        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        long max = heap.getMax() < 0 ? heap.getCommitted() : heap.getMax();
        return new MetricSample.Jvm(
                Num.nonNegLong(heap.getUsed()),
                Num.nonNegLong(heap.getCommitted()),
                Num.nonNegLong(max),
                gc,
                ManagementFactory.getThreadMXBean().getThreadCount(),
                processCpuLoad());
    }

    private static volatile double lastGoodCpu;

    /**
     * Process CPU load 0..1. The MXBean returns a negative value when it has no reading yet (first
     * call) or the platform can't measure it; then the last good value is reported (0 before the
     * first one), since the contract requires the field.
     */
    static double processCpuLoad() {
        OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
        if (os instanceof com.sun.management.OperatingSystemMXBean sun) {
            return cpuOrLastGood(sun.getProcessCpuLoad());
        }
        return lastGoodCpu;
    }

    static double cpuOrLastGood(double raw) {
        if (!Double.isFinite(raw) || raw < 0) return lastGoodCpu;
        double v = Num.ratio(raw);
        lastGoodCpu = v;
        return v;
    }
}
