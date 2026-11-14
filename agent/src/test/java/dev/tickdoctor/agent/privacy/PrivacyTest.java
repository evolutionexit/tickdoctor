package dev.tickdoctor.agent.privacy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.Json;
import dev.tickdoctor.agent.model.MetricSample;
import java.util.List;
import org.junit.jupiter.api.Test;

class PrivacyTest {
    @Test
    void privacyModeParsingDefaultsToHashed() {
        assertEquals(PrivacyMode.NONE, PrivacyMode.parse(" None "));
        assertEquals(PrivacyMode.HASHED, PrivacyMode.parse("hashed"));
        assertEquals(PrivacyMode.HASHED, PrivacyMode.parse("plain"));
        assertEquals(PrivacyMode.HASHED, PrivacyMode.parse(null));
    }

    @Test
    void joinAndLeaveEventsCarryNoPlayerId() {
        // audit M6: the API keeps only playerCount, so no player id is sent in any privacy mode
        String join = Json.toJson(new AgentEvent.PlayerJoin("2026-11-14T10:00:00Z", 3));
        String leave = Json.toJson(new AgentEvent.PlayerLeave("2026-11-14T10:00:00Z", 2));
        assertEquals("{\"type\":\"player_join\",\"ts\":\"2026-11-14T10:00:00Z\",\"playerCount\":3}", join);
        assertEquals("{\"type\":\"player_leave\",\"ts\":\"2026-11-14T10:00:00Z\",\"playerCount\":2}", leave);
        for (Class<?> c : new Class<?>[] {AgentEvent.PlayerJoin.class, AgentEvent.PlayerLeave.class}) {
            for (var rc : c.getRecordComponents()) assertNotEquals("playerId", rc.getName());
        }
    }

    @Test
    void pingsCarryOnlyTheValue() {
        // audit M6: players.pings[] is {pingMs} only; the contract's id is deprecated
        String json = Json.toJson(new MetricSample.Players(2, List.of(new MetricSample.Ping(23), new MetricSample.Ping(140))));
        assertEquals("{\"count\":2,\"pings\":[{\"pingMs\":23},{\"pingMs\":140}]}", json);
        assertEquals(1, MetricSample.Ping.class.getRecordComponents().length);
    }
}
