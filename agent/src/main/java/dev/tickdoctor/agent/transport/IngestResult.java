package dev.tickdoctor.agent.transport;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Classified response from an ingest endpoint. */
public sealed interface IngestResult {
    record Ok(RemoteConfig config) implements IngestResult {}

    /** 401 invalid_key / revoked_key: stop sending until the key is fixed. */
    record AuthFailed(String error, String message) implements IngestResult {}

    /** 400 invalid_payload: drop the batch. */
    record Invalid(String message) implements IngestResult {}

    /** 429: wait retryAfterSeconds, keep buffering. */
    record RateLimited(Integer retryAfterSeconds) implements IngestResult {}

    /** 402 plan_limit: keep buffering, retry with backoff. */
    record PlanLimit(String message) implements IngestResult {}

    /** 413: split the batch. */
    record TooLarge() implements IngestResult {}

    /** Plain-http api-url pointing at a public address: never send (the key would travel in clear text). */
    record InsecureUrl(String message) implements IngestResult {}

    /**
     * The sending thread was interrupted, or the client was closed mid-request (stop/reload). Not
     * an API failure: nothing is logged and the state is unchanged; the batch is moved to the disk
     * buffer so it survives the shutdown and is sent after the restart.
     */
    record Interrupted() implements IngestResult {}

    /** Network error, 5xx, unexpected status: retry with backoff. */
    record Retryable(String reason) implements IngestResult {}

    static IngestResult classify(int status, String body) {
        JsonObject o = parse(body);
        String error = str(o, "error");
        String message = str(o, "message");
        if (status >= 200 && status < 300) return new Ok(o == null ? RemoteConfig.NONE : RemoteConfig.parse(o.get("config")));
        return switch (status) {
            case 401 -> new AuthFailed(error == null ? "invalid_key" : error, message);
            case 400 -> new Invalid(message != null ? message : error);
            case 402 -> new PlanLimit(message != null ? message : error);
            case 413 -> new TooLarge();
            case 429 -> new RateLimited(intOrNull(o, "retryAfterSeconds"));
            default -> new Retryable("HTTP " + status + (error != null ? " " + error : ""));
        };
    }

    private static JsonObject parse(String body) {
        if (body == null || body.isBlank()) return null;
        try {
            JsonElement e = JsonParser.parseString(body);
            return e.isJsonObject() ? e.getAsJsonObject() : null;
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private static String str(JsonObject o, String k) {
        if (o == null) return null;
        JsonElement e = o.get(k);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
    }

    private static Integer intOrNull(JsonObject o, String k) {
        if (o == null) return null;
        JsonElement e = o.get(k);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return null;
        double d = e.getAsDouble();
        return Double.isFinite(d) && d >= 0 ? (int) Math.min(Integer.MAX_VALUE, Math.ceil(d)) : null;
    }
}
