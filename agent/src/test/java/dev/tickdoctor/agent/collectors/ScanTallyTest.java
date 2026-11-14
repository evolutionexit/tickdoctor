package dev.tickdoctor.agent.collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tickdoctor.agent.model.MetricSample;
import dev.tickdoctor.agent.model.Snapshot;
import dev.tickdoctor.agent.util.CountMaps;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ScanTallyTest {
    static void chunk(ScanTally t, int x, int z, int zombies, int hoppers) {
        t.beginChunk(x, z);
        for (int i = 0; i < zombies; i++) t.entity("zombie");
        for (int i = 0; i < hoppers; i++) t.tileEntity("hopper");
        t.endChunk();
    }

    @Test
    void countsPerWorldAndWorstChunks() {
        ScanTally t = new ScanTally(1_000);
        t.beginWorld("world");
        chunk(t, 0, 0, 3, 0);
        chunk(t, 1, 0, 0, 40);
        t.beginChunk(2, 0);
        t.entity("item");
        t.entity("item");
        t.entity("cow");
        t.tileEntity("chest");
        t.endChunk();
        chunk(t, 3, 0, 0, 0);
        t.beginWorld("world_nether");
        chunk(t, -5, 7, 25, 0);
        t.finish(3_000);

        List<MetricSample.WorldSample> ws = t.worldSamples(4_000, Map.of("world", 12.0));
        assertEquals(2, ws.size());
        MetricSample.WorldSample w = ws.get(0);
        assertEquals("world", w.name());
        assertEquals(4, w.loadedChunks());
        assertEquals(6, w.entities());
        assertEquals(Map.of("zombie", 3, "item", 2, "cow", 1), w.entitiesByType());
        assertEquals(Map.of("hopper", 40, "chest", 1), w.tileEntitiesByType());
        assertEquals(12.0, w.chunkGenPerMinute());
        assertEquals(3.0, w.countsAgeSeconds());
        assertEquals(0.0, ws.get(1).chunkGenPerMinute(), "measured but zero is sent as 0");
        assertEquals(null, t.worldSamples(4_000, null).get(0).chunkGenPerMinute(), "omitted only when not measurable");

        List<MetricSample.WorstChunk> worst = t.worstChunks(10);
        assertEquals(4, worst.size(), "empty chunks are not ranked");
        assertEquals(new MetricSample.WorstChunk("world", 1, 0, 0, 40, null), worst.get(0));
        assertEquals(new MetricSample.WorstChunk("world_nether", -5, 7, 25, 0, "zombie"), worst.get(1));
        assertEquals("item", worst.get(2).topEntityType());
        assertEquals(1, t.worstChunks(1).size());
    }

    @Test
    void keepsOnlyTheTop50PerWorld() {
        ScanTally t = new ScanTally(0);
        t.beginWorld("w");
        for (int i = 1; i <= 500; i++) chunk(t, i, 0, i % 97, 0);
        t.finish(1);
        List<Snapshot.WorldDetail> d = t.worldDetails();
        List<Snapshot.TopChunk> top = d.get(0).topChunks();
        assertEquals(ScanTally.TOP_CHUNKS_PER_WORLD, top.size());
        assertEquals(96, top.get(0).entities());
        for (int i = 1; i < top.size(); i++) assertTrue(top.get(i - 1).entities() >= top.get(i).entities());
        assertEquals(Map.of("zombie", 96), top.get(0).byType());
    }

    @Test
    void countMapsFoldTheTailIntoOther() {
        Map<String, int[]> m = new HashMap<>();
        for (int i = 0; i < 30; i++) m.put("type" + i, new int[] {i + 1});
        Map<String, Integer> top = CountMaps.topN(m, 20);
        assertEquals(21, top.size());
        assertEquals(30, top.get("type29"));
        int otherExpected = 0;
        for (int i = 0; i < 10; i++) otherExpected += i + 1;
        assertEquals(otherExpected, top.get("other"));

        Map<String, int[]> many = new HashMap<>();
        for (int i = 0; i < 500; i++) many.put("t" + i, new int[] {1});
        assertEquals(CountMaps.MAX_KEYS, CountMaps.all(many).size());
        assertEquals(301, CountMaps.all(many).get("other"));

        Map<String, int[]> longKey = Map.of("x".repeat(300), new int[] {2});
        assertEquals(100, CountMaps.all(longKey).keySet().iterator().next().length());
    }
}
