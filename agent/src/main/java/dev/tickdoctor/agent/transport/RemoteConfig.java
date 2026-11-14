package dev.tickdoctor.agent.transport;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The optional {@code config} object in a 200 response. Values outside the contract's bounds are
 * clamped (interval 5–300 s, threshold 20–1000 ms); wrong types are ignored.
 */
public record RemoteConfig(Integer metricsIntervalSeconds, Double snapshotMsptThreshold, boolean requestSnapshot) {
    public static final int MIN_INTERVAL = 5;
    public static final int MAX_INTERVAL = 300;
    public static final double MIN_THRESHOLD = 20;
    public static final double MAX_THRESHOLD = 1000;

    public static final RemoteConfig NONE = new RemoteConfig(null, null, false);

    public static RemoteConfig parse(JsonElement config) {
        if (config == null || !config.isJsonObject()) return NONE;
        JsonObject o = config.getAsJsonObject();
        Integer interval = null;
        Double threshold = null;
        boolean request = false;
        Double i = number(o, "metricsIntervalSeconds");
        if (i != null) interval = clampInterval(Math.round(i));
        Double t = number(o, "snapshotMsptThreshold");
        if (t != null) threshold = clampThreshold(t);
        JsonElement r = o.get("requestSnapshot");
        if (r != null && r.isJsonPrimitive() && r.getAsJsonPrimitive().isBoolean()) request = r.getAsBoolean();
        return new RemoteConfig(interval, threshold, request);
    }

    public static int clampInterval(long seconds) {
        return (int) Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, seconds));
    }

    public static double clampThreshold(double ms) {
        if (!Double.isFinite(ms)) return 50;
        return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, ms));
    }

    private static Double number(JsonObject o, String key) {
        JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return null;
        double d = e.getAsDouble();
        return Double.isFinite(d) ? d : null;
    }
}
