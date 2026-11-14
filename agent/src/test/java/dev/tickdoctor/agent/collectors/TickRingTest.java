package dev.tickdoctor.agent.collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TickRingTest {
    @Test
    void nearestRankPercentile() {
        double[] s = new double[100];
        for (int i = 0; i < 100; i++) s[i] = i + 1; // 1..100
        assertEquals(95, TickRing.percentile(s, 0.95));
        assertEquals(99, TickRing.percentile(s, 0.99));
        assertEquals(100, TickRing.percentile(s, 1.0));
        assertEquals(1, TickRing.percentile(s, 0.0));
        assertEquals(0, TickRing.percentile(new double[0], 0.95));
        assertEquals(7, TickRing.percentile(new double[] {7}, 0.95));
        // small sample: ceil(0.95*3)=3 → the max
        assertEquals(30, TickRing.percentile(new double[] {10, 20, 30}, 0.95));
    }

    @Test
    void statsOverAWindow() {
        TickRing r = new TickRing(100);
        for (int i = 1; i <= 20; i++) r.record(1_000L * i, i); // 1..20 ms
        TickRing.Stats s = r.stats(0, r.written());
        assertEquals(20, s.count());
        assertEquals(10.5, s.avg(), 1e-9);
        assertEquals(19, s.p95()); // ceil(19)=19th
        assertEquals(20, s.p99());
        assertEquals(20, s.max());
        assertTrue(s.slowTicks().isEmpty());
        assertEquals(0, r.stats(5, 5).count());
    }

    @Test
    void wrapsAroundWithoutLosingTheNewestTicks() {
        TickRing r = new TickRing(10);
        for (int i = 0; i < 25; i++) r.record(i, i);
        assertEquals(25, r.written());
        TickRing.Stats s = r.stats(0, r.written()); // asks for all 25, only the last ~9 still exist
        assertTrue(s.count() <= 10 && s.count() >= 9);
        assertEquals(24, s.max());
    }

    @Test
    void slowTicksCappedToTheWorstHundredInTimeOrder() {
        TickRing r = new TickRing(1000);
        for (int i = 0; i < 300; i++) r.record(1_700_000_000_000L + i * 50L, 51 + i); // all slow, increasing
        TickRing.Stats s = r.stats(0, r.written());
        assertEquals(TickRing.MAX_SLOW_TICKS, s.slowTicks().size());
        assertEquals(251.0, s.slowTicks().get(0).durationMs()); // the 100 longest are the last 100
        assertEquals(350.0, s.slowTicks().get(99).durationMs());
        assertTrue(s.slowTicks().get(0).ts().endsWith("Z"));
    }

    @Test
    void onlyTicksOver50msAreSlow() {
        TickRing r = new TickRing(10);
        r.record(1, 50.0);
        r.record(2, 50.01);
        assertEquals(1, r.stats(0, 2).slowTicks().size());
    }

    @Test
    void seqSinceFindsTheTimeWindow() {
        TickRing r = new TickRing(100);
        for (int i = 0; i < 50; i++) r.record(i * 100L, 1);
        assertEquals(40, r.seqSince(4_000));
        assertEquals(0, r.seqSince(0));
        assertEquals(50, r.seqSince(99_999));
    }
}
