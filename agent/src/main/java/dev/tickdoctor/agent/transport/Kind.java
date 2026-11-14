package dev.tickdoctor.agent.transport;

/** Buffered payload kinds (hello is never buffered — the latest one is re-sent from memory). */
public enum Kind {
    METRICS("metrics", 60),
    EVENTS("events", 500),
    SNAPSHOT("snapshot", 1);

    public final String path;
    /** Max items per request (contract batch sizes). */
    public final int maxItems;

    Kind(String path, int maxItems) {
        this.path = path;
        this.maxItems = maxItems;
    }

    static Kind fromPath(String p) {
        for (Kind k : values()) if (k.path.equals(p)) return k;
        return null;
    }
}
