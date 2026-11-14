package dev.tickdoctor.agent.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

class RemoteConfigTest {
    private static RemoteConfig parse(String json) {
        return RemoteConfig.parse(JsonParser.parseString(json));
    }

    @Test
    void valuesInsideBoundsPassThrough() {
        RemoteConfig c = parse("{\"metricsIntervalSeconds\":30,\"snapshotMsptThreshold\":75.5,\"requestSnapshot\":true}");
        assertEquals(30, c.metricsIntervalSeconds());
        assertEquals(75.5, c.snapshotMsptThreshold());
        assertTrue(c.requestSnapshot());
    }

    @Test
    void clampsToContractBounds() {
        RemoteConfig low = parse("{\"metricsIntervalSeconds\":1,\"snapshotMsptThreshold\":5}");
        assertEquals(5, low.metricsIntervalSeconds());
        assertEquals(20.0, low.snapshotMsptThreshold());
        RemoteConfig high = parse("{\"metricsIntervalSeconds\":100000,\"snapshotMsptThreshold\":1e9}");
        assertEquals(300, high.metricsIntervalSeconds());
        assertEquals(1000.0, high.snapshotMsptThreshold());
        assertEquals(5, parse("{\"metricsIntervalSeconds\":-7}").metricsIntervalSeconds());
    }

    @Test
    void ignoresWrongTypesAndMissingConfig() {
        RemoteConfig c = parse("{\"metricsIntervalSeconds\":\"fast\",\"snapshotMsptThreshold\":null,\"requestSnapshot\":\"yes\"}");
        assertNull(c.metricsIntervalSeconds());
        assertNull(c.snapshotMsptThreshold());
        assertFalse(c.requestSnapshot());
        assertSame(RemoteConfig.NONE, RemoteConfig.parse(null));
        assertSame(RemoteConfig.NONE, parse("[1,2]"));
    }

    @Test
    void classifiesResponses() {
        IngestResult ok = IngestResult.classify(200, "{\"ok\":true,\"config\":{\"metricsIntervalSeconds\":2}}");
        assertEquals(5, ((IngestResult.Ok) ok).config().metricsIntervalSeconds());
        assertSame(RemoteConfig.NONE, ((IngestResult.Ok) IngestResult.classify(200, "{\"ok\":true}")).config());
        assertInstanceOf(IngestResult.Ok.class, IngestResult.classify(200, ""));
        IngestResult.AuthFailed a = (IngestResult.AuthFailed) IngestResult.classify(401, "{\"ok\":false,\"error\":\"revoked_key\"}");
        assertEquals("revoked_key", a.error());
        assertInstanceOf(IngestResult.Invalid.class, IngestResult.classify(400, "{\"ok\":false,\"error\":\"invalid_payload\"}"));
        assertEquals(42, ((IngestResult.RateLimited) IngestResult.classify(429, "{\"ok\":false,\"error\":\"rate_limited\",\"retryAfterSeconds\":42}")).retryAfterSeconds());
        assertNull(((IngestResult.RateLimited) IngestResult.classify(429, "not json")).retryAfterSeconds());
        assertInstanceOf(IngestResult.PlanLimit.class, IngestResult.classify(402, "{\"ok\":false,\"error\":\"plan_limit\"}"));
        assertInstanceOf(IngestResult.TooLarge.class, IngestResult.classify(413, ""));
        assertInstanceOf(IngestResult.Retryable.class, IngestResult.classify(503, "<html>"));
        assertInstanceOf(IngestResult.Retryable.class, IngestResult.classify(404, ""));
    }
}
