package dev.tickdoctor.agent;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import dev.tickdoctor.agent.collectors.GcTracker;
import dev.tickdoctor.agent.collectors.JvmCollector;
import dev.tickdoctor.agent.collectors.ScanTally;
import dev.tickdoctor.agent.collectors.ThreadCpuTracker;
import dev.tickdoctor.agent.collectors.TickRing;
import dev.tickdoctor.agent.collectors.host.HostCollector;
import dev.tickdoctor.agent.events.EventCollector;
import dev.tickdoctor.agent.events.LogEvents;
import dev.tickdoctor.agent.events.PluginDiff;
import dev.tickdoctor.agent.events.PluginGuesser;
import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.Hello;
import dev.tickdoctor.agent.model.HostSample;
import dev.tickdoctor.agent.model.Json;
import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.model.Snapshot;
import dev.tickdoctor.agent.privacy.PrivacyMode;
import dev.tickdoctor.agent.privacy.Redaction;
import dev.tickdoctor.agent.transport.Envelopes;
import dev.tickdoctor.agent.transport.Kind;
import dev.tickdoctor.agent.util.Iso;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Serializes payloads with the agent's real model + builders and validates them against the
 * generated contract schema docs/contracts/ingest.schema.json (passed in by Gradle).
 */
class SchemaValidationTest {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static JsonNode schemas;
    static final String BOOT = UUID.randomUUID().toString();

    @BeforeAll
    static void load() throws Exception {
        Path p = Path.of(System.getProperty("tickdoctor.schema", "../docs/contracts/ingest.schema.json"));
        schemas = MAPPER.readTree(Files.readString(p)).get("schemas");
    }

    static Set<ValidationMessage> validate(String schemaName, String json) throws Exception {
        SchemaValidatorsConfig cfg = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();
        JsonSchema schema = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(schemas.get(schemaName), cfg);
        return schema.validate(MAPPER.readTree(json));
    }

    static void assertValid(String schemaName, String json) throws Exception {
        Set<ValidationMessage> errors = validate(schemaName, json);
        assertTrue(errors.isEmpty(), schemaName + " invalid: " + errors + "\n" + json);
    }

    // ---------- builders using the real code paths ----------

    static Hello hello(boolean full) {
        List<String> flags = new ArrayList<>();
        for (String f : List.of("-Xms1G", "-Xmx3G", "-XX:+UseG1GC", "-Dsecret.token=abc")) flags.add(Redaction.redactFlag(f));
        Map<String, Integer> ear = new LinkedHashMap<>();
        ear.put("animals", 32);
        ear.put("monsters", 32);
        ear.put("raiders", 64);
        Map<String, Object> pwd = new LinkedHashMap<>();
        pwd.put("chunks.max-auto-save-chunks-per-tick", 24);
        pwd.put("misc.redstone-implementation", "VANILLA");
        pwd.put("hopper.disable-move-event", false);
        pwd.put("entities.spawning.spawn-limits.monster", -1);
        return new Hello(
                new Hello.Server("Paper", "26.2-83-main@f9fb80b", "26.2", true, 8),
                new Hello.Jvm("25.0.5 (OpenJDK 64-Bit Server VM)", "Eclipse Adoptium", flags, 3L << 30, 1L << 30, 4),
                new Hello.Host("Linux 6.12.47+rpt-rpi-2712", "aarch64", full ? "Raspberry Pi 5 Model B Rev 1.0" : null, full ? 8_443_215_872L : null),
                new Hello.Config(8, 6, full ? ear : null, full ? pwd : null),
                List.of(new Hello.World("world", "NORMAL"), new Hello.World("world_nether", "NETHER"), new Hello.World("world_the_end", "THE_END")),
                List.of(new Hello.Plugin("TickDoctor", "0.1.0", true), new Hello.Plugin("spark", "1.10.150", true), new Hello.Plugin("Legacy", "", false)),
                full ? PrivacyMode.HASHED.wire() : PrivacyMode.NONE.wire());
    }

    static ScanTally tally() {
        ScanTally t = new ScanTally(System.currentTimeMillis() - 2_500);
        t.beginWorld("world");
        for (int i = 0; i < 30; i++) {
            t.beginChunk(i - 15, i * 3 - 40);
            for (int k = 0; k < i; k++) t.entity(k % 3 == 0 ? "zombie" : k % 3 == 1 ? "item" : "villager");
            for (int k = 0; k < i % 7; k++) t.tileEntity(k % 2 == 0 ? "hopper" : "chest");
            t.endChunk();
        }
        t.beginWorld("world_nether");
        t.beginChunk(0, 0);
        t.endChunk();
        t.finish(System.currentTimeMillis());
        return t;
    }

    static MetricSample sample(boolean withHostAndPings) throws Exception {
        TickRing ring = new TickRing(400);
        long now = System.currentTimeMillis();
        for (int i = 0; i < 200; i++) ring.record(now - 10_000 + i * 50L, i % 50 == 0 ? 180.5 : 12.25 + (i % 7));
        TickRing.Stats st = ring.stats(0, ring.written());
        ScanTally t = tally();
        HostSample host = null;
        if (withHostAndPings) {
            Path root = Path.of(SchemaValidationTest.class.getResource("/pi5").toURI());
            HostCollector hc = new HostCollector(root, root.toFile(), null);
            hc.sample(1);
            HostSample s2 = hc.sample(10_000_000_001L);
            host = new HostSample(s2.cpuLoad1m(), 0.42, s2.cpuTempC(), new HostSample.Throttled(false, true, "0x50000"), s2.memTotalBytes(),
                    s2.memAvailableBytes(), s2.swapTotalBytes(), s2.swapUsedBytes(), s2.diskTotalBytes(), s2.diskUsedBytes(),
                    0.0, 1_048_576.0, 10_000.0, 50_000.0);
        }
        List<MetricSample.Ping> pings = null;
        if (withHostAndPings) {
            pings = List.of(new MetricSample.Ping(23), new MetricSample.Ping(140));
        }
        GcTracker gc = new GcTracker();
        gc.start();
        System.gc();
        MetricSample.Jvm jvm = new JvmCollector().sample(gc.drain());
        gc.stop();
        return new MetricSample(
                Iso.ts(now), 10,
                new MetricSample.Tick(19.98, 19.99, 20.0, st.avg(), st.p95(), st.p99(), st.max(), st.count(), st.slowTicks()),
                jvm,
                t.worldSamples(now, Map.of("world", 3.5)),
                t.worstChunks(10),
                new MetricSample.Players(withHostAndPings ? 2 : 0, pings),
                host,
                new MetricSample.AgentOverhead(0.031, 0.21, 12));
    }

    static List<AgentEvent> allEvents() {
        String ts = Iso.now();
        List<AgentEvent> l = new ArrayList<>();
        l.add(new AgentEvent.ServerStart(ts, true));
        l.add(new AgentEvent.ServerStop(ts, "shutdown"));
        l.add(new AgentEvent.ServerStop(ts, null));
        l.add(new AgentEvent.Crash(ts, "Previous run ended without a clean shutdown."));
        l.add(new AgentEvent.Crash(ts, null));
        l.add(new AgentEvent.PlayerJoin(ts, 1));
        l.add(new AgentEvent.PlayerLeave(ts, 0));
        l.add(LogEvents.cantKeepUp(System.currentTimeMillis(), "Can't keep up! Is the server overloaded? Running 2345ms or 46 ticks behind"));
        l.add(LogEvents.exception(System.currentTimeMillis(), "Minecraft", "Could not pass event X to Foo v1",
                new IllegalStateException("boom", new NullPointerException()), new PluginGuesser(Map.of("Foo", "com.example.foo.Foo"))));
        l.add(new AgentEvent.ExceptionEvent(ts, null, "java.lang.Error", null, "abc", null, 3));
        l.add(PluginDiff.diff(List.of(new Hello.Plugin("A", "1", true), new Hello.Plugin("B", "1", true)),
                List.of(new Hello.Plugin("A", "2", true), new Hello.Plugin("C", "1", true)), System.currentTimeMillis()));
        return l;
    }

    // ---------- tests ----------

    @Test
    void helloIsValid() throws Exception {
        assertValid("helloRequest", Envelopes.wrap(Json.toJson(hello(true)), "0.1.0", Iso.now(), BOOT));
        assertValid("helloRequest", Envelopes.wrap(Json.toJson(hello(false)), "0.1.0", Iso.now(), BOOT));
    }

    @Test
    void metricsAreValid() throws Exception {
        List<String> items = List.of(Json.toJson(sample(true)), Json.toJson(sample(false)));
        assertValid("metricsRequest", Envelopes.wrap(Kind.METRICS, items, "0.1.0", Iso.now(), BOOT));
    }

    @Test
    void everyEventTypeIsValid() throws Exception {
        List<String> items = new ArrayList<>();
        for (AgentEvent e : allEvents()) items.add(Json.toJson(e));
        assertValid("eventsRequest", Envelopes.wrap(Kind.EVENTS, items, "0.1.0", Iso.now(), BOOT));
    }

    @Test
    void snapshotIsValid() throws Exception {
        ThreadCpuTracker threads = new ThreadCpuTracker();
        threads.tick();
        threads.tick();
        EventCollector ec = new EventCollector();
        long now = System.currentTimeMillis();
        for (AgentEvent e : allEvents()) ec.add(e, now);
        ec.drain(now);
        ScanTally t = tally();
        Snapshot s = new Snapshot("threshold", Iso.now(), 63.2, sample(true), t.worldDetails(), threads.top(20), ec.recent(now));
        assertValid("snapshotRequest", Envelopes.wrap(Kind.SNAPSHOT, List.of(Json.toJson(s)), "0.1.0", Iso.now(), BOOT));
        Snapshot minimal = new Snapshot("manual", Iso.now(), 0, sample(false), List.of(), null, List.of());
        assertValid("snapshotRequest", Envelopes.wrap(Kind.SNAPSHOT, List.of(Json.toJson(minimal)), "0.1.0", Iso.now(), BOOT));
    }

    @Test
    void validatorActuallyRejectsBadPayloads() throws Exception {
        String good = Envelopes.wrap(Json.toJson(hello(true)), "0.1.0", Iso.now(), BOOT);
        assertTrue(validate("helloRequest", good).isEmpty());
        assertFalse(validate("helloRequest", Envelopes.wrap(Json.toJson(hello(true)), "0.1.0", Iso.now(), "not-a-uuid")).isEmpty(), "uuid format");
        assertFalse(validate("helloRequest", Envelopes.wrap(Json.toJson(hello(true)), "0.1.0", "yesterday", BOOT)).isEmpty(), "date-time format");
        assertFalse(validate("helloRequest", good.replace("\"privacyMode\":\"hashed\"", "\"privacyMode\":\"plain\"")).isEmpty(), "enum");
        assertFalse(validate("helloRequest", good.replace("\"onlineMode\":true", "\"onlineMode\":true,\"extra\":1")).isEmpty(), "additionalProperties");
        String ev = Envelopes.wrap(Kind.EVENTS, List.of("{\"type\":\"player_join\",\"ts\":\"" + Iso.now() + "\",\"playerId\":\"abc\",\"playerCount\":1}"), "0.1.0", Iso.now(), BOOT);
        assertFalse(validate("eventsRequest", ev).isEmpty(), "playerId must be 64 chars");
        String empty = Envelopes.wrap(Kind.METRICS, List.of(), "0.1.0", Iso.now(), BOOT);
        assertFalse(validate("metricsRequest", empty).isEmpty(), "samples min 1");
    }

    /**
     * Dev aid: validates request bodies captured from a real server by a stub API
     * (files named NNNN-&lt;kind&gt;.json). Runs only with -Dtickdoctor.bodies=DIR
     * (or env TICKDOCTOR_BODIES=DIR via Gradle).
     */
    @Test
    void capturedBodiesAreValid() throws Exception {
        String dir = System.getProperty("tickdoctor.bodies");
        org.junit.jupiter.api.Assumptions.assumeTrue(dir != null && !dir.isBlank(), "no captured bodies given");
        int n = 0;
        try (var files = Files.list(Path.of(dir))) {
            for (Path f : files.sorted().toList()) {
                String name = f.getFileName().toString();
                if (!name.endsWith(".json") || name.indexOf('-') < 0) continue;
                String kind = name.substring(name.indexOf('-') + 1, name.length() - 5);
                assertValid(kind + "Request", Files.readString(f));
                n++;
            }
        }
        assertTrue(n > 0, "no bodies in " + dir);
    }
}
