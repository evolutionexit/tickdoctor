package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.model.Snapshot;
import dev.tickdoctor.agent.util.CountMaps;
import dev.tickdoctor.agent.util.Str;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * Counts from one incremental pass over all loaded chunks. Mutated only by the main thread while
 * the pass runs; once finished it is published (volatile) and never mutated again, so async
 * threads can read it freely. Pure Java — no Bukkit types — so it is unit-tested.
 */
public final class ScanTally {
    public static final int TOP_CHUNKS_PER_WORLD = 50;

    public final long startedAtMs;
    private long finishedAtMs;
    private final Map<String, WorldTally> worlds = new LinkedHashMap<>();
    private WorldTally current;

    // reusable per-chunk state (no allocation unless the chunk makes a top list)
    private final HashMap<String, int[]> chunkEntityTypes = new HashMap<>();
    private final HashMap<String, int[]> chunkTileTypes = new HashMap<>();
    private int chunkX;
    private int chunkZ;
    private int chunkEntities;
    private int chunkTiles;

    public ScanTally(long startedAtMs) {
        this.startedAtMs = startedAtMs;
    }

    public static final class WorldTally {
        public final String name;
        int chunks;
        int entities;
        final HashMap<String, int[]> entityTypes = new HashMap<>();
        final HashMap<String, int[]> tileTypes = new HashMap<>();
        final PriorityQueue<ChunkResult> top = new PriorityQueue<>(Comparator.comparingInt(ChunkResult::score).thenComparingInt(c -> -c.x).thenComparingInt(c -> -c.z));

        WorldTally(String name) {
            this.name = name;
        }

        public int chunks() {
            return chunks;
        }

        public int entities() {
            return entities;
        }

        /** Top chunks, worst first. */
        public List<ChunkResult> topChunks() {
            List<ChunkResult> l = new ArrayList<>(top);
            l.sort(Comparator.comparingInt(ChunkResult::score).reversed().thenComparingInt(c -> c.x).thenComparingInt(c -> c.z));
            return l;
        }
    }

    public record ChunkResult(String world, int x, int z, int entities, int tileEntities, String topEntityType, Map<String, int[]> byType) {
        public int score() {
            return entities + tileEntities;
        }
    }

    public void beginWorld(String name) {
        current = worlds.computeIfAbsent(name, WorldTally::new);
    }

    public void beginChunk(int x, int z) {
        chunkEntityTypes.clear();
        chunkTileTypes.clear();
        chunkX = x;
        chunkZ = z;
        chunkEntities = 0;
        chunkTiles = 0;
    }

    public void entity(String type) {
        chunkEntities++;
        current.entities++;
        current.entityTypes.computeIfAbsent(type, k -> new int[1])[0]++;
        chunkEntityTypes.computeIfAbsent(type, k -> new int[1])[0]++;
    }

    public void tileEntity(String type) {
        chunkTiles++;
        current.tileTypes.computeIfAbsent(type, k -> new int[1])[0]++;
        chunkTileTypes.computeIfAbsent(type, k -> new int[1])[0]++;
    }

    public void endChunk() {
        current.chunks++;
        int score = chunkEntities + chunkTiles;
        if (score == 0) return;
        PriorityQueue<ChunkResult> top = current.top;
        if (top.size() >= TOP_CHUNKS_PER_WORLD && top.peek().score() >= score) return;
        String topEntity = null;
        int best = 0;
        for (Map.Entry<String, int[]> e : chunkEntityTypes.entrySet()) {
            int c = e.getValue()[0];
            if (c > best || (c == best && e.getKey().compareTo(topEntity) < 0)) {
                best = c;
                topEntity = e.getKey();
            }
        }
        // byType merges entity and block-entity ids (they don't overlap in vanilla)
        Map<String, int[]> copy = new HashMap<>((chunkEntityTypes.size() + chunkTileTypes.size()) * 2);
        for (Map.Entry<String, int[]> e : chunkEntityTypes.entrySet()) copy.put(e.getKey(), new int[] {e.getValue()[0]});
        for (Map.Entry<String, int[]> e : chunkTileTypes.entrySet()) copy.computeIfAbsent(e.getKey(), k -> new int[1])[0] += e.getValue()[0];
        top.add(new ChunkResult(current.name, chunkX, chunkZ, chunkEntities, chunkTiles, topEntity, copy));
        if (top.size() > TOP_CHUNKS_PER_WORLD) top.poll();
    }

    public void finish(long nowMs) {
        finishedAtMs = nowMs;
        current = null;
    }

    public long finishedAtMs() {
        return finishedAtMs;
    }

    public Map<String, WorldTally> worlds() {
        return worlds;
    }

    public int totalChunks() {
        int n = 0;
        for (WorldTally w : worlds.values()) n += w.chunks;
        return n;
    }

    // ---------- contract views ----------

    /** World entries for a metrics sample: top 20 types + "other". */
    public List<MetricSample.WorldSample> worldSamples(long nowMs, Map<String, Double> chunkGenPerMinute) {
        double age = Math.max(0, (nowMs - startedAtMs) / 1000.0);
        List<MetricSample.WorldSample> out = new ArrayList<>();
        for (WorldTally w : worlds.values()) {
            if (out.size() >= 100) break;
            // measured (counter running) but no new chunks in this world -> 0, not omitted
            Double gen = chunkGenPerMinute == null ? null : chunkGenPerMinute.getOrDefault(w.name, 0.0);
            out.add(new MetricSample.WorldSample(Str.nonEmpty(w.name, "world", 200), w.chunks, w.entities,
                    CountMaps.topN(w.entityTypes, 20), CountMaps.topN(w.tileTypes, 20), gen, Math.round(age * 10) / 10.0));
        }
        return out;
    }

    /** The {@code n} worst chunks across all worlds (entities + tile entities). */
    public List<MetricSample.WorstChunk> worstChunks(int n) {
        List<ChunkResult> all = new ArrayList<>();
        for (WorldTally w : worlds.values()) all.addAll(w.top);
        all.sort(Comparator.comparingInt(ChunkResult::score).reversed().thenComparing(ChunkResult::world).thenComparingInt(ChunkResult::x).thenComparingInt(ChunkResult::z));
        List<MetricSample.WorstChunk> out = new ArrayList<>();
        for (ChunkResult c : all) {
            if (out.size() >= n) break;
            out.add(new MetricSample.WorstChunk(Str.nonEmpty(c.world, "world", 200), c.x, c.z, c.entities, c.tileEntities, Str.cap(c.topEntityType, 100)));
        }
        return out;
    }

    /** Snapshot detail: all types and top 50 chunks per world. */
    public List<Snapshot.WorldDetail> worldDetails() {
        List<Snapshot.WorldDetail> out = new ArrayList<>();
        for (WorldTally w : worlds.values()) {
            if (out.size() >= 100) break;
            List<Snapshot.TopChunk> chunks = new ArrayList<>();
            for (ChunkResult c : w.topChunks()) {
                chunks.add(new Snapshot.TopChunk(c.x, c.z, c.entities, c.tileEntities, CountMaps.all(c.byType)));
            }
            out.add(new Snapshot.WorldDetail(Str.nonEmpty(w.name, "world", 200), CountMaps.all(w.entityTypes), CountMaps.all(w.tileTypes), chunks));
        }
        return out;
    }
}
