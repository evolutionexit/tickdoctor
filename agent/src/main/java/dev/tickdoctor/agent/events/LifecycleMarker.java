package dev.tickdoctor.agent.events;

import dev.tickdoctor.agent.privacy.Redaction;
import dev.tickdoctor.agent.util.Str;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.Comparator;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * Unclean-shutdown detection. A marker file exists while the server runs (touched every minute as
 * a heartbeat) and is deleted on a clean stop. If it is still there on the next start, the
 * previous run crashed or was killed; its last heartbeat approximates when. The heartbeat is
 * driven by the plugin itself (a Bukkit async timer), so it also runs while the agent is idle.
 */
public final class LifecycleMarker {
    public record Previous(boolean unclean, long lastAliveMs, String detail) {}

    public static final long HEARTBEAT_MS = 60_000;
    /** {@link #HEARTBEAT_MS} in server ticks, for the Bukkit scheduler. */
    public static final long HEARTBEAT_TICKS = HEARTBEAT_MS / 50;

    private final Path marker;
    private final Path serverDir;

    public LifecycleMarker(Path dataFolder, Path serverDir) {
        this.marker = dataFolder.resolve("running.marker");
        this.serverDir = serverDir;
    }

    /** Checks the previous run, then (re)creates the marker for this one. */
    public Previous start(long nowMs) throws IOException {
        Previous prev = new Previous(false, 0, null);
        if (Files.exists(marker)) {
            long last = Files.getLastModifiedTime(marker).toMillis();
            prev = new Previous(true, last, describeCrash(last));
        }
        Files.createDirectories(marker.getParent());
        Files.writeString(marker, "running since " + nowMs + "\n", StandardCharsets.UTF_8);
        return prev;
    }

    public void heartbeat() {
        heartbeat(System.currentTimeMillis());
    }

    /** Touches the marker; does nothing if it is gone (after a clean stop). Any thread. */
    public void heartbeat(long nowMs) {
        try {
            Files.setLastModifiedTime(marker, FileTime.fromMillis(nowMs));
        } catch (IOException ignored) {
            // best effort
        }
    }

    public void cleanStop() {
        try {
            Files.deleteIfExists(marker);
        } catch (IOException ignored) {
            // next start will report an unclean shutdown
        }
    }

    private String describeCrash(long lastAliveMs) {
        StringBuilder sb = new StringBuilder("Previous run ended without a clean shutdown (crash, kill or power loss).");
        if (serverDir != null) {
            newest(serverDir.resolve("crash-reports"), "crash-", lastAliveMs - 120_000).ifPresent(p -> {
                sb.append(" Crash report: ").append(p.getFileName());
                String desc = firstLineStarting(p, "Description:");
                if (desc != null) sb.append(" — ").append(desc);
                sb.append('.');
            });
            newest(serverDir, "hs_err_pid", lastAliveMs - 120_000).ifPresent(p -> sb.append(" JVM fatal error log: ").append(p.getFileName()).append('.'));
        }
        return Str.cap(Redaction.redactText(sb.toString(), java.util.Set.of()), 2000);
    }

    private static Optional<Path> newest(Path dir, String prefix, long notBeforeMs) {
        if (!Files.isDirectory(dir)) return Optional.empty();
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().startsWith(prefix))
                    .filter(p -> mtime(p) >= notBeforeMs)
                    .max(Comparator.comparingLong(LifecycleMarker::mtime));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    private static long mtime(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    private static String firstLineStarting(Path p, String prefix) {
        try (BufferedReader r = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
            String line;
            int n = 0;
            while ((line = r.readLine()) != null && n++ < 200) {
                if (line.startsWith(prefix)) return line.trim();
            }
        } catch (IOException | RuntimeException ignored) {
            // unreadable
        }
        return null;
    }
}
