package dev.tickdoctor.agent.model;

import dev.tickdoctor.agent.util.Num;
import java.util.List;
import java.util.Map;

/** One metrics sample (an element of MetricsPayload.samples). Null fields are omitted. */
public record MetricSample(
        String ts,
        int windowSeconds,
        Tick tick,
        Jvm jvm,
        List<WorldSample> world,
        List<WorstChunk> worstChunks,
        Players players,
        HostSample host,
        AgentOverhead agentOverhead) {

    public record Tick(
            double tps1m, double tps5m, double tps15m,
            double msptAvg, double msptP95, double msptP99, double msptMax,
            int tickCount, List<SlowTick> slowTicks) {}

    public record SlowTick(String ts, double durationMs) {}

    public record Jvm(long heapUsedBytes, long heapCommittedBytes, long heapMaxBytes, List<GcPause> gcPauses, int threadCount, double processCpuLoad) {
        public Jvm {
            heapUsedBytes = Num.nonNegLong(heapUsedBytes);
            heapCommittedBytes = Num.nonNegLong(heapCommittedBytes);
            heapMaxBytes = Num.nonNegLong(heapMaxBytes);
        }
    }

    public record GcPause(String collector, long count, double totalMs, double maxMs) {
        public GcPause {
            count = Num.count(count);
        }
    }

    public record WorldSample(
            String name, int loadedChunks, int entities,
            Map<String, Integer> entitiesByType, Map<String, Integer> tileEntitiesByType,
            Double chunkGenPerMinute, double countsAgeSeconds) {}

    public record WorstChunk(String world, int x, int z, int entities, int tileEntities, String topEntityType) {}

    public record Players(int count, List<Ping> pings) {}

    /** One online player's ping. No player id (data minimisation; the contract's id is deprecated). */
    public record Ping(int pingMs) {}

    public record AgentOverhead(double mainThreadMsPerTick, double mainThreadMsMax, double asyncCpuMs) {}
}
