package dev.tickdoctor.agent.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DiskBufferTest {
    @TempDir
    Path dir;

    private static String item(int i, int size) {
        return "{\"i\":" + i + ",\"pad\":\"" + "x".repeat(size) + "\"}";
    }

    @Test
    void fifoAndPersistence() throws Exception {
        DiskBuffer b = new DiskBuffer(dir, 1_000_000);
        b.append(Kind.METRICS, List.of(item(1, 1), item(2, 1)));
        b.append(Kind.EVENTS, List.of(item(3, 1)));
        b.append(Kind.METRICS, List.of(item(4, 1)));
        assertEquals(3, b.size());

        DiskBuffer reopened = new DiskBuffer(dir, 1_000_000);
        List<DiskBuffer.Entry> e = reopened.entries();
        assertEquals(List.of(Kind.METRICS, Kind.EVENTS, Kind.METRICS), e.stream().map(DiskBuffer.Entry::kind).toList());
        assertEquals(List.of(item(1, 1), item(2, 1)), DiskBuffer.read(e.get(0)).lines());
        assertEquals(b.totalBytes(), reopened.totalBytes());

        reopened.append(Kind.SNAPSHOT, List.of(item(5, 1)));
        assertTrue(reopened.entries().get(3).seq() > e.get(2).seq(), "sequence continues after restart");
    }

    @Test
    void evictsOldestFirstWhenOverTheLimit() throws Exception {
        DiskBuffer b = new DiskBuffer(dir, 3_500);
        for (int i = 0; i < 10; i++) b.append(Kind.METRICS, List.of(item(i, 1000)));
        assertTrue(b.totalBytes() <= 3_500, "total " + b.totalBytes());
        assertEquals(3, b.size());
        assertEquals(7, b.droppedFiles());
        // the newest three survive
        assertEquals(List.of(item(7, 1000)), DiskBuffer.read(b.peekFirst()).lines());
        try (var s = Files.list(dir)) {
            assertEquals(3, s.count());
        }
    }

    @Test
    void shrinkingTheLimitEvicts() throws Exception {
        DiskBuffer b = new DiskBuffer(dir, 100_000);
        for (int i = 0; i < 10; i++) b.append(Kind.EVENTS, List.of(item(i, 1000)));
        b.setMaxBytes(2_100);
        assertEquals(2, b.size());
    }

    @Test
    void anOversizedBatchIsDroppedImmediately() throws Exception {
        DiskBuffer b = new DiskBuffer(dir, 500);
        b.append(Kind.SNAPSHOT, List.of(item(1, 2000)));
        assertTrue(b.isEmpty());
        assertEquals(0, b.totalBytes());
    }

    @Test
    void removeAndReplace() throws Exception {
        DiskBuffer b = new DiskBuffer(dir, 1_000_000);
        b.append(Kind.METRICS, List.of(item(1, 1), item(2, 1), item(3, 1)));
        DiskBuffer.Entry e = b.peekFirst();
        b.replace(e, List.of(item(3, 1)));
        assertEquals(List.of(item(3, 1)), DiskBuffer.read(b.peekFirst()).lines());
        assertEquals(Files.size(b.peekFirst().file()), b.totalBytes());
        b.remove(b.peekFirst());
        assertTrue(b.isEmpty());
        assertEquals(0, b.totalBytes());
        b.remove(e); // already gone: no-op
        assertEquals(0, b.totalBytes());
    }

    @Test
    void cleansUpTempAndForeignFiles() throws Exception {
        Files.writeString(dir.resolve("0000000000000001.metrics.jsonl.tmp"), "half");
        Files.writeString(dir.resolve("notes.txt"), "?");
        Files.writeString(dir.resolve("0000000000000002.metrics.jsonl"), item(1, 1) + "\n");
        DiskBuffer b = new DiskBuffer(dir, 1_000_000);
        assertEquals(1, b.size());
        assertFalse(Files.exists(dir.resolve("notes.txt")));
        assertFalse(Files.exists(dir.resolve("0000000000000001.metrics.jsonl.tmp")));
    }

    @Test
    void readSkipsCorruptLinesAndThrowsOnInvalidUtf8() throws Exception {
        Files.writeString(dir.resolve("0000000000000001.events.jsonl"), item(1, 1) + "\nnot json\n" + item(2, 1) + "\n{\"trunc");
        Files.write(dir.resolve("0000000000000002.events.jsonl"), new byte[] {'{', (byte) 0xFF, '}', '\n'});
        DiskBuffer b = new DiskBuffer(dir, 1_000_000);
        DiskBuffer.ReadResult r = DiskBuffer.read(b.entries().get(0));
        assertEquals(List.of(item(1, 1), item(2, 1)), r.lines());
        assertEquals(2, r.dropped());
        org.junit.jupiter.api.Assertions.assertThrows(java.io.IOException.class, () -> DiskBuffer.read(b.entries().get(1)));
    }
}
