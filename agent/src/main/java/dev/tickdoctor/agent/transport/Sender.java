package dev.tickdoctor.agent.transport;

import dev.tickdoctor.agent.util.Iso;
import java.io.IOException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Delivery state machine. Collectors {@link #submit} items; the sender thread calls {@link #pump}
 * about once a second. Memory first; on any failure everything pending spills to the bounded
 * {@link DiskBuffer}, which is drained oldest-first once the API is reachable again. While the
 * disk buffer is non-empty new items go straight to disk (one bound, order preserved). At most one
 * request per {@link #MIN_SPACING_MS} keeps a backlog flush under the API's ~30 req/min limit.
 *
 * <p>Locking: no lock or monitor is ever held across {@link Transport#post}. {@link #submit} and
 * all status getters are lock-free; {@link #pump} and {@link #flushOnShutdown} are serialized by a
 * non-blocking "busy" flag, so a hanging request can never stall the caller of another method.
 */
public final class Sender {
    public static final long MIN_SPACING_MS = 2_100;
    /** Uncompressed UTF-8 JSON per request stays under this (API limit 1 MB). */
    static final int MAX_BODY_BYTES = 900_000;
    /** In-memory queue bound (UTF-8 bytes of the items); beyond it items spill to disk. */
    static final long DEFAULT_MAX_MEMORY_BYTES = 8L * 1024 * 1024;
    /** "Disk buffer not writable" is logged on the first failure, then at most this often. */
    static final long DISK_WARN_INTERVAL_MS = 5 * 60_000L;

    public enum State { CONNECTING, CONNECTED, RETRYING, RATE_LIMITED, PLAN_LIMIT, AUTH_FAILED, INSECURE_URL }

    public interface Transport {
        Sent post(String path, String json);

        /** Shorter request timeout for the final flush on shutdown. */
        default void setTimeout(java.time.Duration d) {}

        /** Releases the transport's resources (HTTP client threads and connections). */
        default void close() {}
    }

    public record Sent(IngestResult result, int status, int rawBytes, int gzBytes, long millis) {}

    /** Identity semantics on purpose (no record): a queued batch is one specific object. */
    private static final class Pending {
        final Kind kind;
        final List<String> items;
        final long bytes;

        Pending(Kind kind, List<String> items) {
            this.kind = kind;
            this.items = items;
            long b = 0;
            for (String s : items) b += utf8Length(s);
            this.bytes = b;
        }
    }

    private interface Batch {
        Kind kind();

        List<String> items();

        /** Sent (or dropped for good). */
        void commit() throws IOException;

        /** Not sent; put it back where it came from. */
        void restore();
    }

    private final Transport transport;
    private final DiskBuffer disk;
    private final Backoff backoff;
    private final String agentVersion;
    private final String bootId;
    private final Logger log;
    private final Consumer<RemoteConfig> onConfig;
    private volatile boolean debug;
    private volatile long maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES;

    private final ConcurrentLinkedDeque<Pending> memory = new ConcurrentLinkedDeque<>();
    private final AtomicInteger memoryCount = new AtomicInteger();
    private final AtomicLong memoryBytes = new AtomicLong();
    private final AtomicLong memoryDropped = new AtomicLong();
    private final AtomicLong droppedLines = new AtomicLong();
    private final AtomicLong diskWriteFailures = new AtomicLong();
    private final AtomicLong diskFailuresAtLastWarn = new AtomicLong();
    private final AtomicLong lastDiskWarnMs = new AtomicLong(Long.MIN_VALUE);
    private volatile java.util.function.LongSupplier clock = System::currentTimeMillis;
    private final AtomicBoolean busy = new AtomicBoolean();

    // guarded by `busy`
    private final EnumMap<Kind, Integer> limit = new EnumMap<>(Kind.class);
    private long lastRequestMs;

    private volatile String pendingHello;
    private volatile State state = State.CONNECTING;
    private volatile long lastPushMs;
    private volatile String lastError;
    private volatile long nextAttemptAtMs;

    public Sender(Transport transport, DiskBuffer disk, Backoff backoff, String agentVersion, String bootId,
                  Logger log, Consumer<RemoteConfig> onConfig, boolean debug) {
        this.transport = transport;
        this.disk = disk;
        this.backoff = backoff;
        this.agentVersion = agentVersion;
        this.bootId = bootId;
        this.log = log;
        this.onConfig = onConfig;
        this.debug = debug;
        for (Kind k : Kind.values()) limit.put(k, k.maxItems);
    }

    public void setDebug(boolean d) {
        debug = d;
    }

    void setMaxMemoryBytes(long max) {
        maxMemoryBytes = max;
    }

    void setClock(java.util.function.LongSupplier c) {
        clock = c;
    }

    /** Thread-safe and lock-free with respect to sending. Items are compact single-line JSON. */
    public void submit(Kind kind, List<String> items) {
        for (int i = 0; i < items.size(); i += kind.maxItems) {
            Pending p = new Pending(kind, List.copyOf(items.subList(i, Math.min(items.size(), i + kind.maxItems))));
            if (!disk.isEmpty() && memory.isEmpty() && toDisk(p)) continue; // behind the backlog
            addLast(p);
        }
        if (memoryBytes.get() > maxMemoryBytes) {
            spill();
            // disk not writable: drop the oldest until under the bound
            while (memoryBytes.get() > maxMemoryBytes) {
                Pending p = pollFirst();
                if (p == null) break;
                memoryDropped.incrementAndGet();
            }
        }
    }

    /** The latest hello; sent before anything else and re-sent from memory, never buffered. */
    public void setHello(String helloJson) {
        pendingHello = helloJson;
    }

    /**
     * Sends at most one request. Returns false once sending has stopped for good (401 / refused
     * URL), true otherwise. Returns immediately if another pump/flush is in progress.
     */
    public boolean pump(long nowMs) {
        if (!busy.compareAndSet(false, true)) return !stopped();
        try {
            return pumpOnce(nowMs);
        } finally {
            busy.set(false);
        }
    }

    private boolean stopped() {
        return state == State.AUTH_FAILED || state == State.INSECURE_URL;
    }

    private boolean pumpOnce(long nowMs) {
        if (stopped()) {
            spill();
            return false;
        }
        if (nowMs < nextAttemptAtMs) {
            spill();
            return true;
        }
        if (nowMs - lastRequestMs < MIN_SPACING_MS) return true;

        String hello = pendingHello;
        if (hello != null) {
            lastRequestMs = nowMs;
            Sent s = transport.post("hello", envelope(hello));
            summarize("hello", 1, s, hello);
            switch (s.result()) {
                case IngestResult.Ok ok -> {
                    if (pendingHello == hello) pendingHello = null;
                    succeeded(nowMs, ok.config());
                }
                case IngestResult.Invalid inv -> {
                    if (pendingHello == hello) pendingHello = null;
                    log.warning("API rejected the server info as invalid (" + inv.message() + "); not retrying it.");
                }
                case IngestResult.TooLarge tl -> {
                    if (pendingHello == hello) pendingHello = null;
                    log.warning("server info too large for the API; dropped.");
                }
                case IngestResult.Interrupted i -> lastRequestMs = 0; // hello stays pending
                default -> failed(nowMs, s.result());
            }
            return !stopped();
        }

        if (!disk.isEmpty()) spill(); // stragglers that raced into memory go behind the backlog
        Batch b = nextBatch();
        if (b == null) return true;
        lastRequestMs = nowMs;
        Kind kind = b.kind();
        List<String> items = b.items();
        Sent s = transport.post(kind.path, envelope(kind, items));
        summarize(kind.path, items.size(), s, items.get(items.size() - 1));
        switch (s.result()) {
            case IngestResult.Ok ok -> {
                commit(b);
                int l = limit.get(kind);
                if (l < kind.maxItems) limit.put(kind, Math.min(kind.maxItems, l * 2));
                succeeded(nowMs, ok.config());
            }
            case IngestResult.TooLarge tl -> {
                if (items.size() > 1) {
                    b.restore();
                    limit.put(kind, Math.max(1, items.size() / 2));
                    lastRequestMs = 0; // retry the smaller batch right away
                } else {
                    commit(b);
                    log.warning("a single " + kind.path + " item is too large for the API; dropped.");
                }
            }
            case IngestResult.Invalid inv -> {
                commit(b);
                lastError = "invalid_payload: " + inv.message();
                log.warning("API rejected a " + kind.path + " batch of " + items.size() + " as invalid (" + inv.message() + "); dropped it.");
            }
            case IngestResult.Interrupted i -> {
                b.restore(); // stopping: no log, no state change; to disk so a closing client can't lose it
                spill();
                lastRequestMs = 0;
            }
            default -> {
                b.restore();
                failed(nowMs, s.result());
            }
        }
        return !stopped();
    }

    /**
     * On shutdown: if the API was reachable a moment ago, try to deliver what is in memory until
     * the deadline (short timeouts); everything else is spilled to disk and sent after restart.
     * Never waits past the deadline, even if a request is still hanging on another thread.
     */
    public void flushOnShutdown(long deadlineMs) {
        boolean acquired = busy.compareAndSet(false, true);
        while (!acquired && System.currentTimeMillis() < deadlineMs) {
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            acquired = busy.compareAndSet(false, true);
        }
        try {
            long budget = deadlineMs - System.currentTimeMillis();
            if (acquired && state == State.CONNECTED && disk.isEmpty() && budget > 0) {
                transport.setTimeout(java.time.Duration.ofMillis(Math.max(250, budget)));
                while (System.currentTimeMillis() < deadlineMs && !memory.isEmpty()) {
                    lastRequestMs = 0;
                    nextAttemptAtMs = 0;
                    int before = memoryCount.get();
                    long beforeBytes = memoryBytes.get();
                    pumpOnce(System.currentTimeMillis());
                    if (memoryCount.get() >= before && memoryBytes.get() >= beforeBytes) break; // failed or spilled
                }
            }
            spill();
        } finally {
            if (acquired) busy.set(false);
        }
    }

    /**
     * End of life: {@link #flushOnShutdown} until the deadline, then closes the transport. The
     * Sender must not be pumped afterwards.
     */
    public void shutdown(long deadlineMs) {
        try {
            flushOnShutdown(deadlineMs);
        } finally {
            close();
        }
    }

    /** Closes the transport (idempotent as far as the transport is). */
    public void close() {
        try {
            transport.close();
        } catch (RuntimeException e) {
            log.log(Level.FINE, "could not close the HTTP client", e);
        }
    }

    private void succeeded(long nowMs, RemoteConfig cfg) {
        backoff.reset();
        state = State.CONNECTED;
        lastPushMs = nowMs;
        lastError = null;
        nextAttemptAtMs = 0;
        if (cfg != null && cfg != RemoteConfig.NONE && onConfig != null) {
            try {
                onConfig.accept(cfg);
            } catch (RuntimeException e) {
                log.log(Level.WARNING, "could not apply remote config", e);
            }
        }
    }

    private void failed(long nowMs, IngestResult r) {
        spill();
        switch (r) {
            case IngestResult.AuthFailed a -> {
                state = State.AUTH_FAILED;
                lastError = a.error();
                log.severe("============================================================");
                log.severe("the API rejected the api-key (" + a.error() + (a.message() != null ? ": " + a.message() : "") + ").");
                log.severe("sending is STOPPED. Data keeps buffering on disk (bounded).");
                log.severe("fix api-key in plugins/TickDoctor/config.yml, then run /tickdoctor reload.");
                log.severe("============================================================");
            }
            case IngestResult.InsecureUrl iu -> {
                state = State.INSECURE_URL;
                lastError = "insecure_url";
                log.severe(iu.message() + " Sending is STOPPED; data keeps buffering on disk. Use an https:// api-url, then /tickdoctor reload.");
            }
            case IngestResult.RateLimited rl -> {
                state = State.RATE_LIMITED;
                lastError = "rate_limited";
                nextAttemptAtMs = nowMs + backoff.retryAfterMs(rl.retryAfterSeconds());
            }
            case IngestResult.PlanLimit pl -> {
                if (state != State.PLAN_LIMIT) log.warning("plan limit reached (" + pl.message() + "); buffering and retrying later.");
                state = State.PLAN_LIMIT;
                lastError = "plan_limit";
                nextAttemptAtMs = nowMs + backoff.nextDelayMs();
            }
            case IngestResult.Retryable rt -> {
                if (state == State.CONNECTED || backoff.failures() == 0) log.warning("API unreachable (" + rt.reason() + "); buffering and retrying with backoff.");
                state = State.RETRYING;
                lastError = rt.reason();
                nextAttemptAtMs = nowMs + backoff.nextDelayMs();
            }
            default -> {
                state = State.RETRYING;
                nextAttemptAtMs = nowMs + backoff.nextDelayMs();
            }
        }
    }

    // ---------- memory queue ----------

    private void addLast(Pending p) {
        memory.addLast(p);
        memoryCount.incrementAndGet();
        memoryBytes.addAndGet(p.bytes);
    }

    private void addFirst(Pending p) {
        memory.addFirst(p);
        memoryCount.incrementAndGet();
        memoryBytes.addAndGet(p.bytes);
    }

    private Pending pollFirst() {
        Pending p = memory.pollFirst();
        if (p != null) {
            memoryCount.decrementAndGet();
            memoryBytes.addAndGet(-p.bytes);
        }
        return p;
    }

    private boolean toDisk(Pending p) {
        try {
            disk.append(p.kind, p.items);
            return true;
        } catch (IOException e) {
            long failures = diskWriteFailures.incrementAndGet();
            long now = clock.getAsLong();
            long last = lastDiskWarnMs.get();
            boolean due = last == Long.MIN_VALUE || now - last >= DISK_WARN_INTERVAL_MS;
            if (due && lastDiskWarnMs.compareAndSet(last, now)) { // one thread logs, no stack trace
                long since = failures - diskFailuresAtLastWarn.getAndSet(failures) - 1;
                log.warning("could not write the buffer to disk (" + e.getClass().getSimpleName()
                        + (e.getMessage() != null ? ": " + e.getMessage() : "") + "); keeping it in memory"
                        + (since > 0 ? " (" + since + " more failure(s) since the last warning)" : "")
                        + ". Repeats are logged at most every 5 min; see /tickdoctor status.");
            }
            return false;
        }
    }

    /** Moves everything in memory to disk, oldest first. Safe from any thread. */
    private void spill() {
        Pending p;
        while ((p = pollFirst()) != null) {
            if (!toDisk(p)) {
                addFirst(p);
                return;
            }
        }
    }

    private void commit(Batch b) {
        try {
            b.commit();
        } catch (IOException e) {
            log.log(Level.WARNING, "could not update the disk buffer", e);
        }
    }

    // ---------- batching ----------

    private Batch nextBatch() {
        if (!disk.isEmpty()) {
            Batch b = diskBatch();
            if (b != null) return b;
            if (!disk.isEmpty()) return null; // cleaned up unreadable entries; next pump
        }
        if (!memory.isEmpty()) return memoryBatch();
        return null;
    }

    /** Takes the batch out of memory; {@link Batch#restore} puts it back at the front. */
    private Batch memoryBatch() {
        Pending head = pollFirst();
        if (head == null) return null;
        Kind kind = head.kind;
        int max = limit.get(kind);
        List<Pending> taken = new ArrayList<>();
        List<String> items = new ArrayList<>();
        long bytes = 0;
        Pending p = head;
        while (p != null) {
            if (p.kind != kind) {
                addFirst(p);
                break;
            }
            int fits = fit(p.items, items.size(), max, bytes);
            if (fits == p.items.size()) {
                for (String s : p.items) bytes += utf8Length(s);
                items.addAll(p.items);
                taken.add(p);
                p = pollFirst();
                continue;
            }
            if (items.isEmpty()) {
                int n = Math.max(1, fits);
                Pending first = new Pending(kind, List.copyOf(p.items.subList(0, n)));
                Pending rest = new Pending(kind, List.copyOf(p.items.subList(n, p.items.size())));
                items.addAll(first.items);
                taken.add(first);
                addFirst(rest);
            } else {
                addFirst(p);
            }
            break;
        }
        return new Batch() {
            public Kind kind() {
                return kind;
            }

            public List<String> items() {
                return items;
            }

            public void commit() {}

            public void restore() {
                for (int i = taken.size() - 1; i >= 0; i--) addFirst(taken.get(i));
            }
        };
    }

    /**
     * The first entries of the head entry's kind (other kinds are skipped, not a barrier: cross-kind
     * order does not matter). Unreadable entries are quarantined (deleted) on the way.
     */
    private Batch diskBatch() {
        List<DiskBuffer.Entry> entries = disk.entries();
        if (entries.isEmpty()) return null;
        Kind kind = null;
        int max = 0;
        List<String> items = new ArrayList<>();
        List<DiskBuffer.Entry> full = new ArrayList<>();
        DiskBuffer.Entry partialEntry = null;
        List<String> partialRest = null;
        long bytes = 0;
        for (DiskBuffer.Entry e : entries) {
            if (kind != null && e.kind() != kind) continue;
            DiskBuffer.ReadResult r;
            try {
                r = DiskBuffer.read(e);
            } catch (IOException ex) {
                log.warning("buffered file " + e.file().getFileName() + " is unreadable (" + ex.getClass().getSimpleName()
                        + "); discarding it.");
                disk.remove(e);
                continue;
            }
            if (r.dropped() > 0) {
                droppedLines.addAndGet(r.dropped());
                log.warning("dropped " + r.dropped() + " corrupt line(s) from buffered file " + e.file().getFileName() + ".");
            }
            List<String> lines = r.lines();
            if (kind == null) {
                kind = e.kind();
                max = limit.get(kind);
            }
            if (lines.isEmpty()) {
                full.add(e);
                continue;
            }
            int fits = fit(lines, items.size(), max, bytes);
            if (fits == lines.size()) {
                for (String s : lines) bytes += utf8Length(s);
                items.addAll(lines);
                full.add(e);
                if (items.size() >= max) break;
                continue;
            }
            if (items.isEmpty()) {
                int n = Math.max(1, fits);
                items.addAll(lines.subList(0, n));
                partialEntry = e;
                partialRest = List.copyOf(lines.subList(n, lines.size()));
            }
            break;
        }
        if (items.isEmpty()) {
            // only empty / fully corrupt files: clean them up and look again next pump
            for (DiskBuffer.Entry e : full) disk.remove(e);
            return null;
        }
        final Kind k = kind;
        final DiskBuffer.Entry pe = partialEntry;
        final List<String> pr = partialRest;
        return new Batch() {
            public Kind kind() {
                return k;
            }

            public List<String> items() {
                return items;
            }

            public void commit() throws IOException {
                for (DiskBuffer.Entry e : full) disk.remove(e);
                if (pe != null) disk.replace(pe, pr);
            }

            public void restore() {}
        };
    }

    /** How many of {@code next} fit after {@code have} items / {@code bytes} UTF-8 bytes. */
    private static int fit(List<String> next, int have, int max, long bytes) {
        int n = 0;
        for (String s : next) {
            int len = utf8Length(s);
            if (have + n + 1 > max || bytes + len > MAX_BODY_BYTES) break;
            bytes += len;
            n++;
        }
        return n;
    }

    /** UTF-8 encoded length without allocating. */
    static int utf8Length(String s) {
        int n = 0;
        for (int i = 0, len = s.length(); i < len; i++) {
            char c = s.charAt(i);
            if (c < 0x80) n++;
            else if (c < 0x800) n += 2;
            else if (Character.isHighSurrogate(c) && i + 1 < len && Character.isLowSurrogate(s.charAt(i + 1))) {
                n += 4;
                i++;
            } else n += 3;
        }
        return n;
    }

    private String envelope(String payloadJson) {
        return Envelopes.wrap(payloadJson, agentVersion, Iso.now(), bootId);
    }

    private String envelope(Kind kind, List<String> items) {
        return Envelopes.wrap(kind, items, agentVersion, Iso.now(), bootId);
    }

    private void summarize(String path, int count, Sent s, String lastItem) {
        if (!debug) return;
        String extra = "";
        try {
            extra = PayloadSummary.describe(path, lastItem);
        } catch (RuntimeException ignored) {
            // summary is best effort
        }
        String result = s.result().getClass().getSimpleName();
        log.info(String.format("TickDoctor debug: %s x%d %.1f KB (gz %.1f KB) -> %s %s in %d ms%s",
                path, count, s.rawBytes() / 1024.0, s.gzBytes() / 1024.0, s.status() == 0 ? "-" : String.valueOf(s.status()), result, s.millis(),
                extra.isEmpty() ? "" : " | " + extra));
    }

    // ---------- status (lock-free, never blocks) ----------

    public State state() {
        return state;
    }

    /**
     * Carries the last successful push of a previous Sender (before /tickdoctor reload) over, so
     * status doesn't say "never". Call before the sender starts; only ever moves forward.
     */
    public void carryOverLastPush(long ms) {
        if (ms > lastPushMs) lastPushMs = ms;
    }

    public long lastPushMs() {
        return lastPushMs;
    }

    public String lastError() {
        return lastError;
    }

    public long nextAttemptAtMs() {
        return nextAttemptAtMs;
    }

    public int memoryBatches() {
        return memoryCount.get();
    }

    public long memoryBytes() {
        return memoryBytes.get();
    }

    public long memoryDropped() {
        return memoryDropped.get();
    }

    public long droppedCorruptLines() {
        return droppedLines.get();
    }

    /** Failed writes to the disk buffer since this Sender started. */
    public long diskWriteFailures() {
        return diskWriteFailures.get();
    }
}
