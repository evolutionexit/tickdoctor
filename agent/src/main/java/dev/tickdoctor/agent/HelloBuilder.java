package dev.tickdoctor.agent;

import dev.tickdoctor.agent.collectors.host.HostCollector;
import dev.tickdoctor.agent.model.Hello;
import dev.tickdoctor.agent.privacy.PrivacyMode;
import dev.tickdoctor.agent.privacy.Redaction;
import dev.tickdoctor.agent.util.Str;
import java.io.File;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.plugin.Plugin;

/** Builds the hello payload: a cheap main-thread read of server state, the rest async. */
public final class HelloBuilder {
    /** Server state copied on the main thread. */
    public record ServerInfo(
            String software, String version, String minecraftVersion, boolean onlineMode, int maxPlayers,
            int viewDistance, int simulationDistance, List<Hello.World> worlds, List<Hello.Plugin> plugins,
            Map<String, String> mainClasses) {}

    /** paper-world-defaults.yml keys (and sub-keys) worth knowing for lag diagnosis. */
    static final List<String> PAPER_ALLOW = List.of(
            "chunks.auto-save-interval",
            "chunks.delay-chunk-unloads-by",
            "chunks.max-auto-save-chunks-per-tick",
            "chunks.prevent-moving-into-unloaded-chunks",
            "chunks.entity-per-chunk-save-limit",
            "collisions.max-entity-collisions",
            "collisions.fix-climbing-bypassing-cramming-rule",
            "entities.armor-stands.tick",
            "entities.armor-stands.do-collision-entity-lookups",
            "entities.spawning.per-player-mob-spawns",
            "entities.spawning.spawn-limits",
            "entities.spawning.ticks-per-spawn",
            "entities.spawning.despawn-ranges",
            "entities.spawning.alt-item-despawn-rate.enabled",
            "entities.behavior.disable-chest-cat-detection",
            "environment.optimize-explosions",
            "environment.treasure-maps.enabled",
            "hopper.cooldown-when-full",
            "hopper.disable-move-event",
            "hopper.ignore-occluding-blocks",
            "misc.redstone-implementation",
            "tick-rates.container-update",
            "tick-rates.grass-spread",
            "tick-rates.mob-spawner",
            "tick-rates.dry-farmland",
            "tick-rates.wet-farmland");

    private HelloBuilder() {}

    /** Main thread. */
    public static ServerInfo gather() {
        List<Hello.World> worlds = new ArrayList<>();
        for (World w : Bukkit.getWorlds()) {
            if (worlds.size() >= 100) break;
            String env = switch (w.getEnvironment()) {
                case NORMAL -> "NORMAL";
                case NETHER -> "NETHER";
                case THE_END -> "THE_END";
                default -> "CUSTOM";
            };
            worlds.add(new Hello.World(Str.nonEmpty(w.getName(), "world", 200), env));
        }
        List<Hello.Plugin> plugins = new ArrayList<>();
        Map<String, String> mains = new LinkedHashMap<>();
        for (Plugin p : Bukkit.getPluginManager().getPlugins()) {
            if (plugins.size() >= 500) break;
            var meta = p.getPluginMeta();
            plugins.add(new Hello.Plugin(Str.nonEmpty(meta.getName(), "unknown", 200), Str.nonEmpty(meta.getVersion(), "", 100), p.isEnabled()));
            mains.put(meta.getName(), meta.getMainClass());
        }
        plugins.sort((a, b) -> a.name().compareToIgnoreCase(b.name()));
        return new ServerInfo(Bukkit.getName(), Bukkit.getVersion(), Bukkit.getMinecraftVersion(), Bukkit.getOnlineMode(),
                Bukkit.getMaxPlayers(), Bukkit.getViewDistance(), Bukkit.getSimulationDistance(), worlds, plugins, mains);
    }

    /** Async. */
    public static Hello build(ServerInfo s, PrivacyMode privacy, HostCollector host, File serverDir) {
        String version = s.version();
        int mc = version == null ? -1 : version.indexOf(" (MC:");
        if (mc > 0) version = version.substring(0, mc);

        List<String> flags = new ArrayList<>();
        for (String f : Redaction.redactFlags(ManagementFactory.getRuntimeMXBean().getInputArguments())) {
            if (flags.size() >= 200) break;
            flags.add(Str.cap(f, 1000));
        }
        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        Hello.Jvm jvm = new Hello.Jvm(
                Str.cap(System.getProperty("java.version", "") + " (" + System.getProperty("java.vm.name", "") + ")", 80),
                Str.cap(System.getProperty("java.vendor", ""), 200),
                flags,
                Math.max(0, heap.getMax()),
                Math.max(0, heap.getInit()),
                Runtime.getRuntime().availableProcessors());

        Long totalMem = host == null ? null : host.memTotalBytes();
        if (totalMem == null && ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os) {
            long t = os.getTotalMemorySize();
            if (t > 0) totalMem = t;
        }
        Hello.Host h = new Hello.Host(
                Str.cap(System.getProperty("os.name", "") + " " + System.getProperty("os.version", ""), 100),
                Str.cap(System.getProperty("os.arch", ""), 50),
                host == null ? null : Str.capOrNull(host.deviceModel(), 200),
                totalMem);

        Hello.Config cfg = new Hello.Config(Math.max(0, s.viewDistance()), Math.max(0, s.simulationDistance()),
                entityActivationRange(serverDir), paperWorldDefaults(serverDir));

        return new Hello(
                new Hello.Server(Str.nonEmpty(s.software(), "Paper", 200), Str.nonEmpty(version, "unknown", 200),
                        Str.cap(s.minecraftVersion() == null ? "" : s.minecraftVersion(), 40), s.onlineMode(), Math.max(0, s.maxPlayers())),
                jvm, h, cfg, s.worlds(), s.plugins(), privacy.wire());
    }

    /** spigot.yml world-settings.default.entity-activation-range (read from the server directory). */
    static Map<String, Integer> entityActivationRange(File serverDir) {
        File f = new File(serverDir, "spigot.yml");
        if (!f.isFile()) return null;
        try {
            ConfigurationSection sec = YamlConfiguration.loadConfiguration(f).getConfigurationSection("world-settings.default.entity-activation-range");
            if (sec == null) return null;
            Map<String, Integer> out = new LinkedHashMap<>();
            for (String k : sec.getKeys(false)) {
                Object v = sec.get(k);
                if (v instanceof Number n && out.size() < 50) out.put(Str.cap(k, 50), n.intValue());
            }
            return out.isEmpty() ? null : out;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static Map<String, Object> paperWorldDefaults(File serverDir) {
        File f = new File(serverDir, "config/paper-world-defaults.yml");
        if (!f.isFile()) return null;
        try {
            return allowListed(YamlConfiguration.loadConfiguration(f));
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Scalars under the allow-listed keys only (≤ 200 keys). */
    static Map<String, Object> allowListed(ConfigurationSection root) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : PAPER_ALLOW) {
            Object v = root.get(key);
            if (v instanceof ConfigurationSection sec) {
                for (String sub : sec.getKeys(true)) {
                    Object sv = sec.get(sub);
                    if (!(sv instanceof ConfigurationSection)) put(out, key + "." + sub, sv);
                }
            } else {
                put(out, key, v);
            }
        }
        return out.isEmpty() ? null : out;
    }

    private static final Set<Class<?>> SCALARS = Set.of(String.class, Boolean.class, Integer.class, Long.class, Double.class, Float.class, Short.class, Byte.class);

    private static void put(Map<String, Object> out, String key, Object v) {
        if (v == null || out.size() >= 200 || key.length() > 100 || !SCALARS.contains(v.getClass())) return;
        if (v instanceof String s) v = Str.cap(s, 200);
        if (v instanceof Double d && !Double.isFinite(d)) return;
        if (v instanceof Float fl && !Float.isFinite(fl)) return;
        out.put(key, v);
    }
}
