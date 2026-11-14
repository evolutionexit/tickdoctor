# TickDoctor simulated players (mineflayer)

Headless bots that join the Paper test server to produce real player-count, ping, join/leave and chunk-load data. Standalone package (not in the pnpm workspace).

## Install
    cd e2e/bots && npm install      # or: pnpm install --ignore-workspace

## Run
    node run.mjs <ramp|idle-crowd|explorers> [--host <pi-tailscale-ip>] [--port 25565] [--count N] [--minutes M]
                 [--interval S]  # ramp only: seconds between joins (default 60, min 3)
                 [--stagger S]   # other scenarios: seconds between joins (default 3, min 3)
                 [--dry-run]     # validate args, print the plan, do not connect

The host comes from `--host` or the env var `TD_BOT_HOST` (the Pi's Tailscale IP, see your local notes, PI_TAILSCALE_IP); `TD_BOT_PORT` overrides the default port 25565. Always do `--dry-run` first.

| Scenario | Default count | What it is for |
|---|---|---|
| `ramp` | 12 | One bot every 60 s, each random-walking (forward, jump when blocked, random yaw every 2-7 s, sprint ~30%). Then hold `--minutes` (default 10) after the last join and log out. Gives the MSPT-vs-player-count curve (player-count rule) plus real chunk/entity data. |
| `idle-crowd` | 8 | N bots join (3 s apart) and stand still. Load from players alone, separate from exploration. |
| `explorers` | 3 | Each bot sprints in a straight line, in evenly spread directions, jumping when blocked. Forces live chunk generation (chunk-gen rule). |

`--minutes` is the hold time after the last join, so planned total = (count-1) x gap + minutes (default ramp: 11 + 10 = 21 min). Hard global timeout = planned total + 5 min (all bots quit, exit code 3).

Bots: `TDBot01`..., offline auth, `version: "26.1"` (mineflayer 4.39.0 maximum; the server needs ViaVersion + ViaBackwards to accept it on 26.2). No chat, no commands, no op. On kick/disconnect/connect failure a bot reconnects at most twice (10 s delay), then gives up. Dead bots respawn.

## Output
- stdout: one UTC-timestamped line per event (`joined`, `left`, `kicked reason=...`, `error`, `reconnect`, `death`) and a `summary online=N/M avgPing=...` every 30 s.
- `out/<scenario>-<timestamp>.json` (gitignored): per bot `sessions[{joinedAt,leftAt}]`, `kicks`, `errors`, `reconnects`. Ground truth to compare with what TickDoctor recorded.
- SIGINT/SIGTERM (Ctrl-C) and normal end: every bot calls `quit()` (clean leave events), the JSON is written, then the process exits. Do not `kill -9`.

## Safety notes
- The server must be `online-mode=false` for this to work. Do that only for the run, only while the server is reachable solely over Tailscale (playit.service inactive, nothing else exposing 25565). Set `online-mode=true` (and `max-players` back to 8) right after, verify in `server.properties`, and record both timestamps in the phase report.
- `max-players` must be 16 for the default `ramp`.
- Target the Tailscale address only. Never point this at a public server.
- Keep the Mac awake (`caffeinate`) with Tailscale up during the run.
- Remove ViaVersion/ViaBackwards after the run if overhead measurements are needed without them.
