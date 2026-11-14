# Phase 4 plan: simulated players (proposal, not started)

Why: the player-count rule ("MSPT degrades above N players") and player-id hashing can only be tested with real connections. Nobody plays on the Pi, so we simulate players.

## Proposal: mineflayer bots from the Mac over Tailscale
- **mineflayer** (Node, PrismarineJS) runs N headless clients from the Mac; they connect to the Pi at `<pi-tailscale-ip>:25565` over Tailscale (no router or playit changes; Tailscale is the only path we use).
- A small script in `e2e/bots/` (owned by qa) with scenarios:
  - `ramp`: add one bot every 60 s up to 12 (above `max-players=8` → temporarily raise to 16 for the test), each bot walks/explores randomly so it loads chunks and triggers chunk generation → gives the player-count curve and real chunk/entity data.
  - `idle-crowd`: 8 bots standing still (load from players alone vs. exploration).
  - `explorers`: 3 bots flying straight lines (live chunk generation → rule 9).
  - Every bot logs out cleanly at the end (join/leave events, ping data).
- What it verifies: player count + pings in metrics, join/leave events, the player-count rule's threshold, worst chunks, chunk-gen rate, and that **no UUID or name reaches the API** (hashing on the agent, minimisation on the API).

## Authentication: online-mode
- Bots have no Microsoft accounts, so the test needs `online-mode=false` **temporarily**. Acceptable only because the server is reachable solely via Tailscale during the test: playit.service stays stopped (it's currently failed anyway; pi-ops confirms it's inactive before flipping), and nothing else exposes port 25565 to the internet.
- pi-ops flips `online-mode=false` (+ `max-players=16`) just before the bot run and **switches back to `online-mode=true`, `max-players=8` right after**, verifies in `server.properties`, and the Phase 4 report records both timestamps.
- Offline-mode UUIDs differ from real ones; that's fine for hashing tests.

## Version risk (check first)
Minecraft 26.2 is recent. As of 2026-11-09 I found evidence that mineflayer/minecraft-data support **26.1.2** but no confirmation for **26.2** (Java). First step in Phase 4: check `minecraft-data` `data/pc/common/versions.json` and mineflayer's supported list.
- If 26.2 is supported → use it directly.
- If not → fallback A: install **ViaBackwards + ViaVersion** on the test server for the bot run only (lets 26.1.x clients join), remove them afterwards. Caveat: they add a little server overhead, so overhead measurements are taken without them.
- Fallback B: a test-only "load" command via the console pipe that spawns entities and force-loads chunks (covers entity/chunk rules, but not the player-count rule).

## Cost
Free. Each mineflayer bot uses ~50–80 MB RAM on the Mac; 16 bots is fine. Network over Tailscale is small (a few KB/s per bot).
