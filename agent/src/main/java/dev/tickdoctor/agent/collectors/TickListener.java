package dev.tickdoctor.agent.collectors;

import com.destroystokyo.paper.event.server.ServerTickEndEvent;
import com.destroystokyo.paper.event.server.ServerTickStartEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.world.ChunkLoadEvent;

/** Tick timing (into the preallocated ring) and chunk-generation counting. Main thread, tiny. */
public final class TickListener implements Listener {
    private final TickRing ring;
    private final Overhead overhead;
    private final ChunkGenCounter chunkGen;

    public TickListener(TickRing ring, Overhead overhead, ChunkGenCounter chunkGen) {
        this.ring = ring;
        this.overhead = overhead;
        this.chunkGen = chunkGen;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTickStart(ServerTickStartEvent e) {
        long t0 = System.nanoTime();
        overhead.endTick();
        overhead.addMain(System.nanoTime() - t0);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTickEnd(ServerTickEndEvent e) {
        long t0 = System.nanoTime();
        ring.record(System.currentTimeMillis(), e.getTickDuration());
        overhead.addMain(System.nanoTime() - t0);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onChunkLoad(ChunkLoadEvent e) {
        if (!e.isNewChunk()) return;
        long t0 = System.nanoTime();
        chunkGen.newChunk(e.getWorld().getName());
        overhead.addMain(System.nanoTime() - t0);
    }
}
