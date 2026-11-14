package dev.tickdoctor.agent.collectors.host;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tickdoctor.agent.model.HostSample;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

class ThrottleProbeTest {
    private static final Path EXE = Path.of("/usr/bin/vcgencmd");

    /** Captures log records. */
    static final class Logs extends Handler {
        final List<LogRecord> records = Collections.synchronizedList(new ArrayList<>());
        final Logger logger;

        Logs() {
            logger = Logger.getAnonymousLogger();
            logger.setUseParentHandlers(false);
            logger.setLevel(Level.ALL);
            logger.addHandler(this);
        }

        List<String> at(Level l) {
            synchronized (records) {
                return records.stream().filter(r -> r.getLevel() == l).map(LogRecord::getMessage).toList();
            }
        }

        @Override
        public void publish(LogRecord r) {
            records.add(r);
        }

        @Override
        public void flush() {}

        @Override
        public void close() {}
    }

    private final Logs logs = new Logs();
    private final AtomicLong clock = new AtomicLong(1_000_000);
    private final AtomicInteger located = new AtomicInteger();
    private final AtomicInteger runs = new AtomicInteger();

    private ThrottleProbe probe(Path root, boolean linux, Path exe, ThrottleProbe.Runner runner) {
        return new ThrottleProbe(root, linux, () -> {
            located.incrementAndGet();
            return exe;
        }, (e, arg, t) -> {
            runs.incrementAndGet();
            assertTrue(t <= 1_000, "hard timeout must be <= 1 s");
            return runner.run(e, arg, t);
        }, logs.logger, clock::get);
    }

    private ThrottleProbe probe(Path exe, ThrottleProbe.Runner runner) {
        return probe(Path.of("/nonexistent-root"), true, exe, runner);
    }

    /** Many samples (every 10 s) over almost 10 min: nothing re-checked, all omitted, one INFO. */
    private void assertBacksOff(ThrottleProbe p, String reasonFragment) {
        for (int i = 0; i < 59; i++) {
            assertNull(p.read(true).throttled());
            clock.addAndGet(10_000);
        }
        assertEquals(1, located.get(), "re-checks at most every 10 min, not every sample");
        assertTrue(runs.get() <= 1);
        List<String> info = logs.at(Level.INFO);
        assertEquals(1, info.size(), "exactly one INFO line: " + info);
        assertTrue(info.get(0).contains(reasonFragment), info.get(0));
        assertTrue(info.get(0).contains("won't be reported"), info.get(0));
        assertTrue(info.get(0).contains("video"), "tip for Raspberry Pi OS users");
        assertNotNull(p.unavailableReason());
        assertTrue(logs.at(Level.WARNING).isEmpty() && logs.at(Level.SEVERE).isEmpty());
    }

    @Test
    void missingFromPath() {
        ThrottleProbe p = probe(null, (e, a, t) -> {
            throw new AssertionError("must not run");
        });
        assertBacksOff(p, "not found in PATH");
        clock.addAndGet(10_000); // now > 10 min after the first check
        assertNull(p.read(false).throttled());
        assertEquals(2, located.get(), "re-checked after 10 min");
        assertEquals(1, logs.at(Level.INFO).size(), "still only one INFO line");
    }

    @Test
    void permissionDenied() {
        ThrottleProbe p = probe(EXE, (e, a, t) -> {
            throw new IOException("Cannot run program \"/usr/bin/vcgencmd\": error=13, Permission denied");
        });
        assertBacksOff(p, "Permission denied");
    }

    @Test
    void nonZeroExit() {
        ThrottleProbe p = probe(EXE, (e, a, t) -> new ThrottleProbe.Out(255, "VCHI initialization failed\nmore"));
        assertBacksOff(p, "exited with 255: VCHI initialization failed");
    }

    @Test
    void garbageOutput() {
        ThrottleProbe p = probe(EXE, (e, a, t) -> new ThrottleProbe.Out(0, "frobnicate=0xZZ"));
        assertBacksOff(p, "unexpected");
    }

    @Test
    void garbageVariants() {
        for (String out : new String[] {"", "throttled=", "throttled=0xZZ", "temp=50'C", "x=0x0", "throttled=-1", "throttled=0x0\nthrottled=0x5"}) {
            assertNull(ProcParsers.vcgencmdThrottled(out), out);
        }
        assertNotNull(ProcParsers.vcgencmdThrottled("throttled=0x0\n"));
    }

    @Test
    void hang() {
        ThrottleProbe p = probe(EXE, (e, a, t) -> {
            throw new ThrottleProbe.TimedOut();
        });
        assertBacksOff(p, "did not answer within 1000 ms");
    }

    @Test
    void notLinuxNeverRuns() {
        ThrottleProbe p = probe(Path.of("/"), false, EXE, (e, a, t) -> {
            throw new AssertionError("must not run");
        });
        for (int i = 0; i < 200; i++) {
            assertNull(p.read(true).throttled());
            clock.addAndGet(60_000);
        }
        assertEquals(0, located.get());
        assertEquals(0, runs.get());
        List<String> info = logs.at(Level.INFO);
        assertEquals(1, info.size());
        assertTrue(info.get(0).contains("not Linux"));
    }

    @Test
    void worksThenFailsThenRecovers() {
        AtomicReference<ThrottleProbe.Out> next = new AtomicReference<>(new ThrottleProbe.Out(0, "throttled=0x50005\n"));
        ThrottleProbe p = probe(EXE, (e, a, t) -> a.equals("measure_temp") ? new ThrottleProbe.Out(0, "temp=51.2'C") : next.get());
        ThrottleProbe.Reading r = p.read(true);
        assertEquals(new HostSample.Throttled(true, true, "0x50005"), r.throttled());
        assertEquals(51.2, r.tempC());
        assertTrue(p.available());
        assertNull(p.read(false).tempC(), "temp only when asked");
        assertTrue(logs.at(Level.INFO).isEmpty(), "silent while it works");

        next.set(new ThrottleProbe.Out(1, "error"));
        assertNull(p.read(false).throttled(), "omitted, never a stale or false value");
        int runsAfterFail = runs.get();
        clock.addAndGet(ThrottleProbe.RECHECK_MS - 1);
        assertNull(p.read(false).throttled());
        assertEquals(runsAfterFail, runs.get());
        assertEquals(1, logs.at(Level.INFO).size());

        next.set(new ThrottleProbe.Out(0, "throttled=0x0"));
        clock.addAndGet(1);
        assertEquals(new HostSample.Throttled(false, false, "0x0"), p.read(false).throttled());
        assertTrue(p.available());
        assertEquals(1, logs.at(Level.INFO).size());
    }

    @Test
    void neverMoreThanOneInFlight() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ThrottleProbe p = probe(EXE, (e, a, t) -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            return new ThrottleProbe.Out(0, "throttled=0x0");
        });
        Thread t = new Thread(() -> p.read(false));
        t.start();
        assertTrue(started.await(5, TimeUnit.SECONDS));
        for (int i = 0; i < 20; i++) assertNull(p.read(false).throttled(), "no spawn while one is running");
        release.countDown();
        t.join(5_000);
        assertEquals(1, runs.get());
        assertNotNull(p.read(false).throttled());
        assertEquals(2, runs.get());
    }

    @Test
    void rpiVoltIsOnlyMentionedNeverFaked(@TempDir Path root) throws IOException {
        Path hw = root.resolve("sys/class/hwmon");
        Files.createDirectories(hw.resolve("hwmon0"));
        Files.writeString(hw.resolve("hwmon0/name"), "cpu_thermal\n");
        Files.createDirectories(hw.resolve("hwmon5"));
        Files.writeString(hw.resolve("hwmon5/name"), "rpi_volt\n");
        Files.writeString(hw.resolve("hwmon5/in0_lcrit_alarm"), "1\n"); // under-voltage right now
        ThrottleProbe p = probe(root, true, null, (e, a, t) -> {
            throw new AssertionError();
        });
        assertEquals(hw.resolve("hwmon5/in0_lcrit_alarm"), p.rpiVoltAlarm());
        assertNull(p.read(true).throttled(), "alarm alone can't fill throttled; stays omitted");
        String info = logs.at(Level.INFO).get(0);
        assertTrue(info.contains("in0_lcrit_alarm") && info.contains("not used"), info);
    }

    @Test
    void hostCollectorOmitsThrottledWithoutVcgencmd(@TempDir Path tmp) throws IOException {
        ProcParsersTest.copyTree(ProcParsersTest.resource("pi5"), tmp);
        HostCollector c = new HostCollector(tmp, tmp.toFile(), probe(tmp, true, null, (e, a, t) -> {
            throw new AssertionError();
        }));
        HostSample s = c.sample(1);
        assertNull(s.throttled());
        assertNotNull(s.cpuTempC());
        String json = dev.tickdoctor.agent.model.Json.toJson(s);
        assertFalse(json.contains("throttled"), json);
    }

    @Test
    void hostCollectorUsesVcgencmdWhenItWorks(@TempDir Path tmp) throws IOException {
        ProcParsersTest.copyTree(ProcParsersTest.resource("pi5"), tmp);
        HostCollector c = new HostCollector(tmp, tmp.toFile(), probe(tmp, true, EXE, (e, a, t) -> new ThrottleProbe.Out(0, "throttled=0x50000")));
        assertEquals(new HostSample.Throttled(false, true, "0x50000"), c.sample(1).throttled());
        assertEquals(1, runs.get(), "thermal zone gives temp, so measure_temp isn't run");
    }

    @Test
    void locateSearchesPath(@TempDir Path dir) throws IOException {
        Path exe = dir.resolve("vcgencmd");
        Files.writeString(exe, "#!/bin/sh\n");
        if (!exe.toFile().setExecutable(true)) return;
        assertEquals(exe, ThrottleProbe.locate("/does/not/exist" + java.io.File.pathSeparator + dir));
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void locateIgnoresRelativeEmptyAndDotPathEntries(@TempDir Path abs) throws Exception {
        // a relative directory (resolved against the working directory) that does contain a vcgencmd
        Path relDir = Path.of("build", "tmp", "throttle-relative-path-test");
        Files.createDirectories(relDir);
        Path planted = relDir.resolve("vcgencmd");
        try {
            Files.writeString(planted, "#!/bin/sh\n");
            assertTrue(planted.toFile().setExecutable(true));
            assertTrue(Files.isExecutable(planted) && !relDir.isAbsolute());
            String sep = java.io.File.pathSeparator;
            assertNull(ThrottleProbe.locate(relDir + sep + "." + sep + "" + sep + "./" + relDir, List.of()));
            // a later absolute entry is still used
            Path exe = abs.resolve("vcgencmd");
            Files.writeString(exe, "#!/bin/sh\n");
            assertTrue(exe.toFile().setExecutable(true));
            assertEquals(exe, ThrottleProbe.locate(relDir + sep + "." + sep + sep + abs, List.of()));
        } finally {
            Files.deleteIfExists(planted);
        }
    }

    // ---------- real subprocesses ----------

    private static Path script(Path dir, String name, String body) throws IOException {
        Path p = dir.resolve(name);
        Files.writeString(p, "#!/bin/sh\n" + body + "\n", StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rwx------"));
        return p;
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void realProcessHangIsKilledWithinTimeout(@TempDir Path dir) throws Exception {
        Path pidFile = dir.resolve("pid");
        Path exe = script(dir, "hang", "echo $$ > " + pidFile + "\nexec sleep 30");
        long t0 = System.nanoTime();
        assertThrows(ThrottleProbe.TimedOut.class, () -> new ThrottleProbe.ProcessRunner().run(exe, "get_throttled", 1_000));
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertTrue(ms < 2_000, "returned after " + ms + " ms");
        long pid = Long.parseLong(Files.readString(pidFile).trim());
        assertProcessGone(pid);
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void realProcessBackgroundChildHoldingPipeDoesNotBlock(@TempDir Path dir) throws Exception {
        // the parent exits at once, so the orphaned child is no longer our descendant; what matters
        // is that we give up within the timeout instead of waiting for the pipe to close
        Path pidFile = dir.resolve("pid");
        Path exe = script(dir, "fork", "sleep 30 &\necho $! > " + pidFile + "\necho throttled=0x0");
        long t0 = System.nanoTime();
        try {
            assertThrows(ThrottleProbe.TimedOut.class, () -> new ThrottleProbe.ProcessRunner().run(exe, "get_throttled", 1_000));
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 2_000);
        } finally {
            ProcessHandle.of(Long.parseLong(Files.readString(pidFile).trim())).ifPresent(ProcessHandle::destroyForcibly);
        }
    }

    private static void assertProcessGone(long pid) throws InterruptedException {
        for (int i = 0; i < 50; i++) {
            if (ProcessHandle.of(pid).map(h -> !h.isAlive()).orElse(true)) return;
            Thread.sleep(20);
        }
        throw new AssertionError("process " + pid + " still alive");
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void realProcessExitCodeAndOutput(@TempDir Path dir) throws Exception {
        var r = new ThrottleProbe.ProcessRunner();
        assertEquals(new ThrottleProbe.Out(0, "throttled=0x50000\n"), r.run(script(dir, "ok", "echo throttled=0x50000"), "get_throttled", 1_000));
        ThrottleProbe.Out bad = r.run(script(dir, "bad", "echo 'VCHI initialization failed' >&2\nexit 255"), "get_throttled", 1_000);
        assertEquals(255, bad.exitCode());
        assertTrue(bad.output().contains("VCHI"), "stderr merged");
        ThrottleProbe.Out flood = r.run(script(dir, "flood", "head -c 200000 /dev/zero | tr '\\0' x"), "get_throttled", 1_000);
        assertEquals(ThrottleProbe.MAX_OUTPUT_BYTES, flood.output().length(), "output capped, no pipe deadlock");
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void realProcessNotExecutable(@TempDir Path dir) throws IOException {
        Path p = dir.resolve("vcgencmd");
        Files.writeString(p, "#!/bin/sh\necho throttled=0x0\n");
        Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rw-------"));
        assertThrows(IOException.class, () -> new ThrottleProbe.ProcessRunner().run(p, "get_throttled", 1_000));
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void endToEndHangingVcgencmdOmitsAndBacksOff(@TempDir Path dir) throws Exception {
        Path exe = script(dir, "vcgencmd", "exec sleep 30");
        AtomicInteger spawned = new AtomicInteger();
        ThrottleProbe.Runner real = new ThrottleProbe.ProcessRunner();
        ThrottleProbe p = new ThrottleProbe(dir, true, () -> exe, (e, a, t) -> {
            spawned.incrementAndGet();
            return real.run(e, a, t);
        }, logs.logger, clock::get);
        long t0 = System.nanoTime();
        assertNull(p.read(true).throttled());
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 2_000);
        for (int i = 0; i < 10; i++) assertNull(p.read(true).throttled());
        assertEquals(1, spawned.get());
        assertEquals(1, logs.at(Level.INFO).size());
    }
}
