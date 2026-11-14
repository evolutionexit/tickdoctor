package dev.tickdoctor.agent.collectors.host;

import dev.tickdoctor.agent.model.HostSample;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Pure parsers for /proc, /sys and vcgencmd output. Malformed input yields null/empty, never throws. */
public final class ProcParsers {
    private ProcParsers() {}

    /** Aggregate "cpu" line of /proc/stat → {total jiffies, idle jiffies (idle + iowait)}. */
    public static long[] cpuTotals(String stat) {
        if (stat == null) return null;
        for (String line : stat.split("\n")) {
            if (!line.startsWith("cpu ")) continue;
            String[] f = line.trim().split("\\s+");
            if (f.length < 5) return null;
            long total = 0;
            // user nice system idle iowait irq softirq steal (guest/guest_nice are already in user/nice)
            int fields = Math.min(f.length - 1, 8);
            long[] v = new long[fields];
            try {
                for (int i = 0; i < fields; i++) {
                    v[i] = Long.parseLong(f[i + 1]);
                    total += v[i];
                }
            } catch (NumberFormatException e) {
                return null;
            }
            long idle = v[3] + (fields > 4 ? v[4] : 0);
            return new long[] {total, idle};
        }
        return null;
    }

    /** CPU busy ratio between two {@link #cpuTotals} readings, or null. */
    public static Double cpuUsage(long[] prev, long[] now) {
        if (prev == null || now == null) return null;
        long dt = now[0] - prev[0];
        long di = now[1] - prev[1];
        if (dt <= 0 || di < 0) return null;
        double u = 1.0 - (double) di / dt;
        return Math.max(0, Math.min(1, u));
    }

    /** First field of /proc/loadavg. */
    public static Double loadAvg1m(String loadavg) {
        if (loadavg == null) return null;
        String[] f = loadavg.trim().split("\\s+");
        if (f.length == 0) return null;
        try {
            double v = Double.parseDouble(f[0]);
            return v >= 0 && Double.isFinite(v) ? v : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** /proc/meminfo → bytes per key (values in kB are multiplied by 1024). */
    public static Map<String, Long> memInfo(String meminfo) {
        Map<String, Long> out = new HashMap<>();
        if (meminfo == null) return out;
        for (String line : meminfo.split("\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String[] f = line.substring(colon + 1).trim().split("\\s+");
            if (f.length == 0) continue;
            try {
                long v = Long.parseLong(f[0]);
                if (f.length > 1 && f[1].equalsIgnoreCase("kB")) v *= 1024;
                out.put(line.substring(0, colon).trim(), v);
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
        return out;
    }

    /** /proc/diskstats → device → {sectorsRead, sectorsWritten} (sectors are always 512 bytes here). */
    public static Map<String, long[]> diskStats(String diskstats) {
        Map<String, long[]> out = new LinkedHashMap<>();
        if (diskstats == null) return out;
        for (String line : diskstats.split("\n")) {
            String[] f = line.trim().split("\\s+");
            if (f.length < 10) continue;
            try {
                out.put(f[2], new long[] {Long.parseLong(f[5]), Long.parseLong(f[9])});
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
        return out;
    }

    /**
     * Sums read/write sectors over physical whole disks. If {@code sysBlock} (names in
     * /sys/block) is known it decides; otherwise a name heuristic drops partitions. Virtual devices
     * (loop, ram, zram, dm-, md, sr, fd) are always excluded.
     */
    public static long[] physicalDiskSectors(Map<String, long[]> stats, Set<String> sysBlock) {
        long r = 0;
        long w = 0;
        boolean any = false;
        for (Map.Entry<String, long[]> e : stats.entrySet()) {
            String name = e.getKey();
            if (isVirtual(name)) continue;
            if (sysBlock != null && !sysBlock.isEmpty()) {
                if (!sysBlock.contains(name)) continue;
            } else if (isPartition(name, stats.keySet())) {
                continue;
            }
            r += e.getValue()[0];
            w += e.getValue()[1];
            any = true;
        }
        return any ? new long[] {r, w} : null;
    }

    static boolean isVirtual(String name) {
        return name.startsWith("loop") || name.startsWith("ram") || name.startsWith("zram")
                || name.startsWith("dm-") || name.startsWith("md") || name.startsWith("sr") || name.startsWith("fd");
    }

    static boolean isPartition(String name, Iterable<String> all) {
        for (String other : all) {
            if (other.equals(name) || !name.startsWith(other)) continue;
            String rest = name.substring(other.length());
            if (rest.matches("p?\\d+")) return true;
        }
        return false;
    }

    private static final List<String> SKIP_IFACES = List.of("lo", "tailscale", "wg", "tun", "docker", "veth", "br-", "virbr", "zt");

    /** /proc/net/dev → {rxBytes, txBytes} summed over real interfaces (not loopback, VPN or bridges). */
    public static long[] netTotals(String netdev) {
        if (netdev == null) return null;
        long rx = 0;
        long tx = 0;
        boolean any = false;
        for (String line : netdev.split("\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String iface = line.substring(0, colon).trim();
            boolean skip = false;
            for (String p : SKIP_IFACES) {
                if (iface.equals(p) || (!p.equals("lo") && iface.startsWith(p))) {
                    skip = true;
                    break;
                }
            }
            if (skip) continue;
            String[] f = line.substring(colon + 1).trim().split("\\s+");
            if (f.length < 9) continue;
            try {
                rx += Long.parseLong(f[0]);
                tx += Long.parseLong(f[8]);
                any = true;
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
        return any ? new long[] {rx, tx} : null;
    }

    /** /sys/class/thermal/thermal_zone*\/temp (millidegrees C) → °C, or null if out of range. */
    public static Double thermalMilliC(String s) {
        if (s == null) return null;
        try {
            double c = Long.parseLong(s.trim()) / 1000.0;
            return c >= -50 && c <= 150 ? c : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** "temp=48.3'C" → 48.3. */
    public static Double vcgencmdTemp(String s) {
        if (s == null) return null;
        int eq = s.indexOf('=');
        if (eq < 0) return null;
        String v = s.substring(eq + 1).replace("'C", "").replace("°C", "").trim();
        try {
            double c = Double.parseDouble(v);
            return c >= -50 && c <= 150 ? c : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * "throttled=0x50005" → now = any of bits 0–3 (under-voltage, freq capped, throttled, soft
     * temp limit); sinceBoot = any of bits 16–19.
     */
    public static HostSample.Throttled vcgencmdThrottled(String s) {
        if (s == null) return null;
        s = s.strip();
        if (!s.startsWith("throttled=") || s.indexOf('\n') >= 0) return null;
        String raw = s.substring("throttled=".length()).trim();
        try {
            long v = raw.startsWith("0x") || raw.startsWith("0X") ? Long.parseLong(raw.substring(2), 16) : Long.parseLong(raw);
            if (v < 0) return null;
            return new HostSample.Throttled((v & 0xFL) != 0, (v & 0xF0000L) != 0, raw.length() <= 20 ? raw : raw.substring(0, 20));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** /proc/device-tree/model is NUL-terminated. */
    public static String deviceModel(String s) {
        if (s == null) return null;
        String m = s.replace("\u0000", "").trim();
        return m.isEmpty() ? null : m;
    }
}
