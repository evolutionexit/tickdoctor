package dev.tickdoctor.agent.model;

import dev.tickdoctor.agent.util.Num;
import java.util.List;
import java.util.Map;

/** POST /v1/ingest/hello payload. Field names and order mirror packages/shared ingest.ts. */
public record Hello(
        Server server,
        Jvm jvm,
        Host host,
        Config config,
        List<World> worlds,
        List<Plugin> plugins,
        String privacyMode) {

    public record Server(String software, String softwareVersion, String minecraftVersion, boolean onlineMode, int maxPlayers) {}

    public record Jvm(String javaVersion, String vendor, List<String> flags, long heapMaxBytes, long heapInitBytes, int availableProcessors) {
        public Jvm {
            heapMaxBytes = Num.nonNegLong(heapMaxBytes);
            heapInitBytes = Num.nonNegLong(heapInitBytes);
        }
    }

    /** model and totalMemoryBytes are omitted (null) when unknown. */
    public record Host(String os, String arch, String model, Long totalMemoryBytes) {
        public Host {
            totalMemoryBytes = Num.nonNegLong(totalMemoryBytes);
        }
    }

    /** Values are String, Number or Boolean only. */
    public record Config(int viewDistance, int simulationDistance, Map<String, Integer> entityActivationRange, Map<String, Object> paperWorldDefaults) {}

    public record World(String name, String environment) {}

    public record Plugin(String name, String version, boolean enabled) {}
}
