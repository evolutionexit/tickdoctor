package dev.tickdoctor.agent.util;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.HostSample;
import dev.tickdoctor.agent.model.MetricSample;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The API rejects byte counts above Number.MAX_SAFE_INTEGER and counts above int4 max: never emit them. */
class NumBoundsTest {
    @Test
    void byteCountsAreClampedToTheContractMaximum() {
        assertEquals(Num.MAX_BYTES, Num.nonNegLong(Long.MAX_VALUE));
        assertEquals(0, Num.nonNegLong(-5L));
        assertNull(Num.nonNegLong((Long) null));
        var jvm = new MetricSample.Jvm(Long.MAX_VALUE, Long.MAX_VALUE, -1, List.of(), 1, 0.1);
        assertEquals(Num.MAX_BYTES, jvm.heapUsedBytes());
        assertEquals(0, jvm.heapMaxBytes());
        var host = new HostSample(null, null, null, null, Long.MAX_VALUE, null, null, null, null, null, null, null, null, null);
        assertEquals(Num.MAX_BYTES, host.memTotalBytes());
        assertNull(host.swapUsedBytes());
    }

    @Test
    void countsAreClampedToInt4() {
        assertEquals(Num.INT4_MAX, new MetricSample.GcPause("G1", Long.MAX_VALUE, 1, 1).count());
        assertEquals(Num.INT4_MAX, new AgentEvent.CantKeepUp("2026-11-14T10:00:00Z", 1, Long.MAX_VALUE).ticksSkipped());
    }
}
