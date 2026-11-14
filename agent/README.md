# TickDoctor agent (Paper plugin)

Measures why a Paper server lags and sends it to the TickDoctor API. Target: **Paper 26.2 (build 83+), Java 25**.
Contract: `packages/shared/src/contracts/ingest.ts` → `docs/contracts/ingest.schema.json` (see `docs/contracts.md` §1).

## Build

```sh
cd agent
export JAVA_HOME=~/.local/jdk/current     # any JDK 25
./gradlew build                            # compiles, runs the tests, builds the jar
# → build/libs/tickdoctor-agent-0.1.6.jar
```

No dependencies are bundled: the plugin only uses the JDK, the Paper API, Gson (ships with Paper) and Log4j (ships with Paper).
The tests validate payloads built by the real serializers against `docs/contracts/ingest.schema.json`, so re-run them after
any contract change (`pnpm --filter @tickdoctor/shared gen:schema` first).

Optional: validate request bodies captured from a real server. Point the agent at a stub API that saves each decompressed
body as `NNNN-<kind>.json` (kind = hello, metrics, events, snapshot), then run
`TICKDOCTOR_BODIES=/path/to/bodies ./gradlew test`.

## Install

1. Copy the jar into `plugins/`, start the server once. It creates `plugins/TickDoctor/config.yml`.
2. Set `api-key` (and `api-url` if the API isn't on `http://localhost:4000`).
3. `/tickdoctor reload` (or restart). The log says `collecting every 10 s, sending to …`.

### API keys

Each server has its own key, `td_live_<base62>` (shown once in the dashboard when the server is created or the key is rotated).

- **Empty or placeholder key** (`""`, `td_live_xxx`, `your-api-key`, `<…>`, …): one warning on enable/reload
  ("set api-key in plugins/TickDoctor/config.yml — get one from your TickDoctor dashboard") and the plugin stays idle: no collectors, no
  main-thread work, no sending, nothing buffered. `/tickdoctor status` says `idle — set api-key …`.
- **Key not starting with `td_live_`**: one warning, then it is tried anyway (the API decides).
- **401 `invalid_key` / `revoked_key`**: sending stops (one loud log block, the disk buffer stays bounded by
  `buffer-max-mb`), status shows `stopped: invalid/revoked key (<error>) — run /tickdoctor reload after fixing config`.

## Configure (`plugins/TickDoctor/config.yml`)

| Key | Default | Meaning |
|---|---|---|
| `api-key` | `""` | `td_live_…` key from the dashboard. Required. Never logged. |
| `api-url` | `http://localhost:4000` | API base URL; requests go to `<api-url>/v1/ingest/<kind>`. Plain `http://` is refused unless the host is loopback, LAN (RFC 1918), link-local or Tailscale/CGNAT (100.64.0.0/10); hostnames are checked after DNS. |
| `metrics-interval-seconds` | `10` | One metrics sample per interval (5–300). The API can change it via the response `config`. |
| `privacy-mode` | `hashed` | `hashed` or `none`; both are accepted and currently behave the same: no player identifiers are sent at all (pings are values only, join/leave carry only the count). Reported in hello as `privacyMode`. |
| `snapshot-mspt-threshold` | `50` | Lag snapshot when the 5-second MSPT p95 stays above this (20–1000 ms) for ~5 s. |
| `buffer-max-mb` | `50` | On-disk buffer for when the API is unreachable; oldest batches dropped first. |
| `debug-log-payloads` | `false` | Logs one line per request (size, status, gist), never the JSON. |

Remote changes from the API (interval, threshold) last until the next restart or `/tickdoctor reload`.

## Commands

Permission `tickdoctor.admin` (op by default). Alias `/td`.

- `/tickdoctor status`: connection state, last push, buffer size, the agent's own overhead, age of the entity/chunk counts. An extra `Losses: …` line appears only when something was dropped (memory-dropped batches, corrupt buffer lines, dropped events, dropped log lines, disk write failures).
- `/tickdoctor snapshot`: collect a snapshot now (at most one per 2 minutes, like the API).
- `/tickdoctor reload`: re-read config.yml and restart the agent (sends the buffer first).

## Files in `plugins/TickDoctor/`

`buffer/` (unsent batches,
`<seq>.<kind>.jsonl`), `plugins.json` (last plugin list, for `plugins_changed`), `running.marker` (exists while running;
left behind after a crash). A `salt.txt` left by agents before 0.1.5 is deleted on start.

## What is sent

**hello** (on start and after `plugins_changed`): server software/version, Minecraft version, online mode, max players,
Java version/vendor, JVM flags (allow-list: standard options such as `-Xms`/`-Xmx`/`-Xss`/`-XX:*`/`-Xlog*` keep their value; `-Dname=value` keeps its value only for the Aikar's-flags markers `using.aikars.flags` and `aikars.new.flags`, every other property is sent as `-Dname=***`; `-javaagent`/`-agentpath`/`-agentlib`/`-classpath`/`-cp`/`-jar` and any flag containing a home folder are dropped; IPs removed), heap max/init,
CPU count, OS/arch, device model (`/proc/device-tree/model`), total RAM, view/simulation distance, spigot.yml
`entity-activation-range`, allow-listed `config/paper-world-defaults.yml` keys, worlds, plugins, privacy mode.

**metrics** (every interval; several samples per request after an outage):

| Field | Meaning / source |
|---|---|
| `tick.tps1m/5m/15m` | Paper's rolling TPS. |
| `tick.msptAvg/P95/P99/Max` | Tick durations from `ServerTickEndEvent` in this window (nearest-rank percentiles). |
| `tick.tickCount`, `slowTicks` | Ticks measured; ticks > 50 ms with timestamp (worst 100). |
| `jvm.heap*` | JMX heap used/committed/max. |
| `jvm.gcPauses` | Per collector: pauses, total and longest pause in the window (JMX GC notifications). |
| `jvm.threadCount`, `processCpuLoad` | JMX; CPU load of the Java process, 0–1 of the whole machine. When JMX has no reading (negative, e.g. the first call) the last good value is sent (0 before the first). |
| `world[]` | Per world: loaded chunks, entities, top 20 entity and block-entity types (+ `other`), newly generated chunks/min (0 when none), `countsAgeSeconds`. |
| `worstChunks` | Top 10 chunks (all worlds) by entities + block entities, with the most common entity type. |
| `players` | Online count; each online player's ping as a bare value (`{pingMs}`, no id). |
| `host.*` (Linux) | `cpuLoad1m` (/proc/loadavg), `cpuUsage` (/proc/stat delta), `cpuTempC` (/sys/class/thermal or `vcgencmd measure_temp`), `throttled` (`vcgencmd get_throttled`: `now` = bits 0–3, `sinceBoot` = bits 16–19; see *Throttling* below), RAM/swap (/proc/meminfo), disk total/used (filesystem of the server dir), disk read/write B/s (/proc/diskstats, physical disks only), network rx/tx B/s (/proc/net/dev, excluding lo/VPN/bridges). Anything unavailable is omitted. |
| `agentOverhead` | The agent's own main-thread time per tick (avg) and worst tick, plus async CPU ms in the window. |

**events** (batched, flushed every 5 s): `server_start` (with `uncleanPreviousShutdown`), `server_stop`, `crash` (on the
next start after an unclean shutdown; mentions a matching crash report / hs_err file), `player_join`/`player_leave` (player count only, no player id),
`cant_keep_up` (from the server log), `exception` (any WARN/ERROR log line with a throwable; root cause, guessed plugin,
top 5 frames, folded by stack hash with `count`; message and frames have IPs, UUIDs, online player names, URL credentials (`scheme://***@`), home-folder account names (`/home/~/…`), `key=value` / `password: value` secrets and API keys removed), `plugins_changed`.

**snapshot**: a full sample from a fresh world pass, all entity/block-entity types per world, top 50 chunks per world with
per-type counts, top 20 threads by CPU in the last window, and the last 5 minutes of events. Triggered by the threshold
(not in the first 60 s after start; re-arms after 30 s below the threshold, at most every 5 min), by
`/tickdoctor snapshot`, or by the API (`config.requestSnapshot`).

## How it stays light

- Tick timing: two tiny listeners write into a preallocated ring (6,000 ticks); statistics are computed async.
- Entities/chunks: the Bukkit API needs the main thread, so one repeating task visits loaded chunks until it has used
  **0.2 ms** in that tick (1 ms for a snapshot pass), then continues next tick. A pass over ~2,000 chunks takes a second or
  two of ticks. Chunks that got unloaded meanwhile are skipped (never loaded just to be counted); block entities are read
  without snapshots. A new pass starts every metrics interval.
- Everything else (JMX, /proc, vcgencmd, JSON, gzip, HTTP, disk buffer) runs on two low-priority daemon threads.
- The Log4j appender only filters and enqueues (bounded queue); parsing is async.
- Every main-thread piece is timed with `nanoTime` and reported as `agentOverhead`.

## Throttling (Raspberry Pi)

`host.throttled` comes from `vcgencmd get_throttled` and is optional. **On Raspberry Pi OS add the server user to the
`video` group** so it can talk to the firmware, then restart the server:

```sh
sudo usermod -aG video minecraft   # whatever user runs the server
```

The plugin degrades gracefully when that's not possible:

- vcgencmd is looked up in `PATH` plus `/usr/bin`, `/opt/vc/bin`, `/usr/local/bin`, and run only on the collector
  thread (never the main thread), with stdin closed, stderr merged and output capped at 4 KB.
- Each call has a hard 1 s timeout; on timeout the process (and its live children) is killed. Never more than one call
  is in flight.
- If it's unavailable — not Linux, vcgencmd not found, permission denied (not in `video`), non-zero exit (e.g.
  `VCHI initialization failed`), unexpected output, or a hang — `throttled` is **omitted, never sent as false**, a single
  INFO line says why, and vcgencmd is not tried again for 10 minutes (not on every sample). Not Linux = never re-checked.
- A working vcgencmd that later fails also drops to omitted (no stale value) with the same 10-minute back-off.
- Pi 5 also exposes an under-voltage alarm (`/sys/class/hwmon/hwmon*/name` = `rpi_volt`, `in0_lcrit_alarm`). It
  can't fill the contract's `throttled` object (no frequency-capped/throttled bits), so it is **not** used to fake one;
  the INFO line just mentions it.
- `vcgencmd measure_temp` is only used when no `/sys/class/thermal` zone gives a temperature, under the same rules.

## Delivery

JDK HttpClient, gzip, `Authorization: Bearer`. Memory first; on failure everything pending goes to the disk buffer,
which is drained oldest-first once the API answers again (merging batches of the same kind up to 60 samples / 500 events,
skipping files of other kinds, ≤ 900 KB UTF-8 JSON,
≥ 2.1 s between requests to stay under the ~30 req/min limit). Backoff 5 s → 5 min (±20 % jitter); 429 waits
`retryAfterSeconds`; 401 stops sending (loud log, data keeps buffering) until the key is fixed and `/tickdoctor reload`;
400 drops the batch; 402 keeps buffering with backoff; 413 halves the batch (a single oversized item is dropped).
While the disk buffer is non-empty, new data goes straight to disk behind it; the memory queue is capped at 8 MB (spills to
disk beyond). Unreadable buffer files are discarded and corrupt lines dropped individually. No lock is held during a
request, so `/tickdoctor status` never waits on the network; `/tickdoctor reload` flushes and restarts on a worker thread.
On shutdown it tries to deliver what is in memory if the API was reachable (whole shutdown capped at 3 s); the rest is
sent after restart.

## Known limitations

- The budget is checked between chunks, so a tick can overshoot 0.2 ms by one chunk (a chunk with thousands of entities).
  The first pass and the startup tick include one-time class loading (tens of ms once; visible as "worst ever" in status).
- Counts are up to one interval old (`countsAgeSeconds`); snapshots use a fresh pass.
- A completely frozen main thread can't be snapshotted (the pass needs ticks); the freeze shows up as slow ticks and
  `cant_keep_up` afterwards.
- `gcPauses` skips ZGC/Shenandoah "Cycles" beans (they're concurrent cycles, not pauses).
- Async CPU excludes the JDK HttpClient's internal selector thread.
- Exception messages may still contain file paths outside home folders and names of players who are offline.
- Disk I/O sums all physical disks, not only the one with the server; zram swap traffic is excluded.
- `throttled` needs vcgencmd and the server user in the `video` group (see *Throttling*); a user added to the group
  only gets it after a server restart.
- spigot.yml and `config/paper-world-defaults.yml` are read from the server's working directory (custom
  `--spigot-settings` / config paths aren't followed).
- Folia is not supported.
