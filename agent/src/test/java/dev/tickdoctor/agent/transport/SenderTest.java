package dev.tickdoctor.agent.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Random;
import java.util.logging.Logger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SenderTest {
    record Call(String path, JsonObject body) {
        int items() {
            JsonObject p = body.getAsJsonObject("payload");
            if (p.has("samples")) return p.getAsJsonArray("samples").size();
            if (p.has("events")) return p.getAsJsonArray("events").size();
            return 1;
        }
    }

    /** Scripted fake API. */
    static final class FakeApi implements Sender.Transport {
        final List<Call> calls = new ArrayList<>();
        final Deque<IngestResult> script = new ArrayDeque<>();
        IngestResult otherwise = new IngestResult.Ok(RemoteConfig.NONE);
        int closed;
        int callsWhenClosed = -1;

        @Override
        public void close() {
            closed++;
            callsWhenClosed = calls.size();
        }

        @Override
        public Sender.Sent post(String path, String json) {
            calls.add(new Call(path, JsonParser.parseString(json).getAsJsonObject()));
            IngestResult r = script.isEmpty() ? otherwise : script.poll();
            return new Sender.Sent(r, 200, json.length(), json.length() / 3, 1);
        }
    }

    @TempDir
    Path dir;
    FakeApi api;
    DiskBuffer disk;
    Sender sender;
    List<RemoteConfig> configs;
    long now;

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeApi();
        disk = new DiskBuffer(dir, 10_000_000);
        configs = new ArrayList<>();
        sender = new Sender(api, disk, new Backoff(new Random(1)), "0.1.0", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77",
                Logger.getLogger("test"), configs::add, true);
        now = 1_000_000;
    }

    private void pump() {
        sender.pump(now);
        now += Sender.MIN_SPACING_MS;
    }

    private static List<String> samples(int from, int n) {
        List<String> l = new ArrayList<>();
        for (int i = from; i < from + n; i++) l.add("{\"n\":" + i + "}");
        return l;
    }

    @Test
    void lastPushSurvivesReload() throws Exception {
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        long pushed = sender.lastPushMs();
        assertTrue(pushed > 0);
        // /tickdoctor reload: a fresh Sender gets the old one's last push
        Sender next = new Sender(api, disk, new Backoff(new Random(1)), "0.1.4", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77",
                Logger.getLogger("test"), configs::add, true);
        assertEquals(0, next.lastPushMs());
        next.carryOverLastPush(pushed);
        assertEquals(pushed, next.lastPushMs());
        next.carryOverLastPush(pushed - 5_000);
        assertEquals(pushed, next.lastPushMs(), "never moves backwards");
        next.submit(Kind.METRICS, samples(1, 1));
        next.pump(now + 60_000);
        assertEquals(now + 60_000, next.lastPushMs(), "a new push replaces the carried value");
    }

    @Test
    void helloFirstThenBatchesInAnEnvelope() {
        sender.setHello("{\"h\":1}");
        sender.submit(Kind.METRICS, samples(0, 1));
        sender.submit(Kind.METRICS, samples(1, 1));
        pump();
        pump();
        assertEquals(2, api.calls.size());
        assertEquals("hello", api.calls.get(0).path());
        Call m = api.calls.get(1);
        assertEquals("metrics", m.path());
        assertEquals(2, m.items(), "consecutive same-kind batches are merged");
        assertEquals(1, m.body().get("schemaVersion").getAsInt());
        assertEquals("0.1.0", m.body().get("agentVersion").getAsString());
        assertTrue(m.body().get("sentAt").getAsString().endsWith("Z"));
        assertEquals(Sender.State.CONNECTED, sender.state());
        assertEquals(0, sender.memoryBatches());
    }

    @Test
    void respectsRequestSpacing() {
        sender.submit(Kind.EVENTS, samples(0, 1));
        sender.submit(Kind.METRICS, samples(0, 1));
        sender.pump(now);
        sender.pump(now + 100);
        assertEquals(1, api.calls.size());
        sender.pump(now + Sender.MIN_SPACING_MS);
        assertEquals(2, api.calls.size());
    }

    @Test
    void failuresSpillToDiskAndFlushInOrderLater() {
        api.script.add(new IngestResult.Retryable("Connection refused"));
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        assertEquals(Sender.State.RETRYING, sender.state());
        assertEquals(0, sender.memoryBatches());
        assertEquals(1, disk.size());
        long retryAt = sender.nextAttemptAtMs();
        assertTrue(retryAt - (now - Sender.MIN_SPACING_MS) >= 5_000);

        // more data arrives while offline: goes to disk behind the backlog
        sender.submit(Kind.METRICS, samples(1, 1));
        sender.submit(Kind.EVENTS, samples(100, 2));
        sender.submit(Kind.METRICS, samples(2, 1));
        sender.pump(now);
        assertEquals(1, api.calls.size(), "no attempt before the backoff expires");
        assertEquals(4, disk.size());

        now = retryAt;
        pump();
        pump();
        pump();
        assertEquals(List.of("metrics", "metrics", "events"), api.calls.stream().map(Call::path).toList());
        assertEquals(3, api.calls.get(1).items(), "all metrics files merged, skipping the events file");
        assertEquals(List.of(0, 1, 2), api.calls.get(1).body().getAsJsonObject("payload").getAsJsonArray("samples").asList().stream()
                .map(e -> e.getAsJsonObject().get("n").getAsInt()).toList(), "order within a kind preserved");
        assertTrue(disk.isEmpty());
        assertEquals(Sender.State.CONNECTED, sender.state());
    }

    @Test
    void splitsOn413() {
        api.script.add(new IngestResult.TooLarge());
        sender.submit(Kind.EVENTS, samples(0, 10));
        pump();
        pump();
        pump();
        assertEquals(10, api.calls.get(0).items());
        assertEquals(5, api.calls.get(1).items());
        assertEquals(5, api.calls.get(2).items());
        assertEquals(0, sender.memoryBatches());
    }

    @Test
    void splitsOn413FromTheDiskBufferToo() throws Exception {
        disk.append(Kind.METRICS, samples(0, 8));
        api.script.add(new IngestResult.TooLarge());
        api.script.add(new IngestResult.TooLarge());
        for (int i = 0; i < 6; i++) pump();
        assertEquals(List.of(8, 4, 2, 4, 2), api.calls.stream().map(Call::items).toList());
        assertTrue(disk.isEmpty());
    }

    @Test
    void dropsASingleItemThatIsTooLargeAndInvalidBatches() {
        api.script.add(new IngestResult.TooLarge());
        api.script.add(new IngestResult.Invalid("bad"));
        sender.submit(Kind.SNAPSHOT, List.of("{\"big\":1}"));
        sender.submit(Kind.EVENTS, samples(0, 3));
        pump();
        pump();
        pump();
        assertEquals(2, api.calls.size());
        assertEquals(0, sender.memoryBatches());
        assertTrue(disk.isEmpty());
    }

    @Test
    void stopsOn401AndKeepsBuffering() {
        api.script.add(new IngestResult.AuthFailed("revoked_key", null));
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        assertEquals(Sender.State.AUTH_FAILED, sender.state());
        sender.submit(Kind.METRICS, samples(1, 1));
        assertFalse(sender.pump(now + 999_999));
        assertEquals(1, api.calls.size(), "never retries with a rejected key");
        assertEquals(2, disk.size());
        assertEquals("revoked_key", sender.lastError(), "status shows the specific reason");
    }

    @Test
    void classifies401Errors() {
        assertEquals(new IngestResult.AuthFailed("invalid_key", "unknown key"),
                IngestResult.classify(401, "{\"error\":\"invalid_key\",\"message\":\"unknown key\"}"));
        assertEquals(new IngestResult.AuthFailed("revoked_key", null), IngestResult.classify(401, "{\"error\":\"revoked_key\"}"));
        assertEquals(new IngestResult.AuthFailed("invalid_key", null), IngestResult.classify(401, "not json"));
    }

    @Test
    void honours429RetryAfter() {
        api.script.add(new IngestResult.RateLimited(60));
        sender.submit(Kind.METRICS, samples(0, 1));
        long t = now;
        pump();
        assertEquals(Sender.State.RATE_LIMITED, sender.state());
        assertTrue(sender.nextAttemptAtMs() >= t + 60_000 && sender.nextAttemptAtMs() <= t + 61_000);
        sender.pump(t + 59_000);
        assertEquals(1, api.calls.size());
        sender.pump(sender.nextAttemptAtMs());
        assertEquals(2, api.calls.size());
        assertTrue(disk.isEmpty());
    }

    @Test
    void appliesRemoteConfig() {
        api.script.add(new IngestResult.Ok(new RemoteConfig(30, null, true)));
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        assertEquals(1, configs.size());
        assertEquals(30, configs.get(0).metricsIntervalSeconds());
        assertTrue(configs.get(0).requestSnapshot());
    }

    @Test
    void respectsContractBatchSizes() {
        sender.submit(Kind.METRICS, samples(0, 150));
        sender.submit(Kind.EVENTS, samples(0, 1200));
        for (int i = 0; i < 10; i++) pump();
        assertEquals(List.of(60, 60, 30, 500, 500, 200), api.calls.stream().map(Call::items).toList());
    }

    @Test
    void shutdownDeliversWhenConnected() {
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        sender.submit(Kind.EVENTS, samples(0, 2));
        sender.submit(Kind.METRICS, samples(1, 1));
        sender.flushOnShutdown(System.currentTimeMillis() + 1_000);
        assertEquals(3, api.calls.size());
        assertTrue(disk.isEmpty());
    }

    @Test
    void shutdownSpillsWhatCannotBeSent() {
        sender.submit(Kind.METRICS, samples(0, 1));
        pump(); // connected
        api.otherwise = new IngestResult.Retryable("down");
        sender.submit(Kind.EVENTS, samples(0, 2));
        sender.flushOnShutdown(System.currentTimeMillis() + 1_000);
        assertEquals(0, sender.memoryBatches());
        assertEquals(1, disk.size());
        assertEquals(2, api.calls.size(), "one attempt, then spill");
    }

    @Test
    void shutdownWhileOfflineDoesNotWaitOnTheNetwork() {
        api.script.add(new IngestResult.Retryable("down"));
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        sender.submit(Kind.EVENTS, samples(0, 2));
        sender.flushOnShutdown(System.currentTimeMillis() + 1_000);
        assertEquals(1, api.calls.size());
        assertEquals(2, disk.size());
    }

    // ---------- review fixes (0.1.1) ----------

    /** Transport whose post blocks until released (a hanging API). */
    static final class HangingApi implements Sender.Transport {
        final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);

        @Override
        public Sender.Sent post(String path, String json) {
            entered.countDown();
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return new Sender.Sent(new IngestResult.Ok(RemoteConfig.NONE), 200, json.length(), 1, 30_000);
        }
    }

    @Test
    void statusSubmitAndShutdownNeverBlockOnAHangingPost() throws Exception {
        HangingApi hang = new HangingApi();
        Sender s = new Sender(hang, disk, new Backoff(new Random(1)), "0.1.1", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77",
                Logger.getLogger("test"), null, false);
        s.submit(Kind.METRICS, samples(0, 1));
        Thread pumper = new Thread(() -> s.pump(now));
        pumper.start();
        assertTrue(hang.entered.await(5, java.util.concurrent.TimeUnit.SECONDS));
        try {
            org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofMillis(500), () -> {
                for (int i = 0; i < 100; i++) s.submit(Kind.EVENTS, samples(i, 1));
                s.memoryBatches();
                s.memoryDropped();
                s.state();
                disk.size();
                disk.totalBytes();
                assertTrue(s.pump(now + 10_000), "a second pump returns at once while one is in flight");
            });
            long t0 = System.currentTimeMillis();
            s.flushOnShutdown(t0 + 300);
            assertTrue(System.currentTimeMillis() - t0 < 1_000, "shutdown flush respects its deadline");
            assertEquals(0, s.memoryBatches(), "memory spilled to disk on shutdown");
        } finally {
            hang.release.countDown();
            pumper.join(5_000);
        }
    }

    @Test
    void newItemsGoStraightToDiskWhileABacklogExists() throws Exception {
        disk.append(Kind.METRICS, samples(0, 1));
        sender.submit(Kind.METRICS, samples(1, 1));
        sender.submit(Kind.EVENTS, samples(2, 1));
        assertEquals(0, sender.memoryBatches());
        assertEquals(3, disk.size());
        pump();
        pump();
        assertEquals(List.of(2, 1), api.calls.stream().map(Call::items).toList());
        assertTrue(disk.isEmpty());
    }

    @Test
    void memoryIsBoundedByBytesAndSpillsToDisk() {
        sender.setMaxMemoryBytes(1_000);
        for (int i = 0; i < 50; i++) sender.submit(Kind.EVENTS, List.of("{\"pad\":\"" + "x".repeat(100) + "\"}"));
        assertTrue(sender.memoryBytes() <= 1_000);
        assertTrue(disk.size() > 0, "spilled, not dropped");
        assertEquals(0, sender.memoryDropped());
        int queued = sender.memoryBatches() + disk.size();
        assertEquals(50, queued);
    }

    @Test
    void memoryDropsOldestWhenOverTheByteBoundAndDiskIsUnwritable(@TempDir Path other) throws Exception {
        Path bufDir = other.resolve("buf");
        DiskBuffer broken = new DiskBuffer(bufDir, 10_000_000);
        java.nio.file.Files.delete(bufDir);
        java.nio.file.Files.writeString(bufDir, "not a directory");
        Sender s = new Sender(api, broken, new Backoff(new Random(1)), "0.1.1", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77",
                Logger.getLogger("test"), null, false);
        s.setMaxMemoryBytes(1_000);
        for (int i = 0; i < 50; i++) s.submit(Kind.EVENTS, List.of("{\"pad\":\"" + "x".repeat(100) + "\"}"));
        assertTrue(s.memoryBytes() <= 1_000);
        assertTrue(s.memoryDropped() > 0);
    }

    @Test
    void corruptBufferFilesDoNotWedgeTheQueue() throws Exception {
        java.nio.file.Files.write(dir.resolve("0000000000000001.metrics.jsonl"), new byte[] {'{', (byte) 0xC3, (byte) 0x28, '}', '\n'});
        java.nio.file.Files.writeString(dir.resolve("0000000000000002.metrics.jsonl"), "{\"n\":1}\n{\"n\":2}\n{\"n\":3,\"tru");
        java.nio.file.Files.writeString(dir.resolve("0000000000000003.events.jsonl"), "garbage\n");
        disk = new DiskBuffer(dir, 10_000_000);
        sender = new Sender(api, disk, new Backoff(new Random(1)), "0.1.1", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77",
                Logger.getLogger("test"), null, false);
        for (int i = 0; i < 5; i++) pump();
        assertEquals(1, api.calls.size(), "only the valid lines are sent; the all-garbage file is cleaned up");
        assertEquals(2, api.calls.get(0).items());
        assertEquals(2, sender.droppedCorruptLines());
        assertTrue(disk.isEmpty());
    }

    @Test
    void drainsAnInterleavedOutageBacklogQuickly() throws Exception {
        // like the Pi field test: ~1.5 h offline -> ~530 files, metrics and events interleaved
        int metrics = 0;
        int events = 0;
        for (int i = 0; i < 532; i++) {
            if (i % 2 == 0) disk.append(Kind.METRICS, samples(metrics++, 1));
            else disk.append(Kind.EVENTS, samples(events++, 1));
        }
        int pumps = 0;
        while (!disk.isEmpty() && pumps++ < 100) pump();
        assertTrue(disk.isEmpty());
        // 266 metrics at 60/request = 5, 266 events at 500/request = 1
        assertEquals(6, api.calls.size());
        List<Integer> seen = new ArrayList<>();
        for (Call c : api.calls) {
            if (!c.path().equals("metrics")) continue;
            c.body().getAsJsonObject("payload").getAsJsonArray("samples").forEach(e -> seen.add(e.getAsJsonObject().get("n").getAsInt()));
        }
        List<Integer> expected = new ArrayList<>();
        for (int i = 0; i < metrics; i++) expected.add(i);
        assertEquals(expected, seen, "every metric delivered once, in order");
    }

    @Test
    void bodyLimitCountsUtf8Bytes() {
        String item = "{\"m\":\"" + "é".repeat(100_000) + "\"}"; // ~100k chars, ~200 KB UTF-8
        sender.submit(Kind.EVENTS, List.of(item, item, item, item, item, item));
        pump();
        pump();
        assertEquals(List.of(4, 2), api.calls.stream().map(Call::items).toList());
        assertEquals(200_008, Sender.utf8Length(item));
        assertEquals(4, Sender.utf8Length("\uD83D\uDE00"));
    }

    @Test
    void insecureUrlStopsSending() {
        api.script.add(new IngestResult.InsecureUrl("http to public host"));
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        assertEquals(Sender.State.INSECURE_URL, sender.state());
        assertFalse(sender.pump(now + 999_999));
        assertEquals(1, api.calls.size());
        assertEquals(1, disk.size());
    }

    @Test
    void shutdownFlushesThenClosesTheTransport() {
        sender.submit(Kind.METRICS, samples(0, 1));
        pump();
        sender.submit(Kind.METRICS, samples(1, 1));
        sender.shutdown(System.currentTimeMillis() + 2_000);
        assertEquals(1, api.closed, "closed exactly once");
        assertEquals(2, api.callsWhenClosed, "closed after the final flush");
        assertEquals(0, sender.memoryBatches());
    }

    @Test
    void interruptedSendIsANoOp() {
        List<java.util.logging.LogRecord> logged = new ArrayList<>();
        Logger quiet = Logger.getLogger("test.interrupted");
        quiet.setUseParentHandlers(false);
        quiet.addHandler(new java.util.logging.Handler() {
            @Override
            public void publish(java.util.logging.LogRecord r) {
                logged.add(r);
            }

            @Override
            public void flush() {}

            @Override
            public void close() {}
        });
        Sender s = new Sender(api, disk, new Backoff(new Random(1)), "0.1.0", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77", quiet, null, false);
        s.submit(Kind.METRICS, samples(0, 1));
        s.pump(now);
        assertEquals(Sender.State.CONNECTED, s.state());
        s.submit(Kind.METRICS, samples(1, 1));
        api.script.add(new IngestResult.Interrupted());
        s.pump(now + Sender.MIN_SPACING_MS);
        assertEquals(Sender.State.CONNECTED, s.state(), "state unchanged");
        assertEquals(null, s.lastError());
        assertEquals(0, s.memoryBatches());
        assertEquals(1, disk.size(), "moved to the disk buffer, not lost");
        assertTrue(logged.isEmpty(), "nothing logged");
        s.shutdown(System.currentTimeMillis() + 500);
        assertEquals(1, disk.size(), "still on disk after shutdown: sent after the restart");
        // next run delivers it
        Sender next = new Sender(api, disk, new Backoff(new Random(1)), "0.1.0", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77", quiet, null, false);
        next.pump(now + 10 * Sender.MIN_SPACING_MS);
        assertTrue(disk.isEmpty());
        assertEquals("{\"n\":1}", api.calls.get(api.calls.size() - 1).body().getAsJsonObject("payload").getAsJsonArray("samples").get(0).toString());
    }

    @Test
    void diskWriteFailureWarningIsRateLimited(@TempDir Path other) throws Exception {
        Path bufDir = other.resolve("buf");
        DiskBuffer broken = new DiskBuffer(bufDir, 10_000_000);
        java.nio.file.Files.delete(bufDir);
        java.nio.file.Files.writeString(bufDir, "not a directory");
        List<java.util.logging.LogRecord> logged = new ArrayList<>();
        Logger l = Logger.getLogger("test.diskwarn");
        l.setUseParentHandlers(false);
        l.addHandler(new java.util.logging.Handler() {
            @Override
            public void publish(java.util.logging.LogRecord r) {
                logged.add(r);
            }

            @Override
            public void flush() {}

            @Override
            public void close() {}
        });
        long[] clock = {1_000_000};
        api.otherwise = new IngestResult.Retryable("down");
        Sender s = new Sender(api, broken, new Backoff(new Random(1)), "0.1.0", "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77", l, null, false);
        s.setClock(() -> clock[0]);
        s.setMaxMemoryBytes(500);
        for (int i = 0; i < 30; i++) s.submit(Kind.EVENTS, List.of("{\"pad\":\"" + "x".repeat(100) + "\"}"));
        long diskWarnings = logged.stream().filter(r -> r.getMessage().contains("could not write the buffer")).count();
        assertEquals(1, diskWarnings, "first failure only");
        assertTrue(s.diskWriteFailures() > 5, "failures: " + s.diskWriteFailures());
        assertTrue(logged.stream().allMatch(r -> r.getThrown() == null), "no stack traces");
        clock[0] += Sender.DISK_WARN_INTERVAL_MS - 1;
        s.submit(Kind.EVENTS, List.of("{\"pad\":\"" + "y".repeat(600) + "\"}")); // over the bound: spill is tried
        assertEquals(1, logged.stream().filter(r -> r.getMessage().contains("could not write the buffer")).count());
        clock[0] += 1;
        s.submit(Kind.EVENTS, List.of("{\"pad\":\"" + "y".repeat(600) + "\"}")); // over the bound: spill is tried
        List<String> warnings = logged.stream().map(java.util.logging.LogRecord::getMessage).filter(m -> m.contains("could not write the buffer")).toList();
        assertEquals(2, warnings.size(), "again after 5 min");
        assertTrue(warnings.get(1).contains("more failure(s) since the last warning"), warnings.get(1));
    }
}
