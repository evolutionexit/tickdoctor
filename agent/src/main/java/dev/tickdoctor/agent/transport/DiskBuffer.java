package dev.tickdoctor.agent.transport;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.stream.Stream;
import com.google.gson.JsonParser;

/**
 * Bounded on-disk FIFO of unsent batches in the plugin data folder. One file per batch,
 * {@code <seq>.<kind>.jsonl}, one JSON item per line, written atomically. When the total size
 * exceeds the limit the oldest files are deleted first. Survives restarts. Thread-safe.
 */
public final class DiskBuffer {
    public record Entry(Path file, long seq, Kind kind, long bytes) {}

    /** Valid lines of an entry, and how many corrupt lines were skipped. */
    public record ReadResult(List<String> lines, int dropped) {}

    private final Path dir;
    private volatile long maxBytes;
    private final Deque<Entry> entries = new ArrayDeque<>();
    // written under the monitor, read lock-free by status
    private volatile long totalBytes;
    private volatile int size;
    private long nextSeq;
    private volatile long droppedFiles;

    public DiskBuffer(Path dir, long maxBytes) throws IOException {
        this.dir = dir;
        this.maxBytes = maxBytes;
        dev.tickdoctor.agent.util.FilePerms.createPrivateDirectories(dir); // new dirs 700
        List<Entry> found = new ArrayList<>();
        try (Stream<Path> s = Files.list(dir)) {
            for (Path p : s.toList()) {
                String n = p.getFileName().toString();
                if (n.endsWith(".tmp")) {
                    Files.deleteIfExists(p);
                    continue;
                }
                String[] parts = n.split("\\.");
                Kind k = parts.length == 3 && parts[2].equals("jsonl") ? Kind.fromPath(parts[1]) : null;
                long seq;
                try {
                    seq = Long.parseLong(parts[0]);
                } catch (NumberFormatException e) {
                    k = null;
                    seq = -1;
                }
                if (k == null) {
                    Files.deleteIfExists(p);
                    continue;
                }
                found.add(new Entry(p, seq, k, Files.size(p)));
            }
        }
        found.sort((a, b) -> Long.compare(a.seq, b.seq));
        for (Entry e : found) {
            entries.add(e);
            totalBytes += e.bytes;
            nextSeq = Math.max(nextSeq, e.seq + 1);
        }
        size = entries.size();
        evict();
    }

    public synchronized void setMaxBytes(long max) {
        this.maxBytes = max;
        evict();
    }

    /** Appends a batch as one file (items must be single-line JSON). */
    public synchronized void append(Kind kind, List<String> items) throws IOException {
        if (items.isEmpty()) return;
        long seq = nextSeq++;
        Path file = dir.resolve(String.format("%016d.%s.jsonl", seq, kind.path));
        byte[] data = (String.join("\n", items) + "\n").getBytes(StandardCharsets.UTF_8);
        write(file, data);
        entries.addLast(new Entry(file, seq, kind, data.length));
        totalBytes += data.length;
        size = entries.size();
        evict();
    }

    /** Lock-free. */
    public boolean isEmpty() {
        return size == 0;
    }

    public synchronized Entry peekFirst() {
        return entries.peekFirst();
    }

    /** Snapshot of the queue, oldest first. */
    public synchronized List<Entry> entries() {
        return List.copyOf(entries);
    }

    /**
     * Reads an entry. Throws on I/O errors and invalid UTF-8 (the caller discards the entry);
     * lines that are not a JSON object (e.g. truncated by a power loss) are skipped individually.
     */
    public static ReadResult read(Entry e) throws IOException {
        List<String> out = new ArrayList<>();
        int dropped = 0;
        for (String line : Files.readAllLines(e.file, StandardCharsets.UTF_8)) {
            if (line.isBlank()) continue;
            if (isJsonObject(line)) out.add(line);
            else dropped++;
        }
        return new ReadResult(out, dropped);
    }

    static boolean isJsonObject(String line) {
        try {
            return JsonParser.parseString(line).isJsonObject();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /** Deletes an entry (sent or dropped). No-op if it was already evicted. */
    public synchronized void remove(Entry e) {
        if (entries.remove(e)) {
            totalBytes -= e.bytes;
            size = entries.size();
            delete(e.file);
        }
    }

    /** Replaces an entry's items with the unsent remainder (after a partial send). */
    public synchronized void replace(Entry e, List<String> remaining) throws IOException {
        if (!entries.contains(e)) return;
        if (remaining.isEmpty()) {
            remove(e);
            return;
        }
        byte[] data = (String.join("\n", remaining) + "\n").getBytes(StandardCharsets.UTF_8);
        write(e.file, data);
        List<Entry> copy = new ArrayList<>(entries);
        int idx = copy.indexOf(e);
        Entry updated = new Entry(e.file, e.seq, e.kind, data.length);
        copy.set(idx, updated);
        entries.clear();
        entries.addAll(copy);
        totalBytes += data.length - e.bytes;
    }

    /** Lock-free. */
    public long totalBytes() {
        return totalBytes;
    }

    /** Lock-free. */
    public int size() {
        return size;
    }

    /** Lock-free. */
    public long droppedFiles() {
        return droppedFiles;
    }

    private void evict() {
        while (totalBytes > maxBytes && !entries.isEmpty()) {
            Entry e = entries.pollFirst();
            totalBytes -= e.bytes;
            droppedFiles++;
            size = entries.size();
            delete(e.file);
        }
    }

    private static void write(Path file, byte[] data) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        dev.tickdoctor.agent.util.FilePerms.writePrivate(tmp, data); // batches are created 600
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void delete(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignored) {
            // a leftover file is simply re-sent after the next restart
        }
    }
}
