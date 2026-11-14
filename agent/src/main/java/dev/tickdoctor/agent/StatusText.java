package dev.tickdoctor.agent;

import dev.tickdoctor.agent.transport.Sender;

/** First line of /tickdoctor status. Pure, so it can be unit-tested. */
final class StatusText {
    private StatusText() {}

    static String state(Sender.State state, String lastError, long nextAttemptAtMs, long now) {
        long in = Math.max(0, (nextAttemptAtMs - now + 999) / 1000);
        return switch (state) {
            case CONNECTING -> "connecting";
            case CONNECTED -> "connected";
            case RETRYING -> "API unreachable, retrying in " + in + " s";
            case RATE_LIMITED -> "rate limited, retrying in " + in + " s";
            case PLAN_LIMIT -> "plan limit reached, retrying in " + in + " s";
            case AUTH_FAILED -> "stopped: invalid/revoked key" + (lastError == null || lastError.isBlank() ? "" : " (" + lastError + ")")
                    + " — run /tickdoctor reload after fixing config";
            case INSECURE_URL -> "STOPPED: http:// api-url resolves to a public address (use https://, then /tickdoctor reload)";
        };
    }

    /**
     * Warning when config.yml holds a key (OK or UNUSUAL) and others can read it, else null. No
     * key yet, owner-only, or a non-POSIX filesystem: null.
     */
    static String permissionWarning(java.nio.file.Path file, AgentConfig.KeyStatus keyStatus) {
        if (keyStatus != AgentConfig.KeyStatus.OK && keyStatus != AgentConfig.KeyStatus.UNUSUAL) return null;
        String who = dev.tickdoctor.agent.util.FilePerms.readableBeyondOwner(file);
        if (who == null) return null;
        return file + " (contains your API key) is readable by "
                + ("world".equals(who) ? "every user on this machine" : "other users in its group") + "; consider: chmod 600 " + file;
    }

    /**
     * The "something was lost" line of /tickdoctor status, or null when every counter is zero
     * (so a healthy status looks exactly as before). Only non-zero parts are listed.
     */
    static String losses(long memoryDropped, long corruptLines, long eventsDropped, long logDropped, long diskWriteFailures) {
        java.util.List<String> parts = new java.util.ArrayList<>();
        if (memoryDropped > 0) parts.add(memoryDropped + " batch(es) dropped from memory");
        if (corruptLines > 0) parts.add(corruptLines + " corrupt buffer line(s) dropped");
        if (eventsDropped > 0) parts.add(eventsDropped + " event(s) dropped (queue full)");
        if (logDropped > 0) parts.add(logDropped + " log line(s) dropped (queue full)");
        if (diskWriteFailures > 0) parts.add(diskWriteFailures + " disk buffer write failure(s)");
        return parts.isEmpty() ? null : "Losses: " + String.join(", ", parts);
    }

    static String notRunning(AgentConfig cfg) {
        if (cfg != null) {
            switch (cfg.keyStatus()) {
                case MISSING -> {
                    return "idle — set api-key in config.yml (get one from " + AgentConfig.KEY_SOURCE + "), then /tickdoctor reload";
                }
                case PLACEHOLDER -> {
                    return "idle — api-key is still the placeholder; set your real key in config.yml, then /tickdoctor reload";
                }
                default -> { }
            }
        }
        return "NOT RUNNING — see the server log";
    }
}
