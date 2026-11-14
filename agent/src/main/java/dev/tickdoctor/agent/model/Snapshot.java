package dev.tickdoctor.agent.model;

import java.util.List;
import java.util.Map;

/** POST /v1/ingest/snapshot payload. */
public record Snapshot(
        String trigger,
        String ts,
        double msptP95AtTrigger,
        MetricSample sample,
        List<WorldDetail> worldsDetail,
        List<ThreadCpu> threads,
        List<AgentEvent> recentEvents) {

    public record WorldDetail(String name, Map<String, Integer> entitiesByType, Map<String, Integer> tileEntitiesByType, List<TopChunk> topChunks) {}

    public record TopChunk(int x, int z, int entities, int tileEntities, Map<String, Integer> byType) {}

    public record ThreadCpu(String name, String state, Double cpuMs) {}
}
