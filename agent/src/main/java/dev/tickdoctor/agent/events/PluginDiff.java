package dev.tickdoctor.agent.events;

import dev.tickdoctor.agent.model.AgentEvent;
import dev.tickdoctor.agent.model.Hello;
import dev.tickdoctor.agent.util.Iso;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Compares the plugin list with the one stored last time. Pure. */
public final class PluginDiff {
    private PluginDiff() {}

    /** A plugins_changed event, or null when nothing changed. */
    public static AgentEvent.PluginsChanged diff(List<Hello.Plugin> before, List<Hello.Plugin> after, long nowMs) {
        Map<String, String> b = toMap(before);
        Map<String, String> a = toMap(after);
        List<AgentEvent.PluginRef> added = new ArrayList<>();
        List<AgentEvent.PluginRef> removed = new ArrayList<>();
        List<AgentEvent.PluginUpdate> updated = new ArrayList<>();
        for (var e : a.entrySet()) {
            String old = b.get(e.getKey());
            if (old == null) {
                if (added.size() < 500) added.add(new AgentEvent.PluginRef(e.getKey(), e.getValue()));
            } else if (!old.equals(e.getValue())) {
                if (updated.size() < 500) updated.add(new AgentEvent.PluginUpdate(e.getKey(), old, e.getValue()));
            }
        }
        for (var e : b.entrySet()) {
            if (!a.containsKey(e.getKey()) && removed.size() < 500) removed.add(new AgentEvent.PluginRef(e.getKey(), e.getValue()));
        }
        if (added.isEmpty() && removed.isEmpty() && updated.isEmpty()) return null;
        return new AgentEvent.PluginsChanged(Iso.ts(nowMs), added, removed, updated);
    }

    private static Map<String, String> toMap(List<Hello.Plugin> l) {
        Map<String, String> m = new LinkedHashMap<>();
        if (l != null) for (Hello.Plugin p : l) m.put(p.name(), p.version());
        return m;
    }
}
