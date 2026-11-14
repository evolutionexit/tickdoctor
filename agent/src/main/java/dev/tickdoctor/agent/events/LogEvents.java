package dev.tickdoctor.agent.events;

import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.privacy.Redaction;
import dev.tickdoctor.agent.util.Hashing;
import dev.tickdoctor.agent.util.Iso;
import dev.tickdoctor.agent.util.Str;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Turns captured log lines into events. Pure; runs async. */
public final class LogEvents {
    static final Pattern CANT_KEEP_UP = Pattern.compile("Can't keep up!.*?Running (\\d+)\\s*ms or (\\d+) ticks behind");

    private LogEvents() {}

    /** A "Can't keep up!" event, or null if the message isn't one. */
    public static AgentEvent.CantKeepUp cantKeepUp(long ms, String message) {
        if (message == null) return null;
        Matcher m = CANT_KEEP_UP.matcher(message);
        if (!m.find()) return null;
        try {
            return new AgentEvent.CantKeepUp(Iso.ts(ms), Long.parseLong(m.group(1)), Long.parseLong(m.group(2)));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * An exception event. Uses the root cause (the real error behind wrappers such as
     * EventException); stackHash = sha256(class + first 10 frames), first 32 hex chars.
     */
    public static AgentEvent.ExceptionEvent exception(long ms, String logger, String message, Throwable t, PluginGuesser guesser) {
        return exception(ms, logger, message, t, guesser, Set.of());
    }

    /** As above; {@code playerNames} (immutable snapshot of online players) are redacted from the message. */
    public static AgentEvent.ExceptionEvent exception(long ms, String logger, String message, Throwable t, PluginGuesser guesser,
                                                      Set<String> playerNames) {
        Throwable root = t;
        for (int i = 0; i < 20 && root.getCause() != null && root.getCause() != root; i++) root = root.getCause();
        StackTraceElement[] st = root.getStackTrace();
        StringBuilder key = new StringBuilder(root.getClass().getName());
        for (int i = 0; i < Math.min(10, st.length); i++) {
            key.append('|').append(st[i].getClassName()).append('.').append(st[i].getMethodName()).append(':').append(st[i].getLineNumber());
        }
        List<String> frames = new ArrayList<>();
        for (int i = 0; i < Math.min(5, st.length); i++) frames.add(Str.cap(Redaction.redactText(st[i].toString(), playerNames), 300));
        String msg = root.getMessage();
        if (msg == null || msg.isBlank()) msg = message;
        String plugin = guesser == null ? null : guesser.guess(logger, message, t);
        return new AgentEvent.ExceptionEvent(
                Iso.ts(ms),
                Str.capOrNull(plugin, 200),
                Str.cap(root.getClass().getName(), 300),
                Str.capOrNull(Redaction.redactText(msg, playerNames), 500),
                Hashing.sha256Hex(key.toString()).substring(0, 32),
                frames.isEmpty() ? null : frames,
                1);
    }
}
