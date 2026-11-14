package dev.tickdoctor.agent.util;

/** Numeric helpers: payload numbers must be finite; most are non-negative. */
public final class Num {
    private Num() {}

    /** Finite, non-negative, rounded to 3 decimals (keeps payloads small). */
    public static double nonNeg(double v) {
        if (!Double.isFinite(v) || v < 0) return 0;
        return Math.round(v * 1000.0) / 1000.0;
    }

    public static double ratio(double v) {
        if (!Double.isFinite(v) || v < 0) return 0;
        if (v > 1) return 1;
        return Math.round(v * 10000.0) / 10000.0;
    }

    /** Contract maximum for byte counts (Number.MAX_SAFE_INTEGER) and the largest Postgres int4. */
    public static final long MAX_BYTES = 9_007_199_254_740_991L;
    public static final long INT4_MAX = 2_147_483_647L;

    /** Non-negative and at most the contract's byte-count maximum. */
    public static long nonNegLong(long v) {
        return Math.min(MAX_BYTES, Math.max(0, v));
    }

    public static Long nonNegLong(Long v) {
        return v == null ? null : nonNegLong(v.longValue());
    }

    /** Non-negative count that fits the contract's int4 maximum. */
    public static long count(long v) {
        return Math.min(INT4_MAX, Math.max(0, v));
    }

    public static int clampInt(long v, int min, int max) {
        return (int) Math.max(min, Math.min(max, v));
    }

    public static double clamp(double v, double min, double max) {
        if (!Double.isFinite(v)) return min;
        return Math.max(min, Math.min(max, v));
    }
}
