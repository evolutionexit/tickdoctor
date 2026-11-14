package dev.tickdoctor.agent.privacy;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Removes secrets, home-folder names and IP addresses from JVM flags and free text before anything is sent. */
public final class Redaction {
    private static final Pattern SENSITIVE = Pattern.compile("(?i)pass|pwd|token|secret|key|credential|auth");
    private static final Pattern API_KEY = Pattern.compile("td_(live|test)_[A-Za-z0-9]+");
    private static final Pattern IPV4 = Pattern.compile("(?<![\\d.])(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\d.])");
    // Full form (≥4 groups) or compressed form with "::" — avoids clock times like 10:20:30.
    private static final Pattern IPV6 = Pattern.compile(
            "(?<![\\w:])(?:(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}"
                    + "|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?"
                    + "|::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6}))(?![\\w:])");

    private static final Pattern KV_SECRET = Pattern.compile("(?i)(password|passwd|pwd|token|secret|apikey|api_key|key)=[^&\\s]+");
    private static final Pattern UUID_DASHED = Pattern.compile("(?i)(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])");
    private static final Pattern UUID_PLAIN = Pattern.compile("(?i)(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])");
    // Home folders carry the OS account name: keep the path shape, replace the name with "~".
    private static final Pattern HOME_UNIX = Pattern.compile("(/(?:home|Users)/)[^/\\s:;='\"]+");
    // Windows account names may contain spaces: up to the next separator when there is one, else up to whitespace.
    private static final Pattern HOME_WIN = Pattern.compile(
            "(?i)\\b([a-z]:(?:\\\\+|/)Users(?:\\\\+|/))(?:[^\\\\/:;'\"\\r\\n]+?(?=[\\\\/])|[^\\\\/\\s:;'\"]+)");
    // scheme://user:pass@ or scheme://user@ (JDBC/HTTP/proxy URLs) -> scheme://***@
    private static final Pattern URL_USERINFO = Pattern.compile("(?i)\\b([a-z][a-z0-9+.-]*://)[^\\s/@]+@");
    /**
     * A secret label: a whole word ("password", "API_KEY", "key") or the capitalised part of a
     * camelCase name ("dbPassword", "apiKey", "authToken"). A keyword inside a lowercase word is not
     * a label, so "bypass:" and "monkey:" stay.
     */
    private static final String SECRET_WORD = "(?:(?<![A-Za-z])(?i:password|passwd|pwd|pass|token|secret|key)"
            + "|(?<=[a-z0-9])(?:Password|Passwd|Pwd|Pass|Token|Secret|Key|PASSWORD|PASSWD|PWD|PASS|TOKEN|SECRET|KEY))";
    // "password: hunter2", "token = abc", "dbPassword: x", JSON "password":"x" (quoted values keep
    // their quotes, others become $kw=***); values already redacted ("***") are left alone.
    private static final Pattern SECRET_COLON_OR_EQ = Pattern.compile(
            "(?<kw>" + SECRET_WORD + ")(?<kq>[\"']?)(?<sep>\\s*[:=]\\s*)"
                    + "(?<val>\"(?:\\\\.|[^\"\\\\])*\"|'[^']*'|(?!\\*\\*\\*(?:[&\\s\"']|$))\\S+)");
    // "Authorization: Bearer xyz", "authorization=Basic abc", "Authorization": "token x": the whole credential.
    private static final Pattern AUTH_HEADER = Pattern.compile(
            "(?i)\\b(authorization[\"']?\\s*[:=]\\s*[\"']?)(?:(bearer|basic|token|digest)\\s+)?(?!\\*\\*\\*)[^\\s\"',;]+");
    // a bare "Bearer <token>" anywhere (8+ token characters, so "the bearer of bad news" stays)
    private static final Pattern BEARER = Pattern.compile("(?i)\\b(bearer)\\s+(?!\\*\\*\\*)[A-Za-z0-9._~+/=-]{8,}");

    /** Last compiled player-name pattern, keyed by the (immutable) name set it was built from. */
    private record NamePattern(Set<String> names, Pattern pattern) {}

    private static volatile NamePattern namePattern = new NamePattern(Set.of(), null);

    private Redaction() {}

    /**
     * System properties whose value is kept: the Aikar's-flags markers, read by the API's jvm-flags
     * rule ("aikar-flags-missing"). Every other {@code -Dname=value} becomes {@code -Dname=***}.
     */
    static final Set<String> PROPERTY_VALUE_ALLOW = Set.of("using.aikars.flags", "aikars.new.flags");

    /** Flags that carry file paths (agents, class/module paths, the server jar): never sent. */
    private static final Pattern DROPPED = Pattern.compile(
            "^(?:-javaagent|-agentpath|-agentlib|-classpath|-cp|--class-path|-jar|-Xbootclasspath"
                    + "|--module-path|-p|--upgrade-module-path|--patch-module)(?:[:=/].*)?$");

    /** Standard JVM options kept with their value (heap sizes, -XX:*, -Xlog, other -X options). */
    private static final Pattern STANDARD = Pattern.compile(
            "^(?:-X.*"
                    + "|--(?:add-modules|add-opens|add-exports|add-reads|enable-native-access|enable-preview"
                    + "|illegal-access|sun-misc-unsafe-memory-access)(?:=\\S*)?"
                    + "|-(?:server|client|ea|da|esa|dsa|enableassertions|disableassertions"
                    + "|enablesystemassertions|disablesystemassertions|verbose)(?::\\S*)?)$");

    private static final Pattern BARE_FLAG = Pattern.compile("^-{1,2}[A-Za-z][A-Za-z0-9._-]*$");

    /** -XX options whose value is a command line or a file path: the value is never sent. */
    private static final Pattern XX_PATH_OR_COMMAND = Pattern.compile(
            "^(-XX:(?:OnOutOfMemoryError|OnError|ErrorFile|HeapDumpPath|StartFlightRecording|Flight[A-Za-z]*)=).*$", Pattern.DOTALL);
    private static final Pattern XLOG_DECORATORS = Pattern.compile("^[A-Za-z,]*$");
    private static final Pattern XLOG_OPTIONS = Pattern.compile("^[A-Za-z]+=[0-9]+[KMGkmg]?(?:,[A-Za-z]+=[0-9]+[KMGkmg]?)*$");

    /**
     * One JVM input argument, reduced to what is safe to send, or null when it must be dropped.
     * Allow-list: standard options (-Xms/-Xmx/-Xss/-XX:* /-Xlog*, ...) keep their value;
     * {@code -Dname=value} keeps its value only for {@link #PROPERTY_VALUE_ALLOW}, otherwise
     * {@code -Dname=***}; -javaagent/-agentpath/-agentlib/-classpath/-cp/-jar and any flag that
     * contains a home folder are dropped; any other option keeps only its name. Every kept flag then
     * goes through {@link #redactIps} (which also removes TickDoctor API keys), {@link #redactHome}
     * and URL-credential removal,
     * and the value of a kept standard option that mentions pass/pwd/token/secret/key/credential/auth
     * still becomes "***".
     */
    public static String redactFlag(String flag) {
        if (flag == null || flag.isBlank() || !flag.startsWith("-")) return null; // a stray path or value
        if (DROPPED.matcher(flag).matches()) return null;
        if (HOME_UNIX.matcher(flag).find() || HOME_WIN.matcher(flag).find()) return null;
        String out;
        if (flag.startsWith("-D")) {
            int eq = flag.indexOf('=');
            out = eq < 0 || PROPERTY_VALUE_ALLOW.contains(flag.substring(2, eq)) ? flag : flag.substring(0, eq + 1) + "***";
        } else if (XX_PATH_OR_COMMAND.matcher(flag).matches()) {
            out = XX_PATH_OR_COMMAND.matcher(flag).replaceFirst("$1***");
        } else if (flag.startsWith("-Xloggc:")) {
            out = "-Xloggc:***";
        } else if (flag.startsWith("-Xlog:")) {
            out = xlog(flag);
        } else if (STANDARD.matcher(flag).matches()) {
            // -XX:Name=value: the value starts after '='; -Xlog:..., -ea:...: after the first ':' or '='
            int cut = flag.startsWith("-XX:") ? flag.indexOf('=') : firstOf(flag, '=', ':');
            out = cut >= 0 && SENSITIVE.matcher(flag.substring(cut + 1)).find() ? flag.substring(0, cut + 1) + "***" : flag;
        } else if (BARE_FLAG.matcher(flag).matches()) {
            out = flag;
        } else {
            int cut = firstOf(flag, '=', ':');
            out = cut >= 0 && BARE_FLAG.matcher(flag.substring(0, cut)).matches() ? flag.substring(0, cut + 1) + "***" : null;
        }
        return out == null ? null : redactHome(redactIps(URL_USERINFO.matcher(out).replaceAll("$1***@")));
    }

    /**
     * -Xlog:[what][:[output][:[decorators][:options]]]: tags and levels, decorators and numeric
     * output options are kept; an output other than stdout/stderr (a file) becomes "file=***".
     * Anything that doesn't parse cleanly after the output is dropped.
     */
    static String xlog(String flag) {
        String[] p = flag.substring("-Xlog:".length()).split(":", 4);
        StringBuilder sb = new StringBuilder("-Xlog:").append(p[0]);
        if (p.length < 2) return sb.toString();
        String output = p[1];
        boolean std = output.isEmpty() || output.equals("stdout") || output.equals("stderr");
        sb.append(':').append(std ? output : "file=***");
        if (p.length < 3 || !XLOG_DECORATORS.matcher(p[2]).matches()) return sb.toString();
        sb.append(':').append(p[2]);
        if (p.length == 4 && XLOG_OPTIONS.matcher(p[3]).matches()) sb.append(':').append(p[3]);
        return sb.toString();
    }

    private static int firstOf(String s, char a, char b) {
        int i = s.indexOf(a);
        int j = s.indexOf(b);
        return i < 0 ? j : j < 0 ? i : Math.min(i, j);
    }

    /** {@link #redactFlag} over a list, dropped flags removed. */
    public static List<String> redactFlags(List<String> flags) {
        List<String> out = new ArrayList<>();
        if (flags == null) return out;
        for (String f : flags) {
            String r = redactFlag(f);
            if (r != null) out.add(r);
        }
        return out;
    }

    /**
     * Replaces the account name in /home/NAME, /Users/NAME and C:\\Users\\NAME paths with "~", keeping
     * the rest of the path: "/home/alice/server/x" -> "/home/~/server/x".
     */
    public static String redactHome(String s) {
        if (s == null) return null;
        String out = HOME_UNIX.matcher(s).replaceAll("$1~");
        return HOME_WIN.matcher(out).replaceAll("$1~");
    }

    /**
     * Free text that may contain personal data or secrets (exception messages, stack frames, crash
     * details): URL credentials ({@code scheme://user:pass@} -> {@code scheme://***@}), home-folder
     * account names, {@code key=value} / {@code password: value} secrets, IPs, TickDoctor keys,
     * dashed and undashed UUIDs, and the names of online players ({@code names} must be an
     * immutable snapshot).
     */
    public static String redactText(String text, Set<String> names) {
        if (text == null) return null;
        String s = URL_USERINFO.matcher(text).replaceAll("$1***@");
        s = redactHome(s);
        s = AUTH_HEADER.matcher(s).replaceAll(m -> java.util.regex.Matcher.quoteReplacement(
                m.group(1) + (m.group(2) != null ? m.group(2) + " " : "") + "***"));
        s = BEARER.matcher(s).replaceAll("$1 ***");
        s = KV_SECRET.matcher(s).replaceAll("$1=***");
        s = SECRET_COLON_OR_EQ.matcher(s).replaceAll(Redaction::secretReplacement);
        s = UUID_DASHED.matcher(s).replaceAll("<uuid>");
        s = UUID_PLAIN.matcher(s).replaceAll("<uuid>");
        s = redactIps(s);
        Pattern p = namesPattern(names);
        if (p != null) s = p.matcher(s).replaceAll("<player>");
        return s;
    }

    private static String secretReplacement(java.util.regex.MatchResult m) {
        String val = m.group(4);
        char q = val.charAt(0);
        String out = (q == '"' || q == '\'') && val.length() >= 2
                ? m.group(1) + m.group(2) + m.group(3) + q + "***" + q // JSON / quoted: keep the shape
                : m.group(1) + "=***";
        return java.util.regex.Matcher.quoteReplacement(out);
    }

    static Pattern namesPattern(Set<String> names) {
        if (names == null || names.isEmpty()) return null;
        NamePattern np = namePattern;
        if (np.names() == names || np.names().equals(names)) return np.pattern();
        List<String> sorted = new ArrayList<>();
        for (String n : names) if (n != null && !n.isBlank()) sorted.add(n);
        if (sorted.isEmpty()) return null;
        sorted.sort(Comparator.comparingInt(String::length).reversed()); // longest first
        StringBuilder sb = new StringBuilder("(?i)(?<![A-Za-z0-9_])(?:");
        for (int i = 0; i < sorted.size(); i++) {
            if (i > 0) sb.append('|');
            sb.append(Pattern.quote(sorted.get(i)));
        }
        sb.append(")(?![A-Za-z0-9_])");
        Pattern p = Pattern.compile(sb.toString());
        namePattern = new NamePattern(names, p);
        return p;
    }

    /** Replaces IPv4/IPv6 addresses in free text (exception messages, crash details) with "<ip>". */
    public static String redactIps(String text) {
        if (text == null) return null;
        String s = IPV4.matcher(text).replaceAll("<ip>");
        s = IPV6.matcher(s).replaceAll("<ip>");
        return API_KEY.matcher(s).replaceAll("***");
    }
}
