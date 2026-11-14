package dev.tickdoctor.agent.commands;

import dev.tickdoctor.agent.TickDoctorPlugin;
import java.util.List;
import java.util.Locale;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;

/** /tickdoctor status | snapshot | reload — permission tickdoctor.admin (op by default). */
public final class TickDoctorCommand implements TabExecutor {
    private static final List<String> SUBS = List.of("status", "snapshot", "reload");
    private final TickDoctorPlugin plugin;

    public TickDoctorCommand(TickDoctorPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!sender.hasPermission("tickdoctor.admin")) {
            sender.sendMessage(Component.text("You don't have permission (tickdoctor.admin).", NamedTextColor.RED));
            return true;
        }
        String sub = args.length == 0 ? "status" : args[0].toLowerCase(Locale.ROOT);
        switch (sub) {
            case "status" -> {
                List<String> lines = plugin.statusLines();
                for (int i = 0; i < lines.size(); i++) {
                    sender.sendMessage(Component.text(lines.get(i), i == 0 ? NamedTextColor.AQUA : NamedTextColor.GRAY));
                }
            }
            case "snapshot" -> {
                String why = plugin.requestManualSnapshot();
                if (why == null) sender.sendMessage(Component.text("Collecting a snapshot (spread over a few ticks); it is sent automatically.", NamedTextColor.GREEN));
                else sender.sendMessage(Component.text("No snapshot: " + why + ".", NamedTextColor.YELLOW));
            }
            case "reload" -> {
                boolean accepted = plugin.reload(ok -> sender.sendMessage(ok
                        ? Component.text("TickDoctor reloaded.", NamedTextColor.GREEN)
                        : Component.text("TickDoctor reloaded but is not running — check the server log.", NamedTextColor.YELLOW)));
                sender.sendMessage(accepted
                        ? Component.text("Reloading TickDoctor (flushing in the background)…", NamedTextColor.GRAY)
                        : Component.text("A reload is already in progress.", NamedTextColor.YELLOW));
            }
            default -> sender.sendMessage(Component.text("Usage: /" + label + " <status|snapshot|reload>", NamedTextColor.YELLOW));
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length != 1 || !sender.hasPermission("tickdoctor.admin")) return List.of();
        String p = args[0].toLowerCase(Locale.ROOT);
        return SUBS.stream().filter(s -> s.startsWith(p)).toList();
    }
}
