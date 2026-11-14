package dev.tickdoctor.agent.transport;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.zip.GZIPOutputStream;

/** HTTP transport: JDK HttpClient, gzip body, Bearer auth. Blocking; call from the sender thread. */
public final class IngestClient implements Sender.Transport {
    private final HttpClient http;
    private final String base;
    private final String authorization;
    private final String userAgent;
    private volatile Duration timeout = Duration.ofSeconds(20);
    private final UrlPolicy.Verdict verdict;
    private final UrlPolicy.Resolver dns;
    private volatile boolean closed;
    private long dnsCheckedAtMs;
    private UrlPolicy.Resolution dnsResult;

    public IngestClient(String apiUrl, String apiKey, String agentVersion) {
        this(apiUrl, apiKey, agentVersion, UrlPolicy.SYSTEM_DNS);
    }

    IngestClient(String apiUrl, String apiKey, String agentVersion, UrlPolicy.Resolver dns) {
        this.dns = dns;
        String b = apiUrl.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        this.base = b;
        this.verdict = UrlPolicy.check(b);
        this.authorization = "Bearer " + apiKey.trim();
        this.userAgent = "TickDoctor-Agent/" + agentVersion + " (Java " + Runtime.version().feature() + ")";
        this.http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Override
    public void setTimeout(Duration d) {
        this.timeout = d;
    }

    @Override
    public Sender.Sent post(String path, String json) {
        long t0 = System.nanoTime();
        byte[] raw = json.getBytes(StandardCharsets.UTF_8);
        switch (transportCheck()) {
            case PUBLIC -> {
                return new Sender.Sent(new IngestResult.InsecureUrl(UrlPolicy.refusal(base)), 0, raw.length, 0, 0);
            }
            case UNRESOLVABLE -> {
                return new Sender.Sent(new IngestResult.Retryable("dns: cannot resolve the api-url host yet"), 0, raw.length, 0, 0);
            }
            case PRIVATE -> { }
        }
        byte[] gz;
        try {
            gz = gzip(raw);
        } catch (IOException e) {
            return new Sender.Sent(new IngestResult.Retryable("gzip failed: " + e.getMessage()), 0, raw.length, 0, 0);
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/v1/ingest/" + path))
                    .timeout(timeout)
                    .header("Authorization", authorization)
                    .header("Content-Type", "application/json")
                    .header("Content-Encoding", "gzip")
                    .header("User-Agent", userAgent)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(gz))
                    .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            long ms = (System.nanoTime() - t0) / 1_000_000;
            return new Sender.Sent(IngestResult.classify(resp.statusCode(), resp.body()), resp.statusCode(), raw.length, gz.length, ms);
        } catch (IOException | IllegalArgumentException e) {
            // stopping: interrupted, or close() aborted this request from the shutdown thread
            if (closed || Thread.currentThread().isInterrupted()) return new Sender.Sent(new IngestResult.Interrupted(), 0, raw.length, gz.length, 0);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            String msg = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            return new Sender.Sent(new IngestResult.Retryable(msg), 0, raw.length, gz.length, ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Sender.Sent(new IngestResult.Interrupted(), 0, raw.length, gz.length, 0);
        }
    }

    /**
     * TLS guard (see {@link UrlPolicy}). PRIVATE = may send. PUBLIC = plain http to a public
     * address, never send. UNRESOLVABLE = DNS failed: retry later, not a refusal. A resolved
     * hostname over http is re-checked at most once a minute; a failed lookup is retried on the
     * next attempt (the sender's backoff spaces those out).
     */
    private synchronized UrlPolicy.Resolution transportCheck() {
        return switch (verdict) {
            case ALLOWED -> UrlPolicy.Resolution.PRIVATE;
            case REFUSED -> UrlPolicy.Resolution.PUBLIC;
            case NEEDS_DNS -> {
                long now = System.currentTimeMillis();
                if (dnsResult == null || dnsResult == UrlPolicy.Resolution.UNRESOLVABLE || now - dnsCheckedAtMs > 60_000) {
                    dnsResult = UrlPolicy.resolve(base, dns);
                    dnsCheckedAtMs = now;
                }
                yield dnsResult;
            }
        };
    }

    /** Stops the HttpClient's selector thread and closes its connections; in-flight requests fail. */
    @Override
    public void close() {
        closed = true;
        http.shutdownNow();
    }

    boolean isClosed() {
        return http.isTerminated();
    }

    static byte[] gzip(byte[] raw) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(64, raw.length / 4));
        try (GZIPOutputStream gz = new GZIPOutputStream(bos)) {
            gz.write(raw);
        }
        return bos.toByteArray();
    }
}
