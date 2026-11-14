package dev.tickdoctor.agent.collectors;

import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.BlockState;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;

/**
 * Incremental entity / block-entity / chunk counting on the main thread (the Bukkit API requires
 * it). Each tick it processes loaded chunks until its time budget is used (0.2 ms normally, 1 ms
 * for a snapshot pass), then yields; a full pass over ~2,000 chunks takes a second or two of
 * ticks instead of one big spike. A new pass starts every metrics interval. Results are published
 * as an immutable {@link ScanTally}.
 */
public final class WorldScanner {
    static final long NORMAL_BUDGET_NS = 200_000;
    static final long SNAPSHOT_BUDGET_NS = 1_000_000;

    private final Overhead overhead;
    private volatile long intervalMs;
    private volatile ScanTally last;
    private final AtomicReference<Consumer<ScanTally>> fullPassRequest = new AtomicReference<>();

    // pass state — main thread only
    private ScanTally tally;
    private List<World> worlds;
    private int worldIdx;
    private Chunk[] chunks;
    private int chunkIdx;
    private boolean snapshotMode;
    private Consumer<ScanTally> callback;
    private long nextPassAtMs;

    private final EnumMap<EntityType, String> entityKeys = new EnumMap<>(EntityType.class);
    private final EnumMap<Material, String> materialKeys = new EnumMap<>(Material.class);

    public WorldScanner(Overhead overhead, long intervalMs) {
        this.overhead = overhead;
        this.intervalMs = intervalMs;
    }

    public void setIntervalMs(long ms) {
        this.intervalMs = ms;
    }

    /** Last finished pass, or null before the first one completes. */
    public ScanTally last() {
        return last;
    }

    /**
     * Asks for a fresh full pass (restarting any running one) with the larger snapshot budget.
     * {@code done} runs on the main thread when the pass finishes and must only hand off work.
     */
    public void requestFullPass(Consumer<ScanTally> done) {
        fullPassRequest.set(done);
    }

    /** Main thread, every tick. */
    public void tick() {
        long t0 = System.nanoTime();
        try {
            step(t0);
        } finally {
            overhead.addMain(System.nanoTime() - t0);
        }
    }

    private void step(long t0) {
        Consumer<ScanTally> req = fullPassRequest.getAndSet(null);
        if (req != null) {
            startPass(true);
            callback = req;
        }
        if (tally == null) {
            if (System.currentTimeMillis() < nextPassAtMs) return;
            startPass(false);
        }
        long budget = snapshotMode ? SNAPSHOT_BUDGET_NS : NORMAL_BUDGET_NS;
        while (System.nanoTime() - t0 < budget) {
            if (chunks == null || chunkIdx >= chunks.length) {
                if (worldIdx >= worlds.size()) {
                    finishPass();
                    return;
                }
                World w = worlds.get(worldIdx++);
                chunks = null;
                if (Bukkit.getWorld(w.getUID()) == null) continue; // unloaded meanwhile
                tally.beginWorld(w.getName());
                chunks = w.getLoadedChunks();
                chunkIdx = 0;
                continue;
            }
            Chunk c = chunks[chunkIdx];
            chunks[chunkIdx++] = null; // let unloaded chunks be collected
            if (!c.isLoaded()) continue; // never load a chunk just to count it
            scanChunk(c);
        }
    }

    private void scanChunk(Chunk c) {
        tally.beginChunk(c.getX(), c.getZ());
        if (c.isEntitiesLoaded()) {
            for (Entity e : c.getEntities()) tally.entity(entityKey(e.getType()));
        }
        for (BlockState s : c.getTileEntities(false)) tally.tileEntity(materialKey(s.getType()));
        tally.endChunk();
    }

    private void startPass(boolean snapshot) {
        tally = new ScanTally(System.currentTimeMillis());
        worlds = Bukkit.getWorlds();
        worldIdx = 0;
        chunks = null;
        chunkIdx = 0;
        snapshotMode = snapshot;
        callback = null;
    }

    private void finishPass() {
        long now = System.currentTimeMillis();
        tally.finish(now);
        ScanTally done = tally;
        last = done;
        nextPassAtMs = done.startedAtMs + intervalMs;
        Consumer<ScanTally> cb = callback;
        tally = null;
        worlds = null;
        chunks = null;
        callback = null;
        snapshotMode = false;
        if (cb != null) cb.accept(done);
    }

    private String entityKey(EntityType t) {
        String k = entityKeys.get(t);
        if (k == null) {
            try {
                k = t.getKey().getKey();
            } catch (RuntimeException e) {
                k = t.name().toLowerCase(Locale.ROOT);
            }
            entityKeys.put(t, k);
        }
        return k;
    }

    private String materialKey(Material m) {
        String k = materialKeys.get(m);
        if (k == null) {
            try {
                k = m.getKey().getKey();
            } catch (RuntimeException e) {
                k = m.name().toLowerCase(Locale.ROOT);
            }
            materialKeys.put(m, k);
        }
        return k;
    }
}
