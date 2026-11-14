package dev.tickdoctor.agent.collectors.host;

import dev.tickdoctor.agent.model.HostSample;
import dev.tickdoctor.agent.util.Num;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * Host metrics from /proc, /sys and vcgencmd. Runs async. Every source is optional; anything that
 * can't be read is left null (omitted). Rates need two readings, so the first sample has none.
 */
public final class HostCollector {
    private final Path root;
    private final File serverDir;
    private final boolean linux;
    private final ThrottleProbe throttle;

    private long[] prevCpu;
    private long[] prevDisk;
    private long[] prevNet;
    private long prevNanos;
    private volatile HostSample last;

    /**
     * @param root     "/" in production; a fake root in tests
     * @param throttle vcgencmd probe, or null to never report {@code throttled}
     */
    public HostCollector(Path root, File serverDir, ThrottleProbe throttle) {
        this.root = root;
        this.serverDir = serverDir;
        this.linux = Files.isReadable(root.resolve("proc/stat"));
        this.throttle = throttle;
    }

    public static HostCollector forThisMachine(File serverDir, Logger log) {
        return new HostCollector(Path.of("/"), serverDir, ThrottleProbe.forThisMachine(log));
    }

    public boolean isLinux() {
        return linux;
    }

    public HostSample last() {
        return last;
    }

    /** Takes a new reading; deltas are relative to the previous call. */
    public HostSample sample(long nowNanos) {
        Double load = null;
        Double cpuUsage = null;
        Double temp = null;
        HostSample.Throttled throttled = null;
        Long memTotal = null;
        Long memAvail = null;
        Long swapTotal = null;
        Long swapUsed = null;
        Double diskR = null;
        Double diskW = null;
        Double netRx = null;
        Double netTx = null;
        double dtSec = prevNanos == 0 ? 0 : (nowNanos - prevNanos) / 1e9;

        if (linux) {
            load = ProcParsers.loadAvg1m(read("proc/loadavg"));
            long[] cpu = ProcParsers.cpuTotals(read("proc/stat"));
            cpuUsage = ProcParsers.cpuUsage(prevCpu, cpu);
            if (cpuUsage != null) cpuUsage = Num.ratio(cpuUsage);
            if (cpu != null) prevCpu = cpu;

            Map<String, Long> mem = ProcParsers.memInfo(read("proc/meminfo"));
            memTotal = mem.get("MemTotal");
            memAvail = mem.get("MemAvailable");
            swapTotal = mem.get("SwapTotal");
            Long swapFree = mem.get("SwapFree");
            if (swapTotal != null && swapFree != null) swapUsed = Math.max(0, swapTotal - swapFree);

            long[] disk = ProcParsers.physicalDiskSectors(ProcParsers.diskStats(read("proc/diskstats")), sysBlock());
            if (disk != null && prevDisk != null && dtSec > 0) {
                diskR = Num.nonNeg((disk[0] - prevDisk[0]) * 512.0 / dtSec);
                diskW = Num.nonNeg((disk[1] - prevDisk[1]) * 512.0 / dtSec);
            }
            if (disk != null) prevDisk = disk;

            long[] net = ProcParsers.netTotals(read("proc/net/dev"));
            if (net != null && prevNet != null && dtSec > 0) {
                netRx = Num.nonNeg((net[0] - prevNet[0]) / dtSec);
                netTx = Num.nonNeg((net[1] - prevNet[1]) / dtSec);
            }
            if (net != null) prevNet = net;

            temp = cpuTemp();
        }
        if (throttle != null) {
            ThrottleProbe.Reading r = throttle.read(temp == null);
            throttled = r.throttled();
            if (temp == null) temp = r.tempC();
        }
        prevNanos = nowNanos;

        Long diskTotal = null;
        Long diskUsed = null;
        if (serverDir != null) {
            long total = serverDir.getTotalSpace();
            long free = serverDir.getFreeSpace();
            if (total > 0) {
                diskTotal = total;
                diskUsed = Math.max(0, total - free);
            }
        }
        HostSample s = new HostSample(
                load == null ? null : Num.nonNeg(load), cpuUsage, temp == null ? null : Math.round(temp * 10) / 10.0, throttled,
                memTotal, memAvail, swapTotal, swapUsed, diskTotal, diskUsed, diskR, diskW, netRx, netTx);
        last = s;
        return s;
    }

    /** Model + total memory, for hello. */
    public String deviceModel() {
        return ProcParsers.deviceModel(read("proc/device-tree/model"));
    }

    public Long memTotalBytes() {
        return linux ? ProcParsers.memInfo(read("proc/meminfo")).get("MemTotal") : null;
    }

    private Double cpuTemp() {
        // Prefer a zone whose type mentions cpu/soc; fall back to thermal_zone0.
        Path thermal = root.resolve("sys/class/thermal");
        if (!Files.isDirectory(thermal)) return null;
        Double fallback = null;
        try (Stream<Path> zones = Files.list(thermal)) {
            for (Path z : zones.filter(p -> p.getFileName().toString().startsWith("thermal_zone")).sorted().toList()) {
                Double c = ProcParsers.thermalMilliC(readAbs(z.resolve("temp")));
                if (c == null) continue;
                String type = readAbs(z.resolve("type"));
                if (type != null && (type.contains("cpu") || type.contains("soc"))) return c;
                if (fallback == null) fallback = c;
            }
        } catch (IOException ignored) {
            // no thermal info
        }
        return fallback;
    }

    private Set<String> sysBlock() {
        Path p = root.resolve("sys/block");
        if (!Files.isDirectory(p)) return null;
        Set<String> s = new HashSet<>();
        try (Stream<Path> l = Files.list(p)) {
            l.forEach(x -> s.add(x.getFileName().toString()));
        } catch (IOException e) {
            return null;
        }
        return s;
    }

    private String read(String rel) {
        return readAbs(root.resolve(rel));
    }

    private static String readAbs(Path p) {
        try {
            return Files.readString(p, StandardCharsets.ISO_8859_1);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }
}
