package dev.tickdoctor.agent.collectors.host;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tickdoctor.agent.model.HostSample;
import java.io.File;
import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcParsersTest {
    static Path resource(String rel) {
        try {
            return Path.of(ProcParsersTest.class.getResource("/" + rel).toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    static String read(String rel) throws IOException {
        return Files.readString(resource(rel), StandardCharsets.ISO_8859_1);
    }

    @Test
    void cpuUsageFromTwoStatReadings() throws IOException {
        long[] a = ProcParsers.cpuTotals(read("pi5/proc/stat"));
        long[] b = ProcParsers.cpuTotals(read("pi5-t2/proc/stat"));
        assertNotNull(a);
        assertEquals(1834213L + 3121 + 402118 + 52811934 + 21877 + 9821, a[0]);
        assertEquals(52811934L + 21877, a[1]);
        assertEquals(0.39320, ProcParsers.cpuUsage(a, b), 1e-4);
        assertNull(ProcParsers.cpuUsage(null, b));
        assertNull(ProcParsers.cpuUsage(b, a)); // counter went backwards
        assertNull(ProcParsers.cpuTotals("garbage"));
    }

    @Test
    void loadAndMemory() throws IOException {
        assertEquals(0.87, ProcParsers.loadAvg1m(read("pi5/proc/loadavg")));
        Map<String, Long> m = ProcParsers.memInfo(read("pi5/proc/meminfo"));
        assertEquals(8245328L * 1024, m.get("MemTotal"));
        assertEquals(4112876L * 1024, m.get("MemAvailable"));
        assertEquals(2097136L * 1024, m.get("SwapTotal"));
        assertEquals(2061296L * 1024, m.get("SwapFree"));
        assertNull(ProcParsers.loadAvg1m(""));
    }

    @Test
    void diskStatsSumPhysicalDisksOnly() throws IOException {
        Map<String, long[]> d = ProcParsers.diskStats(read("pi5/proc/diskstats"));
        assertArrayEquals(new long[] {41239112, 98123344}, d.get("nvme0n1"));
        long[] withSys = ProcParsers.physicalDiskSectors(d, Set.of("nvme0n1", "mmcblk0", "zram0", "loop0"));
        assertArrayEquals(new long[] {41239112L + 61230, 98123344L}, withSys);
        long[] heuristic = ProcParsers.physicalDiskSectors(d, null);
        assertArrayEquals(withSys, heuristic, "partition heuristic must match /sys/block");
        assertTrue(ProcParsers.isPartition("nvme0n1p2", d.keySet()));
        assertTrue(ProcParsers.isPartition("mmcblk0p1", d.keySet()));
        assertFalse(ProcParsers.isPartition("nvme0n1", d.keySet()));
        assertTrue(ProcParsers.isVirtual("zram0"));
    }

    @Test
    void networkSkipsLoopbackAndVpn() throws IOException {
        long[] n = ProcParsers.netTotals(read("pi5/proc/net/dev"));
        assertArrayEquals(new long[] {9812331245L, 21334123344L}, n);
    }

    @Test
    void thermalAndVcgencmd() throws IOException {
        assertEquals(52.35, ProcParsers.thermalMilliC(read("pi5/sys/class/thermal/thermal_zone0/temp")), 1e-9);
        assertNull(ProcParsers.thermalMilliC("999999"));
        assertEquals(48.3, ProcParsers.vcgencmdTemp("temp=48.3'C"));
        assertNull(ProcParsers.vcgencmdTemp("error"));

        HostSample.Throttled ok = ProcParsers.vcgencmdThrottled("throttled=0x0");
        assertFalse(ok.now());
        assertFalse(ok.sinceBoot());
        HostSample.Throttled past = ProcParsers.vcgencmdThrottled("throttled=0x50000");
        assertFalse(past.now());
        assertTrue(past.sinceBoot());
        assertEquals("0x50000", past.raw());
        HostSample.Throttled now = ProcParsers.vcgencmdThrottled("throttled=0x50005");
        assertTrue(now.now());
        assertTrue(now.sinceBoot());
        assertNull(ProcParsers.vcgencmdThrottled("VCHI initialization failed"));
    }

    @Test
    void deviceModelStripsNul() throws IOException {
        assertEquals("Raspberry Pi 5 Model B Rev 1.0", ProcParsers.deviceModel(read("pi5/proc/device-tree/model")));
    }

    @Test
    void hostCollectorOverAFakePiRoot(@TempDir Path tmp) throws IOException {
        copyTree(resource("pi5"), tmp);
        File serverDir = tmp.toFile();
        HostCollector c = new HostCollector(tmp, serverDir, null);
        assertTrue(c.isLinux());
        HostSample first = c.sample(1_000_000_000L);
        assertEquals(0.87, first.cpuLoad1m());
        assertNull(first.cpuUsage(), "no delta yet");
        assertNull(first.diskReadBytesPerSec());
        assertEquals(8245328L * 1024, first.memTotalBytes());
        assertEquals((2097136L - 2061296L) * 1024, first.swapUsedBytes());
        assertEquals(52.35, first.cpuTempC(), 0.051);
        assertNull(first.throttled(), "no vcgencmd");
        assertNotNull(first.diskTotalBytes());
        assertEquals("Raspberry Pi 5 Model B Rev 1.0", c.deviceModel());

        copyTree(resource("pi5-t2"), tmp);
        HostSample second = c.sample(11_000_000_000L); // 10 s later
        assertEquals(0.3932, second.cpuUsage(), 1e-4);
        assertEquals(20480 * 512 / 10.0, second.diskReadBytesPerSec(), 1e-6);
        assertEquals(20480 * 512 / 10.0, second.diskWriteBytesPerSec(), 1e-6);
        assertEquals(10_000.0, second.netRxBytesPerSec(), 1e-6);
        assertEquals(50_000.0, second.netTxBytesPerSec(), 1e-6);
    }

    @Test
    void nonLinuxHostOmitsEverythingButDisk(@TempDir Path tmp) {
        HostCollector c = new HostCollector(tmp, tmp.toFile(), null);
        HostSample s = c.sample(1);
        assertFalse(c.isLinux());
        assertNull(s.cpuLoad1m());
        assertNull(s.memTotalBytes());
        assertNull(s.cpuTempC());
        assertNotNull(s.diskTotalBytes());
    }

    static void copyTree(Path from, Path to) throws IOException {
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : s.toList()) {
                Path dest = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) Files.createDirectories(dest);
                else Files.copy(p, dest, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }
}
