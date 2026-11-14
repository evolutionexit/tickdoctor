package dev.tickdoctor.agent.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Random;
import org.junit.jupiter.api.Test;

class BackoffTest {
    @Test
    void growsFrom5sTo5minWithJitter() {
        Backoff b = new Backoff(new Random(42));
        long first = b.nextDelayMs();
        assertTrue(first >= 5_000 && first <= 6_000, "first " + first);
        long prevBase = 5_000;
        for (int i = 1; i < 20; i++) {
            long d = b.nextDelayMs();
            long base = Math.min(Backoff.MAX_MS, 5_000L << i);
            assertTrue(d >= Math.max(Backoff.BASE_MS, (long) (base * 0.8)) - 1 && d <= Backoff.MAX_MS, "attempt " + i + ": " + d);
            assertTrue(base >= prevBase);
            prevBase = base;
        }
        // saturated: always within [240 s, 300 s]
        for (int i = 0; i < 100; i++) {
            long d = b.nextDelayMs();
            assertTrue(d >= 240_000 && d <= 300_000, String.valueOf(d));
        }
    }

    @Test
    void jitterSpreadsClients() {
        Backoff a = new Backoff(new Random(1));
        Backoff c = new Backoff(new Random(2));
        a.nextDelayMs();
        c.nextDelayMs();
        assertTrue(a.nextDelayMs() != c.nextDelayMs());
    }

    @Test
    void resetStartsOver() {
        Backoff b = new Backoff(new Random(3));
        for (int i = 0; i < 8; i++) b.nextDelayMs();
        b.reset();
        assertEquals(0, b.failures());
        assertTrue(b.nextDelayMs() <= 6_000);
    }

    @Test
    void honoursRetryAfter() {
        Backoff b = new Backoff(new Random(4));
        long d = b.retryAfterMs(30);
        assertTrue(d >= 30_000 && d <= 31_000, String.valueOf(d));
        assertTrue(b.retryAfterMs(0) >= 1_000);
        assertTrue(b.retryAfterMs(1_000_000) <= 3_601_000);
        long fallback = new Backoff(new Random(5)).retryAfterMs(null);
        assertTrue(fallback >= 5_000 && fallback <= 6_000);
    }
}
