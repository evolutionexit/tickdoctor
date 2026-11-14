package dev.tickdoctor.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tickdoctor.agent.privacy.PrivacyMode;
import org.junit.jupiter.api.Test;

class AgentConfigTest {
    @Test
    void defaultsAndClamping() {
        AgentConfig c = AgentConfig.of(" td_live_abc ", "", 1, "weird", 5, 0, false);
        assertEquals("td_live_abc", c.apiKey());
        assertEquals("http://localhost:4000", c.apiUrl());
        assertEquals(5, c.metricsIntervalSeconds());
        assertEquals(PrivacyMode.HASHED, c.privacyMode());
        assertEquals(20, c.snapshotMsptThreshold());
        assertEquals(1024 * 1024, c.bufferMaxBytes());
        assertTrue(c.hasKey());
        AgentConfig d = AgentConfig.of("", "https://api.example", 10_000, "none", 5_000, 50, true);
        assertEquals(300, d.metricsIntervalSeconds());
        assertEquals(1000, d.snapshotMsptThreshold());
        assertEquals(50L * 1024 * 1024, d.bufferMaxBytes());
        assertEquals(PrivacyMode.NONE, d.privacyMode());
        assertFalse(d.hasKey());
        assertFalse(AgentConfig.of("k", "ftp://x", 10, "hashed", 50, 50, false).urlLooksValid());
    }

    private static boolean allowed(String url) {
        return AgentConfig.of("td_live_k", url, 10, "hashed", 50, 50, false).urlTransportAllowed();
    }

    @Test
    void tlsGuardAllowsHttpOnlyToPrivateHosts() {
        assertTrue(allowed("https://ingest.example.com"));
        assertTrue(allowed("http://localhost:4000"));
        assertTrue(allowed("http://127.0.0.1:4000"));
        assertTrue(allowed("http://[::1]:4000"));
        assertTrue(allowed("http://10.1.2.3"));
        assertTrue(allowed("http://172.16.0.1"));
        assertTrue(allowed("http://172.31.255.255"));
        assertTrue(allowed("http://192.168.4.20:3001"));
        assertTrue(allowed("http://169.254.1.1"));
        assertTrue(allowed("http://100.64.0.10:3001"), "Tailscale");
        assertTrue(allowed("http://100.127.0.1"));
        assertFalse(allowed("http://100.128.0.1"));
        assertFalse(allowed("http://100.63.255.255"));
        assertFalse(allowed("http://172.32.0.1"));
        assertFalse(allowed("http://8.8.8.8"));
        assertFalse(allowed("http://[2001:db8::1]"));
        assertFalse(allowed("ftp://10.0.0.1"));
        assertTrue(allowed(AgentConfig.DEFAULT_URL), "default stays usable");
    }

    @Test
    void tlsGuardResolvesHostnamesBeforeSending() {
        assertEquals(dev.tickdoctor.agent.transport.UrlPolicy.Verdict.NEEDS_DNS, dev.tickdoctor.agent.transport.UrlPolicy.check("http://my-mac.tailnet"));
        assertTrue(dev.tickdoctor.agent.transport.UrlPolicy.resolvesPrivate("http://localhost:1"));
        assertFalse(dev.tickdoctor.agent.transport.UrlPolicy.resolvesPrivate("http://no-such-host.invalid"));
    }

    @Test
    void ingestClientRefusesPlainHttpToAPublicAddress() {
        var c = new dev.tickdoctor.agent.transport.IngestClient("http://8.8.8.8", "td_live_k", "0.1.1");
        var sent = c.post("metrics", "{}");
        assertTrue(sent.result() instanceof dev.tickdoctor.agent.transport.IngestResult.InsecureUrl);
        assertEquals(0, sent.status());
    }

    @Test
    void keyStatus() {
        assertEquals(AgentConfig.KeyStatus.MISSING, AgentConfig.keyStatus(""));
        assertEquals(AgentConfig.KeyStatus.MISSING, AgentConfig.keyStatus("   "));
        assertEquals(AgentConfig.KeyStatus.MISSING, AgentConfig.keyStatus(null));
        for (String ph : new String[] {"td_live_xxx", "td_live_", "td_live_...", "td_live_…", "td_live_<your key>", "<api-key>",
                "your-api-key", "YOUR_KEY_HERE", "changeme", "xxxx"}) {
            assertEquals(AgentConfig.KeyStatus.PLACEHOLDER, AgentConfig.keyStatus(ph), ph);
            assertFalse(AgentConfig.of(ph, "", 10, "hashed", 50, 50, false).hasKey(), ph);
        }
        String real = "td_live_4fJ2kQ9xZbN7mP1rT8sV3wY6cA0dE5gH";
        assertEquals(AgentConfig.KeyStatus.OK, AgentConfig.keyStatus(real));
        assertTrue(AgentConfig.of(real, "", 10, "hashed", 50, 50, false).hasKey());
        // Phase 2 stub keys / anything else: warn but still try (the API decides)
        assertEquals(AgentConfig.KeyStatus.UNUSUAL, AgentConfig.keyStatus("x".repeat(32)));
        assertEquals(AgentConfig.KeyStatus.UNUSUAL, AgentConfig.keyStatus("td_test_abc"));
        assertTrue(AgentConfig.of("x".repeat(32), "", 10, "hashed", 50, 50, false).hasKey());
    }

    @Test
    void statusText() {
        var s = dev.tickdoctor.agent.transport.Sender.State.AUTH_FAILED;
        assertEquals("stopped: invalid/revoked key (revoked_key) — run /tickdoctor reload after fixing config", StatusText.state(s, "revoked_key", 0, 0));
        assertEquals("stopped: invalid/revoked key (invalid_key) — run /tickdoctor reload after fixing config", StatusText.state(s, "invalid_key", 0, 0));
        assertEquals("stopped: invalid/revoked key — run /tickdoctor reload after fixing config", StatusText.state(s, null, 0, 0));
        assertEquals("API unreachable, retrying in 3 s", StatusText.state(dev.tickdoctor.agent.transport.Sender.State.RETRYING, null, 12_500, 10_000));
        String idle = StatusText.notRunning(AgentConfig.of("", "", 10, "hashed", 50, 50, false));
        assertEquals("idle — set api-key in config.yml (get one from your TickDoctor dashboard), then /tickdoctor reload", idle);
        assertFalse(AgentConfig.KEY_SOURCE.contains("pnpm") || AgentConfig.KEY_SOURCE.contains("self-hosted"), AgentConfig.KEY_SOURCE);
        assertEquals("connected", StatusText.state(dev.tickdoctor.agent.transport.Sender.State.CONNECTED, null, 0, 0));
        assertTrue(StatusText.notRunning(AgentConfig.of("td_live_xxx", "", 10, "hashed", 50, 50, false)).contains("placeholder"));
        assertTrue(StatusText.notRunning(null).contains("server log"));
    }

    @org.junit.jupiter.api.Test
    void permissionWarningOnlyWithKeyAndOpenedPermissions(@org.junit.jupiter.api.io.TempDir java.nio.file.Path dir) throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.getFileStore(dir).supportsFileAttributeView("posix"));
        java.nio.file.Path f = java.nio.file.Files.writeString(dir.resolve("config.yml"), "api-key: \"\"\n");
        // fresh install with umask 002 (664) but no key yet: no warning
        java.nio.file.Files.setPosixFilePermissions(f, java.nio.file.attribute.PosixFilePermissions.fromString("rw-rw-r--"));
        org.junit.jupiter.api.Assertions.assertNull(StatusText.permissionWarning(f, AgentConfig.KeyStatus.MISSING));
        org.junit.jupiter.api.Assertions.assertNull(StatusText.permissionWarning(f, AgentConfig.KeyStatus.PLACEHOLDER));
        // key set, owner-only: no warning
        java.nio.file.Files.setPosixFilePermissions(f, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        org.junit.jupiter.api.Assertions.assertNull(StatusText.permissionWarning(f, AgentConfig.KeyStatus.OK));
        // key set and world readable: the documented warning
        java.nio.file.Files.setPosixFilePermissions(f, java.nio.file.attribute.PosixFilePermissions.fromString("rw-rw-r--"));
        assertEquals(f + " (contains your API key) is readable by every user on this machine; consider: chmod 600 " + f,
                StatusText.permissionWarning(f, AgentConfig.KeyStatus.OK));
        // key set and group readable
        java.nio.file.Files.setPosixFilePermissions(f, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r-----"));
        assertTrue(StatusText.permissionWarning(f, AgentConfig.KeyStatus.UNUSUAL).contains("other users in its group; consider: chmod 600"));
    }

    @Test
    void statusLossesLineListsOnlyNonZeroCounters() {
        org.junit.jupiter.api.Assertions.assertNull(StatusText.losses(0, 0, 0, 0, 0), "healthy status unchanged");
        assertEquals("Losses: 3 event(s) dropped (queue full), 2 disk buffer write failure(s)", StatusText.losses(0, 0, 3, 0, 2));
        assertEquals("Losses: 1 batch(es) dropped from memory, 4 corrupt buffer line(s) dropped, 5 event(s) dropped (queue full), "
                + "6 log line(s) dropped (queue full), 7 disk buffer write failure(s)", StatusText.losses(1, 4, 5, 6, 7));
    }

    @Test
    void legacySaltFileIsDeletedOnEnable(@org.junit.jupiter.api.io.TempDir java.nio.file.Path data) throws Exception {
        java.nio.file.Path salt = data.resolve("salt.txt");
        java.nio.file.Files.writeString(salt, "00".repeat(32) + "\n");
        TickDoctorPlugin.deleteLegacySalt(data);
        assertFalse(java.nio.file.Files.exists(salt));
        TickDoctorPlugin.deleteLegacySalt(data); // absent: no error
        TickDoctorPlugin.deleteLegacySalt(data.resolve("missing-folder"));
    }
}
