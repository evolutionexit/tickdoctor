# Pi test server: how to operate it

Only the `pi-ops` agent (or Michel) touches the Pi: `ssh $PI_SSH` (Tailscale).

## Start / stop
- `sudo systemctl start minecraft` / `sudo systemctl stop minecraft` (clean stop). The service is **disabled on boot on purpose**; never enable it.
- Server dir `/opt/minecraft/server` (owner `minecraft`). Paper 26.2, Java 25, heap `-Xms1G -Xmx3G` (kept on purpose as a test case for the JVM-flags rule).

## Console (added 2026-11-09)
A systemd FIFO socket unit (`minecraft-console.socket`, not enabled; pulled in by `minecraft.service` and stopped with it) feeds the server's stdin.
- **Send a command** (as michel, no sudo): `echo "say hi" > /run/minecraft/console` — one command per `echo`. Only `michel` and `minecraft` can write (`prw--w---- minecraft michel`).
- **Read the output**: `sudo tail -f /opt/minecraft/server/logs/latest.log` or `journalctl -u minecraft -f`. Output is not returned to the writer.
- Wait a few seconds after `Done (…)!` before the first command (commands sent within ~1 s threw a Paper NPE).
- While the server is stopped the pipe doesn't exist, so writes fail. Writing never starts the server.
- No interactive TTY.
- Files: `/etc/systemd/system/minecraft-console.socket`, drop-in `/etc/systemd/system/minecraft.service.d/console.conf` (`StandardInput=socket`, `StandardOutput/StandardError=journal`). Backups: `/etc/systemd/system/minecraft.service.bak-20261109`, `~/minecraft.service.d.bak-20261109/`.

## Throttling data
The Pi 5 has no world-readable `/sys` source for the throttle bitmask, so `minecraft` was added to the `video` group (2026-11-09, approved) → `vcgencmd get_throttled` works for the plugin. Under-voltage alone is readable at `/sys/class/hwmon/hwmon5/in0_lcrit_alarm`. The plugin omits `throttled` when neither works.

## TickDoctor plugin
`plugins/tickdoctor-agent-<version>.jar`, config `plugins/TickDoctor/config.yml` (api-url `http://<mac-tailscale-ip>:3001` = Caddy's Tailscale listener on the Mac; key never in git). Old jars and `ServerTelemetry.jar` are in `plugins-disabled/`.
During tests the Mac must be awake (`caffeinate`) with Tailscale and OrbStack running.

## Network to the Mac (2026-11-13)
The plugin sends to `http://<mac-magicdns-name>:3001` (the Mac's Tailscale MagicDNS name). MagicDNS is off on this Pi on purpose (Wi-Fi AP + Proton WireGuard), so the name comes from **`/etc/hosts`**:
```
# TickDoctor dev: Mac's Tailscale IP (MagicDNS off on this Pi). Update if the Mac's Tailscale IP changes.
<mac-tailscale-ip> <mac-magicdns-name>
```
If the Mac's Tailscale IP changes (`tailscale ip -4` on the Mac), edit that line (and `INGEST_BIND_IP` in the Mac's `.env`). Check: `getent hosts <mac-magicdns-name>` and `curl -s http://<mac-magicdns-name>:3001/health` from the Pi.

## Backups
`~/mc-backup-20261109-0932.tar.gz` (full server dir before any change).
