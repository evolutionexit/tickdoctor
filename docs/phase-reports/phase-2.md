# Phase 2 report: plugin MVP (2026-11-09)

## What exists
- **`agent/build/libs/tickdoctor-agent-0.1.1.jar`** (202 KB), installed on the Pi (`/opt/minecraft/server/plugins/`), Paper 26.2 / Java 25. Zero bundled dependencies (JDK + Paper API + the Gson/Log4j Paper already ships).
  - Collects: TPS, MSPT avg/p95/p99/max + slow ticks, heap, GC, threads, CPU, chunks/entities/tile entities per world, worst 10 chunks, chunk-generation rate, players + pings (hashed ids), host metrics from `/proc` and `/sys` (CPU, temp, RAM, swap, disk, disk and network I/O).
  - Sends hello / metrics (every 10 s) / events / snapshots; buffers to disk (bounded) when the API is down; backoff with jitter; honours remote config.
  - Commands: `/tickdoctor status | snapshot | reload` (alias `/td`).
- **Ingest contract v1** frozen: zod schemas with size limits on every field (`packages/shared/src/contracts/ingest.ts`) + generated JSON Schema (`docs/contracts/ingest.schema.json`) that the plugin's tests validate against.
- **Stub ingest API** (`apps/api/src/ingest/`): validates all four payloads, gzip with zip-bomb protection, per-IP and per-key rate limits, one summary log line per push, a debug endpoint to inspect what arrived. Dev-only settings are refused in production.
- `ServerTelemetry.jar` moved to `plugins-disabled/` (not deleted; old 0.1.0 jar is there too).

## Real numbers from the Pi (idle server, nobody online)
| | |
|---|---|
| TPS / MSPT avg · p95 · max | 20.0 / 0.13 · 0.21 · 0.86 ms |
| Heap | ~380 MB used of 3 GB max (1 GB committed) |
| Host | 47 °C, CPU 3%, 6 GB RAM free, swap 0, disk 26/125 GB |
| **Plugin overhead** | **0.024 ms per tick on average (0.05 % of the 50 ms budget)**, worst single tick 0.67 ms, background CPU 0.05 % of one core |
| Catch-up after a 1.5 h API outage | 532 buffered batches sent in 9 requests within ~25 s, no errors |

The hello payload matches reality: Paper 26.2-83, Java 25.0.5, `-Xms1G -Xmx3G` + Aikar's flags, view 8 / sim 6, Raspberry Pi 5, 3 worlds. No secrets, home paths, IPs or UUIDs anywhere in the data (checked by QA on the real payloads).

## How the Pi reaches the API
Only through **Tailscale** (the Pi and the Mac are on different, isolated housing subnets). Caddy has a second listener on the Mac's Tailscale IP: plugin `api-url: http://<mac-tailscale-ip>:3001`. The Mac must be awake with Tailscale and OrbStack running during Pi tests. Plain `http://` is only accepted by the plugin for local/private/Tailscale addresses; production will need https.

## Design decisions worth knowing
1. **Main-thread budget:** the plugin counts chunks and entities in slices of at most 0.2 ms per tick and continues next tick, never loads a chunk just to count it, and does everything else (HTTP, JSON, disk, host metrics, log parsing) on background threads.
2. **Never block the server on the network:** after review, no lock is held during an HTTP request; `/tickdoctor status` and shutdown can't hang on a slow API (shutdown waits ≤ 3 s).
3. **Bounded everywhere:** memory queue ≤ 8 MB, disk buffer ≤ 50 MB, every list capped; a corrupt buffer file (e.g. after a power cut) is deleted instead of blocking sending.
4. **Privacy:** player ids = SHA-256 of a per-server secret salt + UUID (salt file 0600, never sent); exception messages scrubbed of IPs, UUIDs, online player names and `password=`-style secrets; JVM flags scrubbed of secrets and home paths.
5. `plugin.yml` rather than the experimental `paper-plugin.yml` (commands in yml, simpler).

## Review and QA
- **Reviewer** (Opus): 2 HIGH, both fixed in 0.1.1 and re-verified on the Pi: a lock held during HTTP could freeze the server on `/tickdoctor status` while the API was slow, and the memory queue could grow to ~170 MB. 7 MEDIUM, all fixed: corrupt buffer files blocked sending, slow catch-up, `/reload` stalling the main thread, scrubbing of exception messages, refusing plain http to public hosts, rate-limiting bad keys, and dev-only settings in production. Most LOWs fixed too (salt permissions, UTF-8 byte limits, home paths in flags).
- **QA** (Sonnet): plugin 86 tests, API 68, typecheck, lint, Playwright 67 (no Phase 1 regressions). Real Pi payloads saved as fixtures (`e2e/fixtures/pi-real/`) and validated against both the zod schemas and the JSON Schema, plus sanity checks. No bugs found.

## Gaps (honest)
- **The idle Pi loads 0 chunks** (nobody online, no spawn chunks), so entity/chunk counting, worst chunks, slow ticks and player hashing have only been exercised on plugin-dev's local test server on the Mac, not on the Pi yet. Phase 4's lag scenarios will cover this.
- **`throttled` is missing** from the Pi's host data: reading it needs `vcgencmd`, which the `minecraft` user can't use (not in the `video` group). Temperature works (from `/sys`).
- **No console on the Pi** (no RCON, `StandardInput=null`, no tmux), so `/tickdoctor snapshot`, `/summon`, `/forceload` etc. can't be run yet. Phase 4 needs this.

## Decisions for you
1. **Console access for Phase 4** (all are system-level changes, so your call; none opens a port):
   - **(Recommended)** systemd drop-in that feeds the server's stdin from a FIFO (`echo "say hi" > /run/minecraft/console`). No packages, keeps systemd supervision and the clean-stop setup; output stays in `journalctl`/`latest.log`.
   - tmux wrapper: full interactive console, but needs `apt install tmux` and a more fragile unit.
   - RCON: not recommended. Paper has no RCON bind address, so it would listen on all interfaces unless firewalled.
2. **Add `minecraft` to the `video` group** so the plugin can report CPU throttling (a real finding for Pi owners; rule 6 in Phase 4). One `usermod` command.
3. Optional: turn on OrbStack's "Start at login" so the stack survives a restart (the Pi buffered 1.5 h of data when it stopped).

## Housekeeping
- plugin-dev ran a throwaway Paper server for local testing in `/tmp/td-smoke` on the Mac; it can be deleted.
- The Pi server is stopped, disabled on boot; 0.1.1 is installed with `debug-log-payloads: true`.

## Next: Phase 3 (ingest + storage)
backend-dev: real per-server API keys (hashed), the tables, rollups (raw → 1 min → 1 h), retention per plan, the metrics read endpoint, `scripts/seed.ts`. plugin-dev: point the plugin at the real API. pi-ops: end-to-end check with real data in Postgres.
