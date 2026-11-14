package dev.tickdoctor.agent;

import dev.tickdoctor.agent.collectors.Overhead;
import dev.tickdoctor.agent.events.EventCollector;
import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.util.Iso;
import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** Join/leave events with the player count only (no player id). Never touches the player's address. */
final class PlayerListener implements Listener {
    private final EventCollector events;
    private final Overhead overhead;

    PlayerListener(EventCollector events, Overhead overhead) {
        this.events = events;
        this.overhead = overhead;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent e) {
        long t0 = System.nanoTime();
        long now = System.currentTimeMillis();
        events.add(new AgentEvent.PlayerJoin(Iso.ts(now), Bukkit.getOnlinePlayers().size()), now);
        overhead.addMain(System.nanoTime() - t0);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent e) {
        long t0 = System.nanoTime();
        long now = System.currentTimeMillis();
        // the leaving player is still in the online list during this event
        int count = Math.max(0, Bukkit.getOnlinePlayers().size() - 1);
        events.add(new AgentEvent.PlayerLeave(Iso.ts(now), count), now);
        overhead.addMain(System.nanoTime() - t0);
    }
}
