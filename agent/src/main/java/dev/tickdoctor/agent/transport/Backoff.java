package dev.tickdoctor.agent.transport;

import java.util.random.RandomGenerator;

/** Exponential backoff 5 s → 5 min with ±20 % jitter; 429 uses the server's retryAfterSeconds. */
public final class Backoff {
    public static final long BASE_MS = 5_000;
    public static final long MAX_MS = 300_000;

    private final RandomGenerator random;
    private int failures;

    public Backoff(RandomGenerator random) {
        this.random = random;
    }

    /** Delay before the next attempt after another failure. Always within [5 s, 5 min]. */
    public long nextDelayMs() {
        long exp = BASE_MS << Math.min(failures, 10);
        if (exp > MAX_MS) exp = MAX_MS;
        failures++;
        double factor = 0.8 + 0.4 * random.nextDouble();
        long d = Math.round(exp * factor);
        return Math.max(BASE_MS, Math.min(MAX_MS, d));
    }

    /** Honour 429 retryAfterSeconds (at least 1 s, at most 1 h) plus up to 1 s jitter. */
    public long retryAfterMs(Integer retryAfterSeconds) {
        if (retryAfterSeconds == null) return nextDelayMs();
        failures++;
        long s = Math.max(1, Math.min(3600, retryAfterSeconds));
        return s * 1000 + random.nextLong(1001);
    }

    public void reset() {
        failures = 0;
    }

    public int failures() {
        return failures;
    }
}
