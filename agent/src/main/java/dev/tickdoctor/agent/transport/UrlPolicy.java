package dev.tickdoctor.agent.transport;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;

/**
 * Production TLS guard: the API key travels in the Authorization header, so plain {@code http://}
 * is only allowed to private networks — loopback, RFC 1918, link-local, 100.64.0.0/10
 * (Tailscale / CGNAT) and IPv6 ULA/link-local. Anything else must be {@code https://}.
 */
public final class UrlPolicy {
    public enum Verdict { ALLOWED, REFUSED, NEEDS_DNS }

    /** Outcome of resolving a NEEDS_DNS host. */
    public enum Resolution { PRIVATE, PUBLIC, UNRESOLVABLE }

    /** DNS lookup, replaceable in tests. */
    @FunctionalInterface
    public interface Resolver {
        InetAddress[] resolve(String host) throws UnknownHostException;
    }

    public static final Resolver SYSTEM_DNS = InetAddress::getAllByName;

    private UrlPolicy() {}

    /** Decides from the URL alone (no DNS). A non-literal http host other than localhost is NEEDS_DNS. */
    public static Verdict check(String url) {
        URI u;
        try {
            u = URI.create(url.trim());
        } catch (IllegalArgumentException e) {
            return Verdict.REFUSED;
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        String host = u.getHost();
        if (host == null || host.isEmpty()) return Verdict.REFUSED;
        if (scheme.equals("https")) return Verdict.ALLOWED;
        if (!scheme.equals("http")) return Verdict.REFUSED;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.equals("localhost") || h.endsWith(".localhost")) return Verdict.ALLOWED;
        if (!isIpLiteral(h)) return Verdict.NEEDS_DNS;
        try {
            return isPrivate(InetAddress.getByName(h)) ? Verdict.ALLOWED : Verdict.REFUSED; // literal: no lookup
        } catch (UnknownHostException e) {
            return Verdict.REFUSED;
        }
    }

    /** For NEEDS_DNS: true only if the host resolves and every address is private. */
    public static boolean resolvesPrivate(String url) {
        return resolve(url, SYSTEM_DNS) == Resolution.PRIVATE;
    }

    /**
     * For NEEDS_DNS (blocking; sender thread only). PRIVATE if every address is private, PUBLIC if
     * any address is public (the only case that must refuse plain http), UNRESOLVABLE when the
     * lookup fails (DNS not up yet, Tailscale still connecting): a temporary condition, retry later.
     */
    public static Resolution resolve(String url, Resolver dns) {
        String host;
        try {
            host = URI.create(url.trim()).getHost();
        } catch (IllegalArgumentException e) {
            return Resolution.UNRESOLVABLE;
        }
        if (host == null || host.isEmpty()) return Resolution.UNRESOLVABLE;
        try {
            InetAddress[] all = dns.resolve(host);
            if (all == null || all.length == 0) return Resolution.UNRESOLVABLE;
            for (InetAddress a : all) if (!isPrivate(a)) return Resolution.PUBLIC;
            return Resolution.PRIVATE;
        } catch (UnknownHostException | RuntimeException e) {
            return Resolution.UNRESOLVABLE;
        }
    }

    static boolean isIpLiteral(String h) {
        return h.matches("\\d{1,3}(\\.\\d{1,3}){3}") || (h.contains(":") && h.matches("[0-9a-f:.%a-z]+"));
    }

    public static boolean isPrivate(InetAddress a) {
        if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()) return true;
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int b0 = b[0] & 0xff;
            int b1 = b[1] & 0xff;
            return b0 == 100 && b1 >= 64 && b1 <= 127; // 100.64.0.0/10
        }
        return (b[0] & 0xfe) == 0xfc; // fc00::/7 unique local
    }

    /** Human-readable refusal for the log. */
    public static String refusal(String url) {
        return "api-url '" + url + "' uses plain http:// to a public host; refusing to send the API key unencrypted"
                + " (http:// is only allowed for localhost, LAN, link-local and Tailscale 100.64.0.0/10 addresses).";
    }
}
