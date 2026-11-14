package dev.tickdoctor.agent.privacy;

import java.util.Locale;

/**
 * The {@code privacy-mode} config value, reported in hello. Since 0.1.5 both modes behave the same:
 * no player identifiers are sent at all (pings are bare values, join/leave carry only the count).
 */
public enum PrivacyMode {
    HASHED("hashed"),
    NONE("none");

    private final String wire;

    PrivacyMode(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** Unknown values fall back to the safe default, hashed. */
    public static PrivacyMode parse(String s) {
        if (s != null && s.trim().toLowerCase(Locale.ROOT).equals("none")) return NONE;
        return HASHED;
    }
}
