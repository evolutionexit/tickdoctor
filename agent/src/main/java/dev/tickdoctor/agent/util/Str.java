package dev.tickdoctor.agent.util;

/** String helpers that keep values within the contract's max lengths. */
public final class Str {
    private Str() {}

    /** Truncates to at most {@code max} UTF-16 chars without splitting a surrogate pair. */
    public static String cap(String s, int max) {
        if (s == null || s.length() <= max) return s;
        int end = max;
        if (end > 0 && Character.isHighSurrogate(s.charAt(end - 1))) end--;
        return s.substring(0, end);
    }

    /** Like {@link #cap} but never returns null or blank (contract fields with minLength 1). */
    public static String nonEmpty(String s, String fallback, int max) {
        if (s == null || s.isBlank()) s = fallback;
        return cap(s, max);
    }

    public static String capOrNull(String s, int max) {
        if (s == null || s.isBlank()) return null;
        return cap(s, max);
    }
}
