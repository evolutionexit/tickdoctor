package dev.tickdoctor.agent.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class IngestClientTest {
    private static InetAddress ip(String literal) throws UnknownHostException {
        return InetAddress.getByName(literal); // literal: no lookup
    }

    @Test
    void resolutionIsTriState() throws Exception {
        InetAddress pub = ip("203.0.113.5");
        InetAddress lan = ip("10.0.0.7");
        InetAddress ts = ip("100.64.0.10");
        assertEquals(UrlPolicy.Resolution.PRIVATE, UrlPolicy.resolve("http://mac.tailnet:3001", h -> new InetAddress[] {ts, lan}));
        assertEquals(UrlPolicy.Resolution.PUBLIC, UrlPolicy.resolve("http://mac.tailnet:3001", h -> new InetAddress[] {lan, pub}));
        assertEquals(UrlPolicy.Resolution.UNRESOLVABLE, UrlPolicy.resolve("http://mac.tailnet:3001", h -> {
            throw new UnknownHostException(h);
        }));
        assertEquals(UrlPolicy.Resolution.UNRESOLVABLE, UrlPolicy.resolve("http://mac.tailnet:3001", h -> new InetAddress[0]));
    }

    @Test
    void unknownHostIsRetryableNotInsecure() throws Exception {
        AtomicInteger lookups = new AtomicInteger();
        IngestClient c = new IngestClient("http://mac.tailnet:3001", "td_live_x", "0.0.0", h -> {
            lookups.incrementAndGet();
            throw new UnknownHostException(h);
        });
        IngestResult r = c.post("metrics", "{}").result();
        IngestResult.Retryable rt = assertInstanceOf(IngestResult.Retryable.class, r);
        assertTrue(rt.reason().startsWith("dns"), rt.reason());
        c.post("metrics", "{}");
        assertEquals(2, lookups.get(), "a failed lookup is not cached: the next attempt resolves again");
    }

    @Test
    void publicAddressOverHttpIsRefused() throws Exception {
        InetAddress pub = ip("203.0.113.5");
        IngestClient c = new IngestClient("http://api.example.test", "td_live_x", "0.0.0", h -> new InetAddress[] {pub});
        assertInstanceOf(IngestResult.InsecureUrl.class, c.post("metrics", "{}").result());
    }

    @Test
    void senderKeepsRetryingOnDnsFailure() throws Exception {
        IngestClient c = new IngestClient("http://mac.tailnet:3001", "td_live_x", "0.0.0", h -> {
            throw new UnknownHostException(h);
        });
        java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("ic");
        Sender s = new Sender(c, new DiskBuffer(dir, 1_000_000), new Backoff(new java.util.Random(1)), "0.0.0",
                "6f1c3a5e-8a3e-4c51-9f0e-2b6f4a1c9d77", java.util.logging.Logger.getLogger("test"), cfg -> {}, false);
        s.submit(Kind.METRICS, java.util.List.of("{\"n\":1}"));
        assertTrue(s.pump(1_000_000), "still running");
        assertEquals(Sender.State.RETRYING, s.state());
    }

    @Test
    void closeTerminatesTheHttpClient() throws Exception {
        IngestClient c = new IngestClient("https://api.example.test", "td_live_x", "0.0.0");
        org.junit.jupiter.api.Assertions.assertFalse(c.isClosed());
        c.close();
        long until = System.currentTimeMillis() + 5_000;
        while (!c.isClosed() && System.currentTimeMillis() < until) Thread.sleep(10);
        assertTrue(c.isClosed());
    }

    @Test
    void requestAfterCloseIsInterruptedNotUnreachable() {
        IngestClient c = new IngestClient("https://127.0.0.1:1", "td_live_x", "0.0.0");
        c.close();
        assertInstanceOf(IngestResult.Interrupted.class, c.post("metrics", "{}").result());
    }
}
