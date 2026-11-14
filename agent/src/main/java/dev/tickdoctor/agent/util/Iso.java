package dev.tickdoctor.agent.util;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/** ISO-8601 UTC timestamps with millisecond precision ("2026-11-09T10:00:00.123Z"). */
public final class Iso {
    private Iso() {}

    public static String ts(long epochMillis) {
        return Instant.ofEpochMilli(epochMillis).toString();
    }

    public static String now() {
        return Instant.now().truncatedTo(ChronoUnit.MILLIS).toString();
    }
}
