package dev.tickdoctor.agent.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.Hello;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EventsTest {
    @Test
    void parsesCantKeepUp() {
        AgentEvent.CantKeepUp e = LogEvents.cantKeepUp(0, "Can't keep up! Is the server overloaded? Running 5043ms or 100 ticks behind");
        assertEquals(5043, e.behindMs());
        assertEquals(100, e.ticksSkipped());
        assertEquals("1970-01-01T00:00:00Z", e.ts());
        assertNull(LogEvents.cantKeepUp(0, "Done (3.2s)! For help, type \"help\""));
    }

    private static Throwable boom(String msg) {
        try {
            throw new IllegalStateException("wrapper", new NullPointerException(msg));
        } catch (IllegalStateException e) {
            return e;
        }
    }

    @Test
    void exceptionsUseTheRootCauseAndHashStably() {
        PluginGuesser g = new PluginGuesser(Map.of("Essentials", "com.earth2me.essentials.Essentials", "TickDoctor", "dev.tickdoctor.agent.TickDoctorPlugin"));
        Throwable[] ts = new Throwable[2];
        for (int i = 0; i < 2; i++) ts[i] = boom(i == 0 ? "player 10.0.0.7 is null" : "other"); // same throw site
        AgentEvent.ExceptionEvent a = LogEvents.exception(0, "Minecraft", "Could not pass event PlayerJoinEvent to Essentials v2.21.0", ts[0], g);
        assertEquals("java.lang.NullPointerException", a.exceptionClass());
        assertEquals("player <ip> is null", a.message());
        assertEquals("Essentials", a.plugin());
        assertEquals(32, a.stackHash().length());
        assertTrue(a.topFrames().size() <= 5 && !a.topFrames().isEmpty());
        assertEquals(1, a.count());
        // same throw site → same hash, regardless of the message
        AgentEvent.ExceptionEvent b = LogEvents.exception(0, "Minecraft", null, ts[1], g);
        assertEquals(a.stackHash(), b.stackHash());
        // the stack itself attributes it to this test's package → "TickDoctor"
        assertEquals("TickDoctor", b.plugin());
        AgentEvent.ExceptionEvent c = LogEvents.exception(0, "x", null, new RuntimeException("elsewhere"), g);
        assertNotEquals(a.stackHash(), c.stackHash());
    }

    @Test
    void guessesPluginFromLogMessages() {
        PluginGuesser g = new PluginGuesser(Map.of("WorldEdit", "com.sk89q.worldedit.bukkit.WorldEditPlugin", "Foo", "Main"));
        assertEquals("WorldEdit", g.guess("Minecraft", "Error occurred while enabling WorldEdit v7.3.0 (Is it up to date?)", new RuntimeException()));
        assertEquals("WorldEdit", g.guess("Minecraft", "Plugin WorldEdit v7.3.0 generated an exception while executing task 42", new RuntimeException()));
        assertEquals("Foo", g.guess("Foo", "something", new RuntimeException()), "falls back to the logger name");
        assertNull(g.guess("Minecraft", "Unknown Plugin v1 failed", null));
    }

    @Test
    void collectorFoldsExceptionsAndKeepsRecent() {
        EventCollector c = new EventCollector();
        long t0 = 1_000_000;
        c.add(new AgentEvent.PlayerJoin("2026-11-09T10:00:00Z", 1), t0);
        AgentEvent.ExceptionEvent ex = new AgentEvent.ExceptionEvent("2026-11-09T10:00:01Z", null, "java.lang.NPE", null, "h1", null, 1);
        for (int i = 0; i < 5; i++) c.addException(ex, t0 + 1 + i);
        c.addException(new AgentEvent.ExceptionEvent("2026-11-09T10:00:02Z", null, "X", null, "h2", null, 1), t0 + 10);
        assertEquals(3, c.recent(t0 + 20).size(), "recent includes unsent events");

        List<AgentEvent> batch = c.drain(t0 + 20);
        assertEquals(3, batch.size());
        assertEquals("player_join", batch.get(0).type());
        assertEquals(5, ((AgentEvent.ExceptionEvent) batch.get(1)).count());
        assertTrue(c.isEmpty());
        assertEquals(0, c.drain(t0 + 30).size());

        assertEquals(3, c.recent(t0 + 60_000).size());
        assertEquals(0, c.recent(t0 + 6 * 60_000).size(), "older than 5 minutes");
    }

    @Test
    void collectorIsBounded() {
        EventCollector c = new EventCollector();
        for (int i = 0; i < EventCollector.MAX_PENDING + 10; i++) c.add(new AgentEvent.ServerStop("2026-11-09T10:00:00Z", null), i);
        assertEquals(10, c.dropped());
        assertEquals(EventCollector.MAX_RECENT, c.recent(EventCollector.MAX_PENDING).size());
    }

    @Test
    void pluginDiff() {
        List<Hello.Plugin> before = List.of(new Hello.Plugin("A", "1.0", true), new Hello.Plugin("B", "2.0", true), new Hello.Plugin("C", "1", true));
        List<Hello.Plugin> after = List.of(new Hello.Plugin("A", "1.1", true), new Hello.Plugin("C", "1", false), new Hello.Plugin("D", "0.1", true));
        AgentEvent.PluginsChanged d = PluginDiff.diff(before, after, 0);
        assertEquals(List.of(new AgentEvent.PluginRef("D", "0.1")), d.added());
        assertEquals(List.of(new AgentEvent.PluginRef("B", "2.0")), d.removed());
        assertEquals(List.of(new AgentEvent.PluginUpdate("A", "1.0", "1.1")), d.updated());
        assertNull(PluginDiff.diff(before, before, 0));
    }

    @Test
    void markerDetectsUncleanShutdown(@TempDir Path data, @TempDir Path server) throws Exception {
        LifecycleMarker m = new LifecycleMarker(data, server);
        assertFalse(m.start(1_000).unclean(), "first start is clean");
        m.cleanStop();
        assertFalse(m.start(2_000).unclean(), "after a clean stop");
        // no cleanStop → "crash"
        Files.createDirectories(server.resolve("crash-reports"));
        Files.writeString(server.resolve("crash-reports/crash-2026-11-09_10.00.00-server.txt"),
                "---- Minecraft Crash Report ----\n// Oops.\n\nTime: 2026-11-09 10:00:00\nDescription: Exception in server tick loop\n");
        m.heartbeat();
        LifecycleMarker.Previous p = new LifecycleMarker(data, server).start(System.currentTimeMillis());
        assertTrue(p.unclean());
        assertTrue(p.lastAliveMs() > 0);
        assertTrue(p.detail().contains("Description: Exception in server tick loop"), p.detail());
        assertTrue(p.detail().length() <= 2000);
    }

    @Test
    void heartbeatWithoutARuntimeSetsLastAliveForCrashDetection(@TempDir Path data) throws Exception {
        // idle agent (no key / bad URL): only the plugin-owned heartbeat touches the marker
        long started = System.currentTimeMillis() - 3_600_000;
        LifecycleMarker m = new LifecycleMarker(data, null);
        m.start(started);
        long lastBeat = started + 30 * LifecycleMarker.HEARTBEAT_MS;
        for (long t = started + LifecycleMarker.HEARTBEAT_MS; t <= lastBeat; t += LifecycleMarker.HEARTBEAT_MS) m.heartbeat(t);
        // killed: no cleanStop; next start reports the last heartbeat, not the start time
        LifecycleMarker.Previous p = new LifecycleMarker(data, null).start(System.currentTimeMillis());
        assertTrue(p.unclean());
        assertTrue(Math.abs(p.lastAliveMs() - lastBeat) < 1_000, "lastAlive " + p.lastAliveMs() + " vs " + lastBeat);
        assertEquals(1_200, LifecycleMarker.HEARTBEAT_TICKS, "every minute in server ticks");
        // after a clean stop a late heartbeat must not resurrect the marker
        m.cleanStop();
        m.heartbeat(System.currentTimeMillis());
        assertFalse(Files.exists(data.resolve("running.marker")));
    }

    @Test
    void exceptionMessagesAreRedacted() {
        RuntimeException t = new RuntimeException("Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5) from 1.2.3.4 failed: token=abc");
        AgentEvent.ExceptionEvent e = LogEvents.exception(0, "x", null, t, null, java.util.Set.of("Steve"));
        assertEquals("<player> (<uuid>) from <ip> failed: token=***", e.message());
    }

    @Test
    void pluginGuessIgnoresTheDefaultLocale() {
        java.util.Locale before = java.util.Locale.getDefault();
        try {
            // Turkish: "I".toLowerCase() is a dotless "ı", so "ItemsAdder" would never match "itemsadder"
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr-TR"));
            PluginGuesser g = new PluginGuesser(Map.of("ItemsAdder", "dev.lone.itemsadder.Main"));
            assertEquals("ItemsAdder", g.guess("itemsadder", null, null));
            assertEquals("ItemsAdder", g.guess("x", "Could not pass event E to ITEMSADDER v4.0", null));
        } finally {
            java.util.Locale.setDefault(before);
        }
    }
}
