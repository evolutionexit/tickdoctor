package dev.tickdoctor.agent;

import dev.tickdoctor.agent.privacy.PrivacyMode;
import dev.tickdoctor.agent.transport.RemoteConfig;
import dev.tickdoctor.agent.transport.UrlPolicy;

/** Validated config.yml values. Out-of-range values are clamped to the same bounds the API uses. */
public record AgentConfig(
        String apiKey,
        String apiUrl,
        int metricsIntervalSeconds,
        PrivacyMode privacyMode,
        double snapshotMsptThreshold,
        long bufferMaxBytes,
        boolean debugLogPayloads) {

    public static final String DEFAULT_URL = "http://localhost:4000";

    public static AgentConfig of(String apiKey, String apiUrl, long intervalSeconds, String privacy,
                                 double thresholdMs, double bufferMb, boolean debug) {
        String url = apiUrl == null || apiUrl.isBlank() ? DEFAULT_URL : apiUrl.trim();
        double mb = Double.isFinite(bufferMb) ? Math.max(1, Math.min(1024, bufferMb)) : 50;
        return new AgentConfig(
                apiKey == null ? "" : apiKey.trim(),
                url,
                RemoteConfig.clampInterval(intervalSeconds),
                PrivacyMode.parse(privacy),
                RemoteConfig.clampThreshold(thresholdMs),
                (long) (mb * 1024 * 1024),
                debug);
    }

    public static final String KEY_PREFIX = "td_live_";
    /** Where to get a key (Phase 5 adds the dashboard; until then the API's CLI prints one). */
    public static final String KEY_SOURCE = "your TickDoctor dashboard";

    public enum KeyStatus {
        /** Empty: stay idle. */
        MISSING,
        /** Still an example value from docs/config: stay idle. */
        PLACEHOLDER,
        /** Doesn't look like td_live_…: warn once, still try (the API decides). */
        UNUSUAL,
        OK
    }

    public KeyStatus keyStatus() {
        return keyStatus(apiKey);
    }

    static KeyStatus keyStatus(String key) {
        String k = key == null ? "" : key.trim();
        if (k.isEmpty()) return KeyStatus.MISSING;
        String lower = k.toLowerCase(java.util.Locale.ROOT);
        if (lower.equals("td_live_xxx") || lower.equals("td_live_") || lower.matches("td_live_(x+|\\.{3}|…|<.*>|your.*|changeme)")
                || lower.matches("<.*>|your[-_ ]?(api[-_ ]?)?key.*|changeme|change-me|x{3,16}|\\.{3}|…")) {
            return KeyStatus.PLACEHOLDER;
        }
        return k.startsWith(KEY_PREFIX) ? KeyStatus.OK : KeyStatus.UNUSUAL;
    }

    public boolean hasKey() {
        KeyStatus s = keyStatus();
        return s == KeyStatus.OK || s == KeyStatus.UNUSUAL;
    }

    public boolean urlLooksValid() {
        return apiUrl.startsWith("http://") || apiUrl.startsWith("https://");
    }

    /** TLS guard: false if this is plain http:// to a public IP (hostnames are checked again after DNS). */
    public boolean urlTransportAllowed() {
        return UrlPolicy.check(apiUrl) != UrlPolicy.Verdict.REFUSED;
    }
}
