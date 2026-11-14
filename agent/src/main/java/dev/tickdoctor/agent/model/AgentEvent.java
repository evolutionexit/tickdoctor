package dev.tickdoctor.agent.model;

import dev.tickdoctor.agent.util.Num;
import java.util.List;

/** Discriminated union of agent events; {@code type} is always the first JSON field. */
public sealed interface AgentEvent {
    String type();

    String ts();

    record ServerStart(String type, String ts, boolean uncleanPreviousShutdown) implements AgentEvent {
        public ServerStart(String ts, boolean unclean) {
            this("server_start", ts, unclean);
        }
    }

    record ServerStop(String type, String ts, String reason) implements AgentEvent {
        public ServerStop(String ts, String reason) {
            this("server_stop", ts, reason);
        }
    }

    record Crash(String type, String ts, String detail) implements AgentEvent {
        public Crash(String ts, String detail) {
            this("crash", ts, detail);
        }
    }

    /**
     * Join/leave carry only the new player count. No player id in any privacy mode: the API only
     * keeps the count (data minimisation; the contract's playerId is optional).
     */
    record PlayerJoin(String type, String ts, int playerCount) implements AgentEvent {
        public PlayerJoin(String ts, int playerCount) {
            this("player_join", ts, playerCount);
        }
    }

    record PlayerLeave(String type, String ts, int playerCount) implements AgentEvent {
        public PlayerLeave(String ts, int playerCount) {
            this("player_leave", ts, playerCount);
        }
    }

    record CantKeepUp(String type, String ts, double behindMs, long ticksSkipped) implements AgentEvent {
        public CantKeepUp {
            ticksSkipped = Num.count(ticksSkipped);
        }

        public CantKeepUp(String ts, double behindMs, long ticksSkipped) {
            this("cant_keep_up", ts, behindMs, ticksSkipped);
        }
    }

    record ExceptionEvent(
            String type, String ts, String plugin, String exceptionClass, String message,
            String stackHash, List<String> topFrames, int count) implements AgentEvent {
        public ExceptionEvent(String ts, String plugin, String exceptionClass, String message,
                              String stackHash, List<String> topFrames, int count) {
            this("exception", ts, plugin, exceptionClass, message, stackHash, topFrames, count);
        }

        public ExceptionEvent withCount(int newCount) {
            return new ExceptionEvent(type, ts, plugin, exceptionClass, message, stackHash, topFrames, newCount);
        }
    }

    record PluginRef(String name, String version) {}

    record PluginUpdate(String name, String from, String to) {}

    record PluginsChanged(String type, String ts, List<PluginRef> added, List<PluginRef> removed, List<PluginUpdate> updated)
            implements AgentEvent {
        public PluginsChanged(String ts, List<PluginRef> added, List<PluginRef> removed, List<PluginUpdate> updated) {
            this("plugins_changed", ts, added, removed, updated);
        }
    }
}
