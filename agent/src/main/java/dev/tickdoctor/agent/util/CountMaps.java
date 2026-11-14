package dev.tickdoctor.agent.util;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Turns raw type counts into contract-sized maps (keys ≤ 100 chars, ≤ 200 keys). */
public final class CountMaps {
    public static final int MAX_KEYS = 200;
    public static final int MAX_KEY_LEN = 100;
    public static final String OTHER = "other";

    private CountMaps() {}

    /**
     * Keeps the {@code top} biggest entries (sorted descending, ties by name) and folds the rest
     * into "other". {@code top} is capped so the result never exceeds {@link #MAX_KEYS} keys.
     */
    public static Map<String, Integer> topN(Map<String, int[]> counts, int top) {
        int keep = Math.min(top, MAX_KEYS - 1);
        List<Map.Entry<String, int[]>> entries = new ArrayList<>(counts.entrySet());
        entries.sort((a, b) -> {
            int c = Integer.compare(b.getValue()[0], a.getValue()[0]);
            return c != 0 ? c : a.getKey().compareTo(b.getKey());
        });
        Map<String, Integer> out = new LinkedHashMap<>();
        long other = 0;
        for (int i = 0; i < entries.size(); i++) {
            Map.Entry<String, int[]> e = entries.get(i);
            String key = Str.cap(e.getKey(), MAX_KEY_LEN);
            if (i < keep && !OTHER.equals(key)) {
                out.merge(key, e.getValue()[0], Integer::sum);
            } else {
                other += e.getValue()[0];
            }
        }
        if (other > 0) out.merge(OTHER, (int) Math.min(Integer.MAX_VALUE, other), Integer::sum);
        return out;
    }

    /** All types, still capped at {@link #MAX_KEYS} keys (the rest folded into "other"). */
    public static Map<String, Integer> all(Map<String, int[]> counts) {
        return topN(counts, MAX_KEYS);
    }
}
