package dev.tickdoctor.agent;

import dev.tickdoctor.agent.collectors.Overhead;
import dev.tickdoctor.agent.commands.TickDoctorCommand;
import dev.tickdoctor.agent.events.EventCollector;
import dev.tickdoctor.agent.events.LifecycleMarker;
import dev.tickdoctor.agent.events.LogCapture;
import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.transport.UrlPolicy;
import dev.tickdoctor.agent.util.Iso;
import java.io.IOException;
import java.nio.file.Path;
import java.util.UUID;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.command.PluginCommand;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

/** Plugin entry point. Lifetime-of-the-process pieces live here; the rest in {@link AgentRuntime}. */
public final class TickDoctorPlugin extends JavaPlugin {
    private final Overhead overhead = new Overhead();
    private final EventCollector events = new EventCollector();
    private final String bootId = UUID.randomUUID().toString();
    private LifecycleMarker marker;
    private org.bukkit.scheduler.BukkitTask heartbeatTask;
    private LogCapture capture;
    private AgentConfig config;
    private volatile AgentRuntime runtime;
    private volatile Thread reloadThread;
    /** Last successful push of runtimes retired by /tickdoctor reload (0 = none). */
    private volatile long retiredLastPushMs;

    @Override
    public void onEnable() {
        long now = System.currentTimeMillis();
        Path data = getDataFolder().toPath();
        writeDefaultConfig(data.resolve("config.yml"));
        deleteLegacySalt(data);
        marker = new LifecycleMarker(data, Path.of("").toAbsolutePath());
        try {
            LifecycleMarker.Previous prev = marker.start(now);
            events.add(new AgentEvent.ServerStart(Iso.ts(now), prev.unclean()), now);
            if (prev.unclean()) {
                events.add(new AgentEvent.Crash(Iso.ts(prev.lastAliveMs()), prev.detail()), now);
                getLogger().warning("the previous run did not shut down cleanly; reporting it as a crash.");
            }
        } catch (IOException e) {
            events.add(new AgentEvent.ServerStart(Iso.ts(now), false), now);
        }
        // owned by the plugin, not the runtime: keeps lastAlive right while the agent is idle too
        LifecycleMarker m = marker;
        heartbeatTask = getServer().getScheduler().runTaskTimerAsynchronously(this, () -> m.heartbeat(),
                LifecycleMarker.HEARTBEAT_TICKS, LifecycleMarker.HEARTBEAT_TICKS);

        capture = new LogCapture(getLogger().getName());
        try {
            capture.attach();
        } catch (RuntimeException | LinkageError e) {
            getLogger().log(Level.WARNING, "could not hook the server log; can't-keep-up and exception events are disabled.", e);
        }

        PluginCommand cmd = getCommand("tickdoctor");
        if (cmd != null) {
            TickDoctorCommand handler = new TickDoctorCommand(this);
            cmd.setExecutor(handler);
            cmd.setTabCompleter(handler);
        }
        startRuntime();
        getServer().getPluginManager().registerEvents(new PlayerListener(events, overhead), this);
    }

    @Override
    public void onDisable() {
        long now = System.currentTimeMillis();
        long deadline = now + 3_000; // total cap for the shutdown flush
        events.add(new AgentEvent.ServerStop(Iso.ts(now), Bukkit.isStopping() ? "shutdown" : "plugin disabled"), now);
        Thread rt = reloadThread;
        if (rt != null) {
            try {
                rt.join(Math.max(1, Math.min(1_000, deadline - System.currentTimeMillis())));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        AgentRuntime r = runtime;
        runtime = null;
        if (r != null) {
            r.stopMain();
            r.stopThreads(true, deadline);
        }
        if (capture != null) {
            capture.setActive(false);
            try {
                capture.detach();
            } catch (RuntimeException | LinkageError ignored) {
                // server is going down anyway
            }
        }
        if (heartbeatTask != null) heartbeatTask.cancel();
        heartbeatTask = null;
        if (marker != null) marker.cleanStop();
    }

    /** Main thread: reads config.yml; null (after logging why) if the agent should not run. */
    private AgentConfig readConfig() {
        reloadConfig();
        FileConfiguration c = getConfig();
        AgentConfig cfg = AgentConfig.of(
                c.getString("api-key", ""),
                c.getString("api-url", AgentConfig.DEFAULT_URL),
                c.getLong("metrics-interval-seconds", 10),
                c.getString("privacy-mode", "hashed"),
                c.getDouble("snapshot-mspt-threshold", 50),
                c.getDouble("buffer-max-mb", 50),
                c.getBoolean("debug-log-payloads", false));
        config = cfg;
        String cfgPath = "plugins/" + getDataFolder().getName() + "/config.yml";
        switch (cfg.keyStatus()) {
            case MISSING, PLACEHOLDER -> {
                // once per enable/reload; nothing runs (no collectors, no sending, no buffer growth)
                getLogger().warning((cfg.keyStatus() == AgentConfig.KeyStatus.MISSING ? "no api-key" : "api-key is still the placeholder")
                        + " — set api-key in " + cfgPath + " — get one from " + AgentConfig.KEY_SOURCE
                        + ". Staying idle; run /tickdoctor reload after setting it.");
                return null;
            }
            case UNUSUAL -> getLogger().warning("api-key in " + cfgPath + " doesn't start with " + AgentConfig.KEY_PREFIX
                    + " — trying it anyway (the API decides). Keys look like " + AgentConfig.KEY_PREFIX + "<letters and digits>.");
            case OK -> { }
        }
        String permWarning = StatusText.permissionWarning(getDataFolder().toPath().resolve("config.yml"), cfg.keyStatus());
        if (permWarning != null) getLogger().warning(permWarning);
        if (!cfg.urlLooksValid()) {
            getLogger().warning("api-url must start with http:// or https:// (got '" + cfg.apiUrl() + "') — not collecting.");
            return null;
        }
        if (!cfg.urlTransportAllowed()) {
            getLogger().severe(UrlPolicy.refusal(cfg.apiUrl()) + " Not collecting — use https://, then /tickdoctor reload.");
            return null;
        }
        return cfg;
    }

    /** Builds and starts the threads of a runtime (any thread); null on failure. */
    private AgentRuntime createRuntime(AgentConfig cfg) {
        try {
            AgentRuntime r = new AgentRuntime(this, cfg, events, capture, overhead, bootId);
            r.sender.carryOverLastPush(retiredLastPushMs);
            r.startThreads();
            return r;
        } catch (IOException | RuntimeException e) {
            getLogger().log(Level.SEVERE, "could not start", e);
            return null;
        }
    }

    private void announce(AgentConfig cfg) {
        getLogger().info("collecting every " + cfg.metricsIntervalSeconds() + " s, sending to " + cfg.apiUrl()
                + " (privacy: " + cfg.privacyMode().wire() + ").");
    }

    /** On enable (main thread): read config and start. */
    private boolean startRuntime() {
        AgentConfig cfg = readConfig();
        if (cfg == null) return false;
        AgentRuntime r = createRuntime(cfg);
        if (r == null) return false;
        r.startMain();
        runtime = r;
        capture.setActive(true);
        announce(cfg);
        return true;
    }

    /**
     * /tickdoctor reload (main thread). Only Bukkit unregister/register runs on the main thread;
     * stopping, flushing and starting the threads happen on a worker. {@code done} is called on
     * the main thread with whether the agent is running afterwards; returns false if a reload is
     * already in progress.
     */
    public boolean reload(java.util.function.Consumer<Boolean> done) {
        if (reloadThread != null) return false;
        AgentRuntime old = runtime;
        runtime = null;
        if (old != null) old.stopMain();
        AgentConfig cfg = readConfig();
        Thread t = new Thread(() -> {
            AgentRuntime r = null;
            try {
                if (old != null) {
                    old.stopThreads(true, System.currentTimeMillis() + 3_000);
                    retiredLastPushMs = Math.max(retiredLastPushMs, old.sender.lastPushMs());
                }
                r = cfg == null ? null : createRuntime(cfg);
            } catch (RuntimeException e) {
                getLogger().log(Level.SEVERE, "reload failed", e);
            }
            capture.setActive(r != null); // idle: stop collecting log lines nobody drains
            AgentRuntime started = r;
            try {
                Bukkit.getScheduler().runTask(this, () -> {
                    reloadThread = null;
                    if (started != null) {
                        started.startMain();
                        runtime = started;
                        announce(cfg);
                    }
                    done.accept(started != null);
                });
            } catch (RuntimeException e) { // plugin disabled meanwhile
                reloadThread = null;
                if (started != null) started.stopThreads(false, 0);
            }
        }, "TickDoctor-reload");
        t.setDaemon(true);
        reloadThread = t;
        t.start();
        return true;
    }

    /** Lines for /tickdoctor status. */
    public java.util.List<String> statusLines() {
        java.util.List<String> out = new java.util.ArrayList<>();
        String version = getPluginMeta().getVersion();
        AgentRuntime r = runtime;
        long now = System.currentTimeMillis();
        Overhead.Window w = overhead.lastWindow();
        if (r == null && reloadThread != null) {
            out.add("TickDoctor " + version + ": reloading…");
            return out;
        }
        if (r == null) {
            out.add("TickDoctor " + version + ": " + StatusText.notRunning(config));
            String losses = StatusText.losses(0, 0, events.dropped(), capture == null ? 0 : capture.dropped(), 0);
            if (losses != null) out.add(losses);
            return out;
        }
        var s = r.sender;
        AgentConfig cfgNow = r.config;
        String state = StatusText.state(s.state(), s.lastError(), s.nextAttemptAtMs(), now);
        out.add("TickDoctor " + version + ": " + state);
        out.add("API " + cfgNow.apiUrl() + " · every " + r.intervalSeconds() + " s · privacy " + config.privacyMode().wire()
                + " · snapshot at " + Math.round(r.snapshots.thresholdMs()) + " ms");
        out.add("Last push: " + (s.lastPushMs() == 0 ? "never" : ago(now - s.lastPushMs()) + " ago")
                + (s.lastError() != null ? " · last error: " + s.lastError() : ""));
        out.add(String.format("Buffer: %d batches, %.2f MB on disk (max %d MB), %d in memory%s",
                r.disk.size(), r.disk.totalBytes() / 1048576.0, cfgNow.bufferMaxBytes() / 1048576, s.memoryBatches(),
                r.disk.droppedFiles() > 0 ? ", " + r.disk.droppedFiles() + " oldest dropped" : ""));
        out.add(String.format("Own overhead: %.3f ms/tick avg, %.3f ms worst tick, %.0f ms async CPU (last window); worst ever %.3f ms",
                w.mainThreadMsPerTick(), w.mainThreadMsMax(), w.asyncCpuMs(), overhead.lifetimeMaxMs()));
        var tally = r.scanner.last();
        out.add("Counts: " + (tally == null ? "first pass running" : tally.totalChunks() + " chunks, pass took " + (tally.finishedAtMs() - tally.startedAtMs)
                + " ms, " + ago(now - tally.startedAtMs) + " old") + (r.snapshots.inProgress() ? " · snapshot in progress" : "")
                + (r.snapshots.lastSnapshotMs() > 0 ? " · last snapshot " + ago(now - r.snapshots.lastSnapshotMs()) + " ago" : ""));
        String losses = StatusText.losses(s.memoryDropped(), s.droppedCorruptLines(), events.dropped(),
                capture == null ? 0 : capture.dropped(), s.diskWriteFailures());
        if (losses != null) out.add(losses);
        return out;
    }

    /** /tickdoctor snapshot: null if started, else the reason. */
    public String requestManualSnapshot() {
        AgentRuntime r = runtime;
        if (r == null) return "TickDoctor is not running";
        long now = System.currentTimeMillis();
        return r.snapshots.request("manual", r.snapshots.currentP95(now), now);
    }

    private static String ago(long ms) {
        long s = Math.max(0, ms / 1000);
        if (s < 120) return s + " s";
        if (s < 7200) return (s / 60) + " min";
        return (s / 3600) + " h";
    }

    /**
     * First start: writes the bundled config.yml owner-only (600, data folder 700) so the API key
     * the user adds later is private from the start, whatever the umask. Best effort on non-POSIX.
     */
    private void writeDefaultConfig(Path file) {
        if (java.nio.file.Files.exists(file)) return;
        try (var in = getResource("config.yml")) {
            if (in == null) return;
            dev.tickdoctor.agent.util.FilePerms.createPrivateIfAbsent(file, in.readAllBytes());
        } catch (IOException | RuntimeException e) {
            getLogger().log(Level.WARNING, "could not write " + file + "; falling back to the default writer.", e);
            saveDefaultConfig();
        }
    }

    /** Agents before 0.1.5 hashed player ids with plugins/TickDoctor/salt.txt; no longer used. Best effort, silent. */
    static void deleteLegacySalt(Path dataFolder) {
        try {
            java.nio.file.Files.deleteIfExists(dataFolder.resolve("salt.txt"));
        } catch (IOException | RuntimeException ignored) {
            // harmless if it stays
        }
    }

    public AgentConfig agentConfig() {
        return config;
    }

    public Overhead overhead() {
        return overhead;
    }

}
