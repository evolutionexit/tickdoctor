package dev.tickdoctor.agent.collectors;

import dev.tickdoctor.agent.model.MetricSample;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

/**
 * The agent's only repeating main-thread task (runs every tick). Once a second it copies TPS and
 * player pings (cheap reads that must happen on the main thread); every tick it gives the
 * {@link WorldScanner} its slice of budget.
 */
public final class MainThreadSampler implements Runnable {
    public record Players(int count, List<MetricSample.Ping> pings) {}

    private final Overhead overhead;
    private final WorldScanner scanner;
    private int ticks;
    private volatile double[] tps = {20, 20, 20};
    private volatile Players players = new Players(0, List.of());
    private volatile Set<String> playerNames = Set.of();

    public MainThreadSampler(Overhead overhead, WorldScanner scanner) {
        this.overhead = overhead;
        this.scanner = scanner;
    }

    @Override
    public void run() {
        if (ticks++ % 20 == 0) {
            long t0 = System.nanoTime();
            try {
                double[] t = Bukkit.getTPS();
                tps = new double[] {t[0], t.length > 1 ? t[1] : t[0], t.length > 2 ? t[2] : t[0]};
                Collection<? extends Player> online = Bukkit.getOnlinePlayers();
                // ping values only, never who they belong to
                List<MetricSample.Ping> pings = new ArrayList<>(Math.min(1000, online.size()));
                for (Player p : online) {
                    if (pings.size() >= 1000) break;
                    pings.add(new MetricSample.Ping(Math.max(0, p.getPing())));
                }
                players = new Players(online.size(), pings);
                if (online.size() != playerNames.size() || !allKnown(online)) {
                    Set<String> names = new HashSet<>(online.size() * 2);
                    for (Player p : online) names.add(p.getName());
                    playerNames = Set.copyOf(names);
                }
            } finally {
                overhead.addMain(System.nanoTime() - t0);
            }
        }
        scanner.tick();
    }

    private boolean allKnown(Collection<? extends Player> online) {
        Set<String> known = playerNames;
        for (Player p : online) if (!known.contains(p.getName())) return false;
        return true;
    }

    /** Immutable snapshot of online player names, refreshed every second on the main thread. */
    public Set<String> playerNames() {
        return playerNames;
    }

    public double[] tps() {
        return tps;
    }

    public Players players() {
        return players;
    }
}
