package dev.tickdoctor.agent.model;

import dev.tickdoctor.agent.util.Num;

/** Host metrics. Anything unavailable stays null and is omitted — never sent as 0. */
public record HostSample(
        Double cpuLoad1m,
        Double cpuUsage,
        Double cpuTempC,
        Throttled throttled,
        Long memTotalBytes,
        Long memAvailableBytes,
        Long swapTotalBytes,
        Long swapUsedBytes,
        Long diskTotalBytes,
        Long diskUsedBytes,
        Double diskReadBytesPerSec,
        Double diskWriteBytesPerSec,
        Double netRxBytesPerSec,
        Double netTxBytesPerSec) {

    public HostSample {
        memTotalBytes = Num.nonNegLong(memTotalBytes);
        memAvailableBytes = Num.nonNegLong(memAvailableBytes);
        swapTotalBytes = Num.nonNegLong(swapTotalBytes);
        swapUsedBytes = Num.nonNegLong(swapUsedBytes);
        diskTotalBytes = Num.nonNegLong(diskTotalBytes);
        diskUsedBytes = Num.nonNegLong(diskUsedBytes);
    }

    public record Throttled(boolean now, boolean sinceBoot, String raw) {}

    public boolean isEmpty() {
        return cpuLoad1m == null && cpuUsage == null && cpuTempC == null && throttled == null
                && memTotalBytes == null && memAvailableBytes == null && swapTotalBytes == null
                && swapUsedBytes == null && diskTotalBytes == null && diskUsedBytes == null
                && diskReadBytesPerSec == null && diskWriteBytesPerSec == null
                && netRxBytesPerSec == null && netTxBytesPerSec == null;
    }
}
