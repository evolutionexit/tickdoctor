package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.util.Iso;
import dev.tickdoctor.agent.util.Num;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * Fixed-size ring of tick durations. The main thread writes one slot per tick (no allocation);
 * async readers compute statistics from a range of sequence numbers. The writer publishes via the
 * volatile {@code written} counter; a reader that falls a whole ring behind just loses old ticks.
 */
public final class TickRing {
    public static final double SLOW_TICK_MS = 50.0;
    public static final int MAX_SLOW_TICKS = 100;

    private final int capacity;
    private final double[] durationMs;
    private final long[] wallMs;
    private volatile long written;

    public TickRing(int capacity) {
        this.capacity = capacity;
        this.durationMs = new double[capacity];
        this.wallMs = new long[capacity];
    }

    /** Main thread only. */
    public void record(long endWallMs, double tickMs) {
        long w = written;
        int i = (int) (w % capacity);
        durationMs[i] = tickMs;
        wallMs[i] = endWallMs;
        written = w + 1;
    }

    public long written() {
        return written;
    }

    public int capacity() {
        return capacity;
    }

    /** First sequence number whose tick ended at or after {@code sinceWallMs}. */
    public long seqSince(long sinceWallMs) {
        long end = written;
        long start = Math.max(0, end - capacity + 1);
        long s = end;
        while (s > start && wallMs[(int) ((s - 1) % capacity)] >= sinceWallMs) s--;
        return s;
    }

    /** Statistics for ticks [fromSeq, toSeq). Safe to call from any thread. */
    public Stats stats(long fromSeq, long toSeq) {
        long from = Math.max(fromSeq, Math.max(0, toSeq - capacity + 1));
        int n = (int) Math.max(0, toSeq - from);
        double[] d = new double[n];
        long[] t = new long[n];
        for (int k = 0; k < n; k++) {
            int i = (int) ((from + k) % capacity);
            d[k] = durationMs[i];
            t[k] = wallMs[i];
        }
        return Stats.of(d, t);
    }

    /** Pure statistics over a window of ticks. */
    public record Stats(int count, double avg, double p95, double p99, double max, List<MetricSample.SlowTick> slowTicks) {
        public static final Stats EMPTY = new Stats(0, 0, 0, 0, 0, List.of());

        public static Stats of(double[] durations, long[] wallMs) {
            int n = durations.length;
            if (n == 0) return EMPTY;
            double sum = 0;
            List<int[]> slow = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                sum += durations[i];
                if (durations[i] > SLOW_TICK_MS) slow.add(new int[] {i});
            }
            double[] sorted = durations.clone();
            Arrays.sort(sorted);
            if (slow.size() > MAX_SLOW_TICKS) {
                // keep the longest ones, then restore time order
                slow.sort(Comparator.comparingDouble((int[] a) -> durations[a[0]]).reversed());
                slow = new ArrayList<>(slow.subList(0, MAX_SLOW_TICKS));
                slow.sort(Comparator.comparingInt(a -> a[0]));
            }
            List<MetricSample.SlowTick> slowTicks = new ArrayList<>(slow.size());
            for (int[] s : slow) slowTicks.add(new MetricSample.SlowTick(Iso.ts(wallMs[s[0]]), Num.nonNeg(durations[s[0]])));
            return new Stats(n, sum / n, percentile(sorted, 0.95), percentile(sorted, 0.99), sorted[n - 1], slowTicks);
        }
    }

    /** Nearest-rank percentile of an ascending array; 0 for an empty array. */
    public static double percentile(double[] sorted, double p) {
        int n = sorted.length;
        if (n == 0) return 0;
        int rank = (int) Math.ceil(p * n);
        return sorted[Math.min(n - 1, Math.max(0, rank - 1))];
    }
}
