package dev.tickdoctor.agent.transport;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** One-line, human-readable gist of an item for debug-log-payloads (never the whole JSON). */
final class PayloadSummary {
    private PayloadSummary() {}

    static String describe(String path, String itemJson) {
        JsonObject o = JsonParser.parseString(itemJson).getAsJsonObject();
        return switch (path) {
            case "metrics" -> {
                JsonObject t = o.getAsJsonObject("tick");
                JsonObject p = o.getAsJsonObject("players");
                JsonObject a = o.getAsJsonObject("agentOverhead");
                yield String.format("last sample: tps %.1f, mspt avg %.1f p95 %.1f max %.1f, %d slow ticks, %d players, %d worlds, overhead %.3f ms/tick",
                        num(t, "tps1m"), num(t, "msptAvg"), num(t, "msptP95"), num(t, "msptMax"), size(t.get("slowTicks")),
                        (int) num(p, "count"), size(o.get("world")), num(a, "mainThreadMsPerTick"));
            }
            case "events" -> "last event: " + o.get("type").getAsString();
            case "snapshot" -> String.format("trigger %s, p95 %.1f ms, %d worlds, %d recent events",
                    o.get("trigger").getAsString(), num(o, "msptP95AtTrigger"), size(o.get("worldsDetail")), size(o.get("recentEvents")));
            case "hello" -> {
                JsonObject s = o.getAsJsonObject("server");
                yield String.format("%s %s, %d plugins, privacy %s", s.get("software").getAsString(), s.get("softwareVersion").getAsString(),
                        size(o.get("plugins")), o.get("privacyMode").getAsString());
            }
            default -> "";
        };
    }

    private static double num(JsonObject o, String k) {
        JsonElement e = o == null ? null : o.get(k);
        return e == null ? 0 : e.getAsDouble();
    }

    private static int size(JsonElement e) {
        return e instanceof JsonArray a ? a.size() : 0;
    }
}
