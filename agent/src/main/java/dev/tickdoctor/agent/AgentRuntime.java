package dev.tickdoctor.agent;

import dev.tickdoctor.agent.collectors.ChunkGenCounter;
import dev.tickdoctor.agent.collectors.GcTracker;
import dev.tickdoctor.agent.collectors.MainThreadSampler;
import dev.tickdoctor.agent.collectors.Overhead;
import dev.tickdoctor.agent.collectors.SampleBuilder;
import dev.tickdoctor.agent.collectors.ThreadCpuTracker;
import dev.tickdoctor.agent.collectors.TickListener;
import dev.tickdoctor.agent.collectors.TickRing;
import dev.tickdoctor.agent.collectors.WorldScanner;
import dev.tickdoctor.agent.collectors.host.HostCollector;
import dev.tickdoctor.agent.events.EventCollector;
import dev.tickdoctor.agent.events.LogCapture;
import dev.tickdoctor.agent.events.LogEvents;
import dev.tickdoctor.agent.events.PluginDiff;
import dev.tickdoctor.agent.events.PluginGuesser;
import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.Hello;
import dev.tickdoctor.agent.model.Json;
import dev.tickdoctor.agent.snapshot.SnapshotManager;
import dev.tickdoctor.agent.transport.Backoff;
import dev.tickdoctor.agent.transport.DiskBuffer;
import dev.tickdoctor.agent.transport.IngestClient;
import dev.tickdoctor.agent.transport.Kind;
import dev.tickdoctor.agent.transport.RemoteConfig;
import dev.tickdoctor.agent.transport.Sender;
import com.google.gson.reflect.TypeToken;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.event.HandlerList;
import org.bukkit.scheduler.BukkitTask;

/**
 * Everything that runs while the agent is configured: collectors, the per-tick main-thread task,
 * the collector thread (1 s loop) and the sender thread (1 s loop). Created on enable and on
 * {@code /tickdoctor reload}; stopped on disable/reload.
 */
final class AgentRuntime {
    static final long EVENTS_FLUSH_MS = 5_000;
    static final long PLUGIN_CHECK_MS = 300_000;

    private final TickDoctorPlugin plugin;
    private final Logger log;
    final AgentConfig config;
    private final EventCollector events;
    private final LogCapture capture;
    private final Overhead overhead;
    private final File serverDir;

    final TickRing ring = new TickRing(6_000);
    final ChunkGenCounter chunkGen = new ChunkGenCounter(System.nanoTime());
    final WorldScanner scanner;
    final MainThreadSampler mainSampler;
    final GcTracker gc = new GcTracker();
    final HostCollector host;
    final ThreadCpuTracker threads = new ThreadCpuTracker();
    final SampleBuilder samples;
    final DiskBuffer disk;
    final Sender sender;
    final SnapshotManager snapshots;
    private final TickListener tickListener;
    private final ScheduledExecutorService collectorExec;
    private final ScheduledExecutorService senderExec;
    private BukkitTask mainTask;

    private volatile int intervalSeconds;
    private long nextMetricsMs;
    private long nextEventsMs;
    private long nextPluginCheckMs;
    private volatile PluginGuesser guesser = new PluginGuesser(Map.of());
    private volatile List<Hello.Plugin> lastPlugins;

    AgentRuntime(TickDoctorPlugin plugin, AgentConfig config, EventCollector events, LogCapture capture,
                 Overhead overhead, String bootId) throws IOException {
        this.plugin = plugin;
        this.log = plugin.getLogger();
        this.config = config;
        this.events = events;
        this.capture = capture;
        this.overhead = overhead;
        this.serverDir = new File("").getAbsoluteFile();
        this.intervalSeconds = config.metricsIntervalSeconds();

        long now = System.currentTimeMillis();
        scanner = new WorldScanner(overhead, intervalSeconds * 1000L);
        mainSampler = new MainThreadSampler(overhead, scanner);
        host = HostCollector.forThisMachine(serverDir, log);
        samples = new SampleBuilder(ring, mainSampler, scanner, chunkGen, gc, host, overhead, threads, now);
        disk = new DiskBuffer(plugin.getDataFolder().toPath().resolve("buffer"), config.bufferMaxBytes());
        String version = plugin.getPluginMeta().getVersion();
        sender = new Sender(new IngestClient(config.apiUrl(), config.apiKey(), version), disk,
                new Backoff(ThreadLocalRandom.current()), version, bootId, log, this::applyRemote, config.debugLogPayloads());
        collectorExec = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "TickDoctor-collector"));
        senderExec = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "TickDoctor-sender"));
        snapshots = new SnapshotManager(ring, scanner, samples, events, threads, overhead, collectorExec,
                json -> sender.submit(Kind.SNAPSHOT, List.of(json)), log, config.snapshotMsptThreshold(), intervalSeconds * 1000L);
        tickListener = new TickListener(ring, overhead, chunkGen);
    }

    private static Thread daemon(Runnable r, String name) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    }

    /** Threads and JMX listeners; any thread. */
    void startThreads() {
        long now = System.currentTimeMillis();
        nextMetricsMs = now + intervalSeconds * 1000L;
        nextEventsMs = now + EVENTS_FLUSH_MS;
        nextPluginCheckMs = now + PLUGIN_CHECK_MS;
        gc.start();
        collectorExec.scheduleWithFixedDelay(() -> overhead.timeAsync(this::collectorTick), 1, 1, TimeUnit.SECONDS);
        senderExec.scheduleWithFixedDelay(() -> overhead.timeAsync(this::senderTick), 1, 1, TimeUnit.SECONDS);
    }

    /** Bukkit registration and scheduling; main thread only. */
    void startMain() {
        Bukkit.getPluginManager().registerEvents(tickListener, plugin);
        mainTask = Bukkit.getScheduler().runTaskTimer(plugin, mainSampler, 1L, 1L);
        // hello after the server finished starting (all plugins enabled, worlds loaded)
        Bukkit.getScheduler().runTask(plugin, () -> refreshPlugins(true));
    }

    /** Main thread: undo {@link #startMain}. Cheap. */
    void stopMain() {
        if (mainTask != null) mainTask.cancel();
        mainTask = null;
        HandlerList.unregisterAll(tickListener);
    }

    /**
     * Stops threads, flushes pending events and (if {@code flush}) tries to deliver memory until
     * {@code deadlineMs}; everything else goes to the disk buffer. Never runs past the deadline
     * by more than a disk write. Call from a worker thread except on plugin disable.
     */
    void stopThreads(boolean flush, long deadlineMs) {
        gc.stop();
        collectorExec.shutdownNow();
        senderExec.shutdownNow();
        try {
            collectorExec.awaitTermination(Math.max(0, Math.min(500, deadlineMs - System.currentTimeMillis())), TimeUnit.MILLISECONDS);
            senderExec.awaitTermination(Math.max(0, Math.min(500, deadlineMs - System.currentTimeMillis())), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        processLogs();
        flushEvents(System.currentTimeMillis());
        sender.shutdown(flush ? deadlineMs : 0); // flush, then close the HTTP client
    }

    // ---------- collector thread ----------

    private void collectorTick() {
        try {
            long now = System.currentTimeMillis();
            processLogs();
            snapshots.check(now);
            if (now >= nextMetricsMs) {
                nextMetricsMs = now + intervalSeconds * 1000L;
                sender.submit(Kind.METRICS, List.of(Json.toJson(samples.next(now, System.nanoTime()))));
            }
            if (now >= nextEventsMs) {
                nextEventsMs = now + EVENTS_FLUSH_MS;
                flushEvents(now);
            }
            if (now >= nextPluginCheckMs) {
                nextPluginCheckMs = now + PLUGIN_CHECK_MS;
                if (plugin.isEnabled()) Bukkit.getScheduler().runTask(plugin, () -> refreshPlugins(false));
            }
        } catch (RuntimeException e) {
            log.log(Level.WARNING, "collector error", e);
        }
    }

    private void processLogs() {
        for (LogCapture.Raw r : capture.drain()) {
            AgentEvent.CantKeepUp c = LogEvents.cantKeepUp(r.millis(), r.message());
            if (c != null) {
                events.add(c, r.millis());
            } else if (r.thrown() != null) {
                events.addException(LogEvents.exception(r.millis(), r.logger(), r.message(), r.thrown(), guesser, mainSampler.playerNames()), r.millis());
            }
        }
    }

    private void flushEvents(long now) {
        List<AgentEvent> batch = events.drain(now);
        if (batch.isEmpty()) return;
        List<String> items = new ArrayList<>(batch.size());
        for (AgentEvent e : batch) items.add(Json.toJson(e));
        sender.submit(Kind.EVENTS, items);
    }

    // ---------- sender thread ----------

    private void senderTick() {
        try {
            sender.pump(System.currentTimeMillis());
        } catch (RuntimeException e) {
            log.log(Level.WARNING, "sender error", e);
        }
    }

    // ---------- hello / plugin list ----------

    /** Main thread: copy server state, then build + diff async. */
    private void refreshPlugins(boolean initial) {
        long t0 = System.nanoTime();
        HelloBuilder.ServerInfo info;
        try {
            info = HelloBuilder.gather();
        } finally {
            overhead.addMain(System.nanoTime() - t0);
        }
        try {
            collectorExec.execute(() -> overhead.timeAsync(() -> buildHello(info, initial)));
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // stopping
        }
    }

    private void buildHello(HelloBuilder.ServerInfo info, boolean initial) {
        {
            try {
                guesser = new PluginGuesser(info.mainClasses());
                List<Hello.Plugin> before = initial ? loadStoredPlugins() : lastPlugins;
                AgentEvent.PluginsChanged changed = before == null ? null : PluginDiff.diff(before, info.plugins(), System.currentTimeMillis());
                if (changed != null) events.add(changed, System.currentTimeMillis());
                if (initial || changed != null) {
                    storePlugins(info.plugins());
                    sender.setHello(Json.toJson(HelloBuilder.build(info, config.privacyMode(), host, serverDir)));
                }
                lastPlugins = info.plugins();
            } catch (RuntimeException e) {
                log.log(Level.WARNING, "could not build hello", e);
            }
        }
    }

    private Path pluginsFile() {
        return plugin.getDataFolder().toPath().resolve("plugins.json");
    }

    private List<Hello.Plugin> loadStoredPlugins() {
        try {
            if (!Files.isRegularFile(pluginsFile())) return null;
            return Json.GSON.fromJson(Files.readString(pluginsFile(), StandardCharsets.UTF_8), new TypeToken<List<Hello.Plugin>>() {}.getType());
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private void storePlugins(List<Hello.Plugin> plugins) {
        try {
            Files.writeString(pluginsFile(), Json.toJson(plugins), StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.log(Level.FINE, "could not store plugin list", e);
        }
    }

    // ---------- remote config ----------

    private void applyRemote(RemoteConfig cfg) {
        if (cfg.metricsIntervalSeconds() != null && cfg.metricsIntervalSeconds() != intervalSeconds) {
            intervalSeconds = cfg.metricsIntervalSeconds();
            scanner.setIntervalMs(intervalSeconds * 1000L);
            snapshots.setWindowMs(intervalSeconds * 1000L);
            log.info("API set metrics interval to " + intervalSeconds + " s.");
        }
        if (cfg.snapshotMsptThreshold() != null && cfg.snapshotMsptThreshold() != snapshots.thresholdMs()) {
            snapshots.setThresholdMs(cfg.snapshotMsptThreshold());
            log.info("API set snapshot threshold to " + cfg.snapshotMsptThreshold() + " ms.");
        }
        if (cfg.requestSnapshot()) {
            long now = System.currentTimeMillis();
            String why = snapshots.request("requested", snapshots.currentP95(now), now);
            if (why != null) log.fine("API requested a snapshot but " + why);
        }
    }

    int intervalSeconds() {
        return intervalSeconds;
    }
}
