package dev.tickdoctor.agent.events;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Best guess which plugin an exception belongs to: log message patterns, then stack packages. */
public final class PluginGuesser {
    private static final List<Pattern> MESSAGE_PATTERNS = List.of(
            Pattern.compile("Could not pass event \\S+ to (\\S+?) v"),
            Pattern.compile("Error occurred while (?:enabling|disabling|loading|initializing) (\\S+?) v"),
            Pattern.compile("(?:^|\\s)(\\S+?) v\\S+ (?:generated|attempted|has failed)"),
            Pattern.compile("Plugin (\\S+?) v\\S+ "),
            Pattern.compile("(?:in|from|for) plugin (\\S+)"));

    private record Prefix(String pkg, String plugin) {}

    private final List<Prefix> prefixes = new ArrayList<>();
    private final Map<String, String> byNameLower;

    /** @param mainClasses plugin name → main class (fully qualified) */
    public PluginGuesser(Map<String, String> mainClasses) {
        this.byNameLower = new java.util.HashMap<>();
        for (var e : mainClasses.entrySet()) {
            byNameLower.put(e.getKey().toLowerCase(Locale.ROOT), e.getKey());
            String main = e.getValue();
            if (main == null) continue;
            int dot = main.lastIndexOf('.');
            if (dot <= 0) continue;
            String pkg = main.substring(0, dot);
            // too generic to attribute safely (e.g. "me" or "com")
            if (pkg.indexOf('.') < 0) continue;
            if (pkg.startsWith("org.bukkit") || pkg.startsWith("io.papermc") || pkg.startsWith("net.minecraft")) continue;
            prefixes.add(new Prefix(pkg + ".", e.getKey()));
        }
        prefixes.sort(Comparator.comparingInt((Prefix p) -> p.pkg.length()).reversed());
    }

    public String guess(String loggerName, String message, Throwable t) {
        if (message != null) {
            for (Pattern p : MESSAGE_PATTERNS) {
                Matcher m = p.matcher(message);
                if (m.find()) {
                    String known = byNameLower.get(m.group(1).toLowerCase(Locale.ROOT));
                    if (known != null) return known;
                }
            }
        }
        for (Throwable c = t; c != null; c = c.getCause() == c ? null : c.getCause()) {
            for (StackTraceElement f : c.getStackTrace()) {
                String cls = f.getClassName();
                for (Prefix p : prefixes) {
                    if (cls.startsWith(p.pkg)) return p.plugin;
                }
            }
        }
        if (loggerName != null) {
            String known = byNameLower.get(loggerName.toLowerCase(Locale.ROOT));
            if (known != null) return known;
        }
        return null;
    }
}
