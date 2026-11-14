package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.collectors.host.HostCollector;
import dev.tickdoctor.agent.model.HostSample;
import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.util.Iso;
import dev.tickdoctor.agent.util.Num;
import java.util.List;
import java.util.Map;

/** Assembles a {@link MetricSample} from all collectors. Runs on the collector thread. */
public final class SampleBuilder {
    private final TickRing ring;
    private final MainThreadSampler main;
    private final WorldScanner scanner;
    private final ChunkGenCounter chunkGen;
    private final JvmCollector jvm = new JvmCollector();
    private final GcTracker gc;
    private final HostCollector host;
    private final Overhead overhead;
    private final ThreadCpuTracker threads;

    private long lastSeq;
    private long lastSampleMs;
    private volatile MetricSample last;

    public SampleBuilder(TickRing ring, MainThreadSampler main, WorldScanner scanner, ChunkGenCounter chunkGen,
                         GcTracker gc, HostCollector host, Overhead overhead, ThreadCpuTracker threads, long nowMs) {
        this.ring = ring;
        this.main = main;
        this.scanner = scanner;
        this.chunkGen = chunkGen;
        this.gc = gc;
        this.host = host;
        this.overhead = overhead;
        this.threads = threads;
        this.lastSeq = ring.written();
        this.lastSampleMs = nowMs;
    }

    /** The regular sample: consumes the window since the previous call. */
    public MetricSample next(long nowMs, long nowNanos) {
        long to = ring.written();
        TickRing.Stats ticks = ring.stats(lastSeq, to);
        lastSeq = to;
        int window = windowSeconds(nowMs - lastSampleMs);
        lastSampleMs = nowMs;
        threads.tick();
        HostSample h = host == null ? null : host.sample(nowNanos);
        Overhead.Window ow = overhead.drain();
        MetricSample s = assemble(nowMs, window, ticks, gc.drain(), scanner.last(), chunkGen.perMinute(nowNanos, true), h, ow);
        last = s;
        return s;
    }

    /**
     * A sample for a snapshot: the last {@code windowMs} of ticks and the given fresh pass,
     * without consuming the regular window (GC, overhead and chunk-gen are peeked).
     */
    public MetricSample peek(long nowMs, long nowNanos, long windowMs, ScanTally fresh) {
        long to = ring.written();
        TickRing.Stats ticks = ring.stats(ring.seqSince(nowMs - windowMs), to);
        HostSample h = host == null ? null : host.last();
        return assemble(nowMs, windowSeconds(windowMs), ticks, gc.peek(), fresh, chunkGen.perMinute(nowNanos, false), h, overhead.peek());
    }

    public MetricSample last() {
        return last;
    }

    private MetricSample assemble(long nowMs, int window, TickRing.Stats t, List<MetricSample.GcPause> gcs, ScanTally tally,
                                  Map<String, Double> gen, HostSample h, Overhead.Window ow) {
        double[] tps = main.tps();
        MetricSample.Tick tick = new MetricSample.Tick(
                Num.nonNeg(tps[0]), Num.nonNeg(tps[1]), Num.nonNeg(tps[2]),
                Num.nonNeg(t.avg()), Num.nonNeg(t.p95()), Num.nonNeg(t.p99()), Num.nonNeg(t.max()),
                t.count(), t.slowTicks());
        MainThreadSampler.Players p = main.players();
        return new MetricSample(
                Iso.ts(nowMs),
                window,
                tick,
                jvm.sample(gcs),
                tally == null ? List.of() : tally.worldSamples(nowMs, gen),
                tally == null ? List.of() : tally.worstChunks(10),
                new MetricSample.Players(p.count(), p.pings()),
                h == null || h.isEmpty() ? null : h,
                new MetricSample.AgentOverhead(Num.nonNeg(ow.mainThreadMsPerTick()), Num.nonNeg(ow.mainThreadMsMax()), Num.nonNeg(ow.asyncCpuMs())));
    }

    static int windowSeconds(long ms) {
        return Num.clampInt(Math.round(ms / 1000.0), 1, 300);
    }
}
