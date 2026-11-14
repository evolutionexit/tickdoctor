package dev.tickdoctor.agent.transport;

import java.util.List;

/**
 * Request bodies: {@code {schemaVersion, agentVersion, sentAt, bootId, payload}}. Items are
 * already-serialized JSON (from memory or the disk buffer), so the body is assembled by
 * concatenation rather than re-parsing.
 */
public final class Envelopes {
    public static final int SCHEMA_VERSION = 1;

    private Envelopes() {}

    public static String wrap(String payloadJson, String agentVersion, String sentAt, String bootId) {
        return "{\"schemaVersion\":" + SCHEMA_VERSION + ",\"agentVersion\":\"" + agentVersion + "\",\"sentAt\":\"" + sentAt
                + "\",\"bootId\":\"" + bootId + "\",\"payload\":" + payloadJson + "}";
    }

    public static String wrap(Kind kind, List<String> items, String agentVersion, String sentAt, String bootId) {
        String payload = switch (kind) {
            case METRICS -> "{\"samples\":[" + String.join(",", items) + "]}";
            case EVENTS -> "{\"events\":[" + String.join(",", items) + "]}";
            case SNAPSHOT -> items.get(0);
        };
        return wrap(payload, agentVersion, sentAt, bootId);
    }
}
