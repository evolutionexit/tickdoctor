package dev.tickdoctor.agent.collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class JvmCollectorTest {
    @Test
    void unavailableCpuLoadReportsTheLastGoodValue() {
        assertEquals(0.25, JvmCollector.cpuOrLastGood(0.25));
        assertEquals(0.25, JvmCollector.cpuOrLastGood(-1), "negative = not available yet");
        assertEquals(0.25, JvmCollector.cpuOrLastGood(Double.NaN));
        assertEquals(1.0, JvmCollector.cpuOrLastGood(1.5));
    }
}
