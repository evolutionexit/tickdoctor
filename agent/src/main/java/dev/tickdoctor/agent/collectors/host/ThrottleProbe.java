package dev.tickdoctor.agent.collectors.host;

import dev.tickdoctor.agent.model.HostSample;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * Raspberry Pi throttle state via {@code vcgencmd get_throttled}. Degrades gracefully: whenever it
 * can't get a trustworthy answer (not Linux, vcgencmd not found, permission denied, non-zero exit,
 * unparseable output, hang) {@link #read} returns null so {@code throttled} is omitted (never sent
 * as false), one INFO line says why, and vcgencmd is not tried again for {@link #RECHECK_MS}.
 *
 * <p>Call from a worker thread (the collector thread), never the main thread. A run is hard-capped
 * at {@link #TIMEOUT_MS}; on timeout the process (and its children) is destroyed. At most one run
 * is ever in flight; a concurrent caller gets the last good value without spawning anything.
 *
 * <p>The {@code rpi_volt} hwmon under-voltage alarm is only mentioned in the log line: it can't
 * fill the contract's {@code throttled} object (no freq-capped/throttled bits), so it is not used.
 */
public final class ThrottleProbe {
    public static final long TIMEOUT_MS = 1_000;
    public static final long RECHECK_MS = 10 * 60_000;
    static final int MAX_OUTPUT_BYTES = 4_096;

    /** Result of one vcgencmd run. */
    public record Out(int exitCode, String output) {}

    public static final class TimedOut extends Exception {
        private static final long serialVersionUID = 1L;
    }

    public interface Runner {
        /** Runs {@code exe arg}; must give up (and kill the process) after {@code timeoutMs}. */
        Out run(Path exe, String arg, long timeoutMs) throws IOException, TimedOut;
    }

    private final Path root;
    private final boolean linux;
    private final Supplier<Path> locator;
    private final Runner runner;
    private final Logger log;
    private final LongSupplier clock;
    private final AtomicBoolean inFlight = new AtomicBoolean();

    // written only by the thread holding inFlight
    private volatile boolean available;
    private volatile String unavailableReason;
    private volatile long nextCheckMs;
    private volatile boolean infoLogged;
    private volatile HostSample.Throttled lastThrottled;
    private volatile Double lastTemp;

    /**
     * @param root    "/" in production (for the hwmon hint); a fake root in tests
     * @param locator returns the vcgencmd executable or null if not found; asked again on every re-check
     */
    public ThrottleProbe(Path root, boolean linux, Supplier<Path> locator, Runner runner, Logger log, LongSupplier clock) {
        this.root = root;
        this.linux = linux;
        this.locator = locator;
        this.runner = runner;
        this.log = log;
        this.clock = clock;
    }

    public static ThrottleProbe forThisMachine(Logger log) {
        boolean linux = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("linux");
        return new ThrottleProbe(Path.of("/"), linux, () -> locate(System.getenv("PATH")), new ProcessRunner(), log,
                System::currentTimeMillis);
    }

    /** One reading: {@code throttled} null = omit; {@code temp} only when asked and available. */
    public record Reading(HostSample.Throttled throttled, Double tempC) {
        static final Reading NONE = new Reading(null, null);
    }

    /**
     * Current throttle state, or null fields when unavailable. Blocks for at most ~{@link #TIMEOUT_MS}
     * per vcgencmd call (two when {@code wantTemp}); returns immediately while backing off.
     */
    public Reading read(boolean wantTemp) {
        if (!linux) {
            unavailable("this is not Linux", false);
            return Reading.NONE;
        }
        long now = clock.getAsLong();
        if (!available && nextCheckMs != 0 && now < nextCheckMs) return Reading.NONE;
        if (!inFlight.compareAndSet(false, true)) {
            HostSample.Throttled t = lastThrottled;
            return t == null ? Reading.NONE : new Reading(t, wantTemp ? lastTemp : null);
        }
        try {
            Path exe = locator.get();
            if (exe == null) {
                fail(now, "vcgencmd was not found in PATH");
                return Reading.NONE;
            }
            String err = null;
            HostSample.Throttled t = null;
            try {
                Out o = runner.run(exe, "get_throttled", TIMEOUT_MS);
                if (o.exitCode() != 0) {
                    err = "`vcgencmd get_throttled` exited with " + o.exitCode() + firstLine(o.output());
                } else {
                    t = ProcParsers.vcgencmdThrottled(o.output() == null ? null : o.output().trim());
                    if (t == null) err = "`vcgencmd get_throttled` printed something unexpected" + firstLine(o.output());
                }
            } catch (TimedOut e) {
                err = "`vcgencmd get_throttled` did not answer within " + TIMEOUT_MS + " ms (killed it)";
            } catch (IOException | RuntimeException e) {
                err = "could not run vcgencmd (" + clip(e.getMessage()) + ")";
            }
            if (err != null) {
                fail(now, err);
                return Reading.NONE;
            }
            Double temp = null;
            if (wantTemp) {
                try {
                    Out o = runner.run(exe, "measure_temp", TIMEOUT_MS);
                    if (o.exitCode() == 0) temp = ProcParsers.vcgencmdTemp(o.output() == null ? null : o.output().trim());
                } catch (TimedOut | IOException | RuntimeException ignored) {
                    // temperature is optional; throttled is still good
                }
            }
            if (!available && infoLogged) log.fine("vcgencmd works again; sending throttling data.");
            available = true;
            unavailableReason = null;
            lastThrottled = t;
            lastTemp = temp;
            return new Reading(t, temp);
        } finally {
            inFlight.set(false);
        }
    }

    private void fail(long now, String why) {
        available = false;
        lastThrottled = null;
        lastTemp = null;
        nextCheckMs = now + RECHECK_MS;
        unavailable(why, true);
    }

    private void unavailable(String why, boolean willRetry) {
        unavailableReason = why;
        if (infoLogged) {
            if (willRetry) log.fine("throttling still unavailable: " + why);
            return;
        }
        infoLogged = true;
        StringBuilder sb = new StringBuilder("Raspberry Pi throttling data unavailable (")
                .append(why).append("); throttling won't be reported");
        if (willRetry) sb.append(", re-checking every ").append(RECHECK_MS / 60_000).append(" min");
        sb.append('.');
        if (linux) {
            sb.append(" On Raspberry Pi OS add the server user to the `video` group (sudo usermod -aG video <user>) and restart the server.");
            Path alarm = rpiVoltAlarm();
            if (alarm != null) {
                sb.append(" (").append(alarm).append(" only reports under-voltage, not frequency capping/throttling, so it is not used.)");
            }
        }
        log.info(sb.toString());
    }

    /** {@code /sys/class/hwmon/hwmon* /in0_lcrit_alarm} of the rpi_volt sensor, if readable. */
    Path rpiVoltAlarm() {
        Path hw = root.resolve("sys/class/hwmon");
        if (!Files.isDirectory(hw)) return null;
        try (Stream<Path> l = Files.list(hw)) {
            for (Path d : l.sorted().toList()) {
                String name;
                try {
                    name = Files.readString(d.resolve("name"), StandardCharsets.ISO_8859_1).trim();
                } catch (IOException e) {
                    continue;
                }
                Path alarm = d.resolve("in0_lcrit_alarm");
                if (name.equals("rpi_volt") && Files.isReadable(alarm)) return alarm;
            }
        } catch (IOException | RuntimeException ignored) {
            // no hint then
        }
        return null;
    }

    public boolean available() {
        return available;
    }

    /** Why throttling is unavailable (null while it works or before the first check). */
    public String unavailableReason() {
        return unavailableReason;
    }

    private static String firstLine(String out) {
        if (out == null || out.isBlank()) return "";
        String l = out.strip().lines().findFirst().orElse("");
        return ": " + clip(l);
    }

    private static String clip(String s) {
        if (s == null) return "unknown error";
        s = s.replaceAll("[\\p{Cntrl}]", " ").strip();
        return s.length() <= 120 ? s : s.substring(0, 120) + "…";
    }

    private static final List<String> DEFAULT_DIRS = List.of("/usr/bin", "/opt/vc/bin", "/usr/local/bin");

    /** Finds an executable vcgencmd in PATH or the usual Raspberry Pi OS locations. */
    static Path locate(String pathEnv) {
        return locate(pathEnv, DEFAULT_DIRS);
    }

    /**
     * Only absolute PATH entries count: an empty entry, "." or a relative directory would resolve
     * against the server's working directory, where anyone who can drop a file could plant a fake
     * vcgencmd that the server then runs.
     */
    static Path locate(String pathEnv, List<String> fallbackDirs) {
        Set<String> dirs = new LinkedHashSet<>();
        if (pathEnv != null) {
            for (String d : pathEnv.split(File.pathSeparator)) if (isAbsoluteDir(d)) dirs.add(d);
        }
        dirs.addAll(fallbackDirs);
        for (String d : dirs) {
            try {
                Path p = Path.of(d, "vcgencmd");
                if (Files.isRegularFile(p) && Files.isExecutable(p)) return p;
            } catch (RuntimeException ignored) {
                // bad PATH entry
            }
        }
        return null;
    }

    private static boolean isAbsoluteDir(String d) {
        if (d == null || d.isBlank()) return false;
        try {
            return Path.of(d).isAbsolute();
        } catch (RuntimeException e) {
            return false; // unparsable PATH entry
        }
    }

    /**
     * Real subprocess: stdin closed, stderr merged, output capped, killed (with live children) on
     * timeout. A child that outlives an already-exited vcgencmd can't be reached any more; we still
     * give up at the deadline and close our end of the pipe.
     */
    public static final class ProcessRunner implements Runner {
        @Override
        public Out run(Path exe, String arg, long timeoutMs) throws IOException, TimedOut {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            Process p = new ProcessBuilder(exe.toString(), arg).redirectErrorStream(true).start();
            try {
                p.getOutputStream().close();
                // drained by a helper thread into a bounded buffer so a chatty process can't block on a
                // full pipe; the deadline below covers both the process and the pipe
                OutputReader reader = new OutputReader(p.getInputStream());
                reader.start();
                long left = deadline - System.nanoTime();
                if (left <= 0 || !p.waitFor(left, TimeUnit.NANOSECONDS)) throw new TimedOut();
                reader.join(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())));
                if (reader.isAlive()) throw new TimedOut(); // a child kept the pipe open
                return new Out(p.exitValue(), reader.text());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new TimedOut();
            } finally {
                if (p.isAlive() || p.descendants().findAny().isPresent()) kill(p);
                closeQuietly(p.getInputStream());
            }
        }

        private static void kill(Process p) {
            List<ProcessHandle> kids = new ArrayList<>(p.descendants().toList());
            for (ProcessHandle h : kids) h.destroyForcibly();
            p.destroyForcibly();
        }

        private static void closeQuietly(InputStream in) {
            try {
                in.close();
            } catch (IOException ignored) {
                // nothing to do
            }
        }
    }

    private static final class OutputReader extends Thread {
        private final InputStream in;
        private final byte[] buf = new byte[MAX_OUTPUT_BYTES];
        private volatile int len;

        OutputReader(InputStream in) {
            super("TickDoctor-vcgencmd-out");
            setDaemon(true);
            this.in = in;
        }

        @Override
        public void run() {
            try {
                int n;
                byte[] sink = new byte[1024];
                while ((n = in.read(sink)) >= 0) {
                    int copy = Math.min(n, buf.length - len);
                    if (copy > 0) {
                        System.arraycopy(sink, 0, buf, len, copy);
                        len += copy;
                    }
                }
            } catch (IOException ignored) {
                // closed on kill
            }
        }

        String text() {
            return new String(buf, 0, len, StandardCharsets.UTF_8);
        }
    }
}
