# Phase 3 report: ingest + storage (2026-11-09)

## What exists
- **Real data from the Pi stored in Postgres**: plugin 0.1.2 on the Pi sends with its own per-server key to the API on the Mac (over Tailscale); metrics, events, snapshots and server info land in Postgres and come back through the read endpoint.
- **Per-server API keys**: `td_live_…`, stored only as a peppered SHA-256 hash + a 12-char display prefix; revocable. Until the dashboard exists (Phase 5), servers and keys are managed with a CLI:
  `docker compose exec api node dist/cli.js server:create --name "…" --owner-email …` · `server:list` · `server:rotate-key <id>` · `server:revoke-key <id>` · `server:request-snapshot <id>`.
- **Tables**: users (minimal), servers, api_keys, server_info_history, plugin_inventory_history, metric_samples, metric_rollups_1m, metric_rollups_1h, events, incident_snapshots, job_state. Everything cascades from users → servers, so deleting an account really deletes the data (tested on 9 tables).
- **Rollups** raw → 1 min → 1 h every minute, correct for late data from a plugin's disk buffer; **retention** per plan (`plans.ts`) every hour, in small batches.
- **Read endpoint** `GET /api/servers/:id/metrics?metric&from&to`: picks raw / 1-min / 1-h by range, max 2,000 points, gaps = offline. Temporarily protected by a dev admin token (sessions come in Phase 5).
- **Seed data** (`pnpm seed`): demo user + 2 servers ("Pi Survival", "Friends SMP"), 30 days with day/night player curves and 4 lag episodes for Phase 4 to find (heap pressure, plugin update → degradation, entity build-up, hot afternoon with throttling).
- **Pi console**: `echo "<command>" > /run/minecraft/console` (systemd FIFO socket, writable only by michel + minecraft; never starts the server). How-to: `docs/pi-test-server.md`.
- **Throttling**: no readable `/sys` source on the Pi 5, so `minecraft` was added to the `video` group (approved); `vcgencmd` now works and the data arrives (`0x0`). The plugin leaves the field out cleanly when it can't read it.
- Phase 4 bot plan written: `docs/phase-4-bots.md` (mineflayer over Tailscale; 26.2 support to be confirmed first).

## End-to-end check on the Pi
pi-ops loaded 64 chunks and summoned 30 armor stands + items through the new console:
| Stored | Reality |
|---|---|
| loaded_chunks 0 → 144 | 64 forced + spawn/neighbours over 3 worlds |
| entities 0 → 117 | 30 armor stands + merged items + ~84 natural mobs in the forced chunks |
| worst chunk (0,0): 31 entities, top type armor_stand | correct |
| throttled `0x0`, temp 45–51 °C, swap 0 | matches |
| Paper 26.2-83, Java 25.0.5, `-Xms1G -Xmx3G` in server_info_history | correct |
| events: server_start, plugins_changed 0.1.1→0.1.2, server_stop | correct |
| 0 player ids or 64-hex strings anywhere | correct |
Plugin overhead with that load: ~0.03 ms/tick average, 0.27 ms worst tick. Everything cleaned up afterwards, server stopped.

## Design decisions worth knowing
1. **Privacy first in storage**: the API doesn't store player ids at all, only player counts and the average ping. It also scrubs UUIDs, IPs and long hex strings out of exception text, crash details and thread names before storing. Names of players who are offline can still appear in old exception messages (the plugin removes names of online players), which goes into the privacy policy at go-public.
2. **Idempotent ingest**: re-sending the same data (retries, buffer flushes) never creates duplicates: samples are unique per (server, timestamp), events by a content hash, snapshots by capture time.
3. **Late data is safe**: the rollup job never moves past an ingest transaction that's still open, and ingest transactions are capped at 30 s, so data from a plugin catching up after an outage is always rolled up. Samples older than raw retention are dropped, so a late sample can't overwrite a complete 1-min rollup with a partial one.
4. **Bad clocks**: data stamped > 10 min in the future is dropped (otherwise retention would never delete it). All bucketing is UTC regardless of the DB's time zone.
5. **One place for access control**: the metrics route calls a single `authorizeServerAccess` function; Phase 5 swaps the dev token for "session user owns this server, else 404" there.
6. The Pi's server is on the **Pro** plan (3 days raw, 14 days 1-min) so Phase 4 baselines have enough history.

## Review and QA
- **Reviewer** (Opus): no HIGH. 5 MEDIUM, all fixed: rollup could miss data from a slow transaction, retention ran as one big transaction, future timestamps never expired, exception text could carry UUIDs/IPs, bucketing depended on the DB's time zone. Most LOWs fixed too (weighted averages when re-bucketing, seed refuses production, `server:revoke-key`, one access-control function).
- **QA** (Sonnet): API 128 tests, plugin build, typecheck, lint, Playwright 88 passed (14 skipped by design, API-only tests on the mobile project). New live storage suite (11 tests) with a throwaway server: ingest, read-back, idempotency, future data dropped, scrubbing, rollups, revoked keys, resolutions, cascade delete. No bugs.

## For you
- **OrbStack**: it stopped again when the dev session restarted (the stack runs only while OrbStack does). I don't see it in macOS login items yet; if you enabled "Start at login" in OrbStack's own settings it may not show there. Worth checking.
- A small slip: pi-ops printed the *old Phase 2 test key* into its own log once. That key no longer works anywhere (the stub was removed), so there's no risk. The real key has never been printed.
- Session restarts also stop background agents; the Pi was always left stopped, and I check its state after every restart.

## How to look at it
```sh
cd ~/src/tickdoctor && docker compose up -d
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $DEV_ADMIN_TOKEN" "http://localhost:3000/api/servers/$PI_SERVER_ID/metrics?metric=entities&from=2026-11-09T12:40:00Z&to=2026-11-09T13:00:00Z"
docker compose exec postgres psql -U tickdoctor -c "select name, plan, last_seen_at from servers"
```

## Next: Phase 4 (incidents + findings)
backend-dev: incident detection + snapshots + baselines. pi-ops: lag scenarios through the console (entity spam, hopper farm, chunk generation, small heap) + bots (after confirming mineflayer supports 26.2; `online-mode=false` only temporarily, switched back and logged). rules-engineer: the 11 rules with tests based on those snapshots. qa: each scenario produces the right finding. Then switch the Pi to 4G/4G heap and check the JVM-flags finding becomes `confirmed_fixed`.
