# Phase 4 report: incidents + findings (2026-11-09)

## What exists
- **Incident detection.** Runs on every metrics push from the plugin.
  - **Opens** when MSPT p95 stays at or above 50 ms for 30 s, **or** when TPS stays below 18 for 90 s. The TPS trigger catches "freeze" lag: single ticks that last several seconds, which p95 misses.
  - **Closes** after 2 healthy minutes.
  - Each incident gets a linked snapshot (requested from the plugin if none arrives within 30 s) and a **baseline**: what this server looks like when healthy, taken from the last healthy hours.
- **The 11 rules** in `apps/api/src/rules/`, one file each. They are pure functions: the same input data always gives the same findings, so every rule can be tested on recorded data. 154 rule tests.
- **Findings lifecycle.**
  - There is one finding per problem. If the problem comes back, its "seen" count goes up and its evidence is refreshed.
  - The owner marks a finding fixed (CLI now, button in Phase 6), and the problem must then stay away for 15 min (config and host issues) or 72 h (incident causes) before it becomes `confirmed_fixed`. If the problem returns, the finding reopens.
  - Config and host findings also clear by themselves once the condition has been gone for 15 min (`resolvedBy: auto`).
- **CLI** (until the app has screens): `incident:list|show`, `incidents:backfill`, `finding:list|show|mark-fixed`, `rules:run [--incident]`, `rules:context`. The last one dumps exactly the data a rule sees; it is how the real Pi runs became test fixtures.
- **Seed data**: the 4 seeded lag episodes become exactly 4 incidents, each with the right finding. Healthy seed time produces no incidents.
- `pnpm lint` really runs now. It never did before, because ESLint wasn't installed. I added a root config and fixed the 11 lint errors it found.
- Contracts: `docs/contracts.md` §6, `packages/shared/src/contracts/{incidents,findings}.ts`, `apps/api/src/rules/types.ts`.

## How the rules were made trustworthy
"A rule that fires on a healthy server is a bug." Every rule is tested against:
1. Problem cases, where it must fire.
2. **Healthy seed data**: windows every ~5 h across 30 days, for both demo servers, including busy evenings. Only two findings may appear there: the two JVM tuning tips on the seed Pi, which really has those settings.
3. **The real idle Pi**: only the JVM tuning tip may appear.
4. **The real Pi lag runs**, recorded with `rules:context`: each scenario must give its expected finding, and every other rule must stay silent.
5. A test that freezes the input data, so a rule that tried to change it would fail.

The first real Pi run proved this step necessary:
- Both real incidents initially produced **0 findings**. The entity rule only knew "item pile in one chunk" (seed-style). The real case was 450 villagers spread over 25 chunks, which is just as deadly on a Pi.
- Chunk generation froze the server for up to 21 s, but never opened an incident, because p95 counts ticks, not time.

Both are fixed: entity cost is now weighted by type (villagers ≫ items) with Pi-specific limits, and incidents also open on sustained low TPS.

## Pi test sessions (all times UTC, 2026-11-09)
| Session | Window | What |
|---|---|---|
| 1 | 14:59–17:20 | 91 min idle, then entity spam, a hopper hotspot, chunk generation (forceload over fresh land), and a small heap (-Xms512M -Xmx768M, restored afterwards; identical checksum) |
| 2a | 17:41–18:45 | The hopper build again (live check of the early warning), then ViaVersion + ViaBackwards 5.12.2 and simulated players: 12 bots ramping up, then 3 explorers. Everything reverted. |
| 2b | 18:48–21:33 | Heap switched to **-Xms4G -Xmx4G** (permanent), then idle |

- Temperature never went above 59.5 °C (the stop line was 75 °C). Swap stayed at 0. Per your instruction, no heat or swap stress was attempted.
- **online-mode**: set to `false` at **18:04:24** (effective 18:04:30) and back to `true` at **18:38:15** (effective 18:38:28), so about 34 min. During that time the server listened **only on its Tailscale address** (`server-ip=<pi-tailscale-ip>`, verified with `ss`), with a whitelist of just the 12 bot names, and playit was inactive. All values were restored from backups.
- ViaVersion/ViaBackwards: installed at 18:04 (checksums verified against Modrinth) and removed at 18:39. The jars are in `~/via-removed-20261109/` on the Pi.
- Bots: 15 sessions, all clean logouts, 0 kicks in the ramp. Player counts in TickDoctor matched the bot logs (202 of 203 samples; the other one was a leave a few seconds late). **No bot name, player id or UUID was stored anywhere.**
- Plugin overhead under load: 0.02–0.03 ms per tick on average, 0.31 ms worst single tick.
- Final state: the server is stopped and disabled on boot, the heap is 4G/4G, there are no forceloads, and `server.properties` is back to the original.

## The 11 rules: how far each one is verified
- **"Verified live"** means the real Pi produced the finding through the running system (detector → engine → database).
- **"Silent live"** means the rule correctly stayed quiet on the real Pi when it should have. That's half the job, but it isn't proof the rule fires.

| # | Rule | Status | Evidence |
|---|---|---|---|
| 1 | entity-explosion | **Verified live on the Pi** | Entity spam (450 villagers + 300 others) and the small-heap run → "Far more villagers and other mobs than usual", high |
| 2 | tile-entity-hotspot | **Verified live on the Pi** (early warning, server scope) | 5,120 working hoppers → low "Early warning", seen 7 min after building; auto-confirmed fixed after removal. The incident-scope variant (hoppers causing lag) is tested on fixtures only. |
| 3 | plugin-change-before-lag | Fixtures only (silent live) | ViaVersion/ViaBackwards added at 18:04 → no lag followed, so correctly no finding and **no test-induced findings**. Firing case tested on the seed FarmControl update. |
| 4 | player-count-threshold | Fixtures only (silent live) | 12 bots: MSPT p95 rose only from 7 to 12 ms, so there's no threshold to find; correctly silent. Firing case tested on hand-built history. |
| 5 | gc-pressure | Fixtures only (silent live) | Small heap (768 MB): GC took only 0.8 % of the time, so the lag wasn't memory; correctly silent. The 768 MB heap itself is reported by jvm-flags (`xmx-too-small`, tested on the real run's data). Firing case: seed heap-pressure week. |
| 6 | thermal-throttling | Fixtures only (by your instruction) | Pi stayed ≤ 59.5 °C and `throttled=0x0`: silent live. Firing case: seed hot afternoon. |
| 7 | swap-in-use | Fixtures only (by your instruction) | Swap 0 on the Pi: silent live. Firing case: hand-built cases. |
| 8 | view-distance-too-high | Fixtures only (silent live) | View 8 / sim 6 on a Pi is within limits; correctly didn't claim the chunk-generation lag. |
| 9 | live-chunk-generation | **Verified live on the Pi** | Forceload over fresh land (21 s freezes, TPS 11.8) and the small-heap run → "Lag while new land is being generated", high |
| 10 | plugin-exceptions | Fixtures only (silent live) | A corrupt chunk threw one exception twice: far below the threshold, correctly silent. Firing case: hand-built. |
| 11 | jvm-flags | **Verified live on the Pi** | -Xms1G -Xmx3G → "Tuning tip: starting memory and maximum memory are different" (info); after the switch to -Xms4G -Xmx4G at 18:48 it became **confirmed_fixed** at 19:12 (resolved automatically; see "For you" #1). |

**Not yet tested at all:** none. 4 rules are verified live, 7 on fixtures only (2 of those by your instruction). All 11 stayed silent on the real idle Pi.


## Every finding from the Pi tests, in full

This is what an owner would read, produced by the current rules from the recorded data of each run.

- **Why replayed:** the database keeps one finding per problem with its *latest* evidence, so the entity-spam numbers were overwritten by the small-heap run. Replaying the recorded data shows each run's own text.
- **Live results:** the live findings are e8d09178 (entity-explosion), 5ad585ad (live-chunk-generation), 4188509c (hoppers) and cc87d8c1 (jvm-flags).
- **No test-induced findings:** the ViaVersion install produced none.
- **The bot run** (12 players, no lag) produced none.
- **The small-heap and hopper texts** below are from the current rules; the live database still holds the wording from before the text fixes for those two.

### A. Entity spam: incident 775f5258 (16:32–16:39, medium, peak p95 97.6 ms, TPS down to 15.2)

#### Far more villagers and other mobs than usual
*entity-explosion · high · key `world:villager`*

There are 450 villagers, 151 chickens and 147 dropped items in the world `world`, spread over 25 chunks (the most around X 3,016, Z 3,032); usually there are no entities loaded at all. Villagers are among the most expensive mobs: each one keeps looking for a job site, a bed and a path. The server updates every one of them on every tick, and for a Raspberry Pi this many takes a large part of each of the 20 ticks per second.

**Evidence:**
- Villagers on the whole server: 450 (usually none)
- Chickens on the whole server: 151 (usually none)
- Dropped items on the whole server: 147 (usually none)
- All entities on the server: 770 (usually none)
- Chunks with villagers: 25
- Entities in the busiest chunk: 71
- Chunks for /tp: world (188, 189) · world (188, 188) · world (188, 190) · world (190, 188) · world (189, 189) · world (189, 188) · world (190, 190) · world (190, 189) · world (189, 190) · world (187, 189)
- Chart: entities

**What to do:**

1. Go to the busiest chunk: use the /tp buttons (the chunks are listed busiest first), or `/tp @s 3016 ~ 3032`.
2. Check what the villagers are for: a breeder that keeps running, or a trading hall with more villagers than anyone uses.
3. Turn off breeders (remove the beds or food) and reduce the number: `/kill @e[type=minecraft:villager,distance=..24,limit=50]` removes at most 50 nearby; look first so you don't remove villagers someone trades with.
4. Keep trading villagers in single-block cells with their job block, so they don't keep searching for paths.
5. In `paper-world-defaults.yml` let villagers look for job sites and beds less often: under `tick-rates.sensor.villager` set `secondarypoisensor: 80` and `nearestbedsensor: 80`, and under `tick-rates.behavior.villager` set `validatenearbypoi: 60`. Restart afterwards.
6. In `spigot.yml` lower `entity-activation-range.villagers` (for example to `16`) so villagers far from players are updated less often.

### B. Chunk generation: incident b2ef9187 (16:55–17:02, high, opened by low TPS: 11.8)

#### Lag while new land is being generated
*live-chunk-generation · high · key `chunk-generation`*

During the lag the server generated about 206 new chunks per minute (usually 0) while no players were online, so something on the server was loading new land by itself: a force-loaded area (`/forceload`), a pre-generation tool running at the wrong time, or a plugin that loads far-away chunks (for example for teleports, maps or world borders). The server froze for up to 21.3 seconds at a time and TPS fell to 11.8. Creating new terrain is heavy work for the CPU and holds up the server until it's done.

**Evidence:**
- New chunks generated per minute (average): 206 /min (usually 0)
- Highest rate: 1,138 /min
- Longest single tick (server frozen): 21.3 s
- Freezes of 1 second or more: 15
- Lowest TPS: 11.8 (usually 20)
- Players online: 0
- Chart: chunk_gen_per_min

**What to do:**

1. Find what loads the chunks: run `/forceload query` in each world (for example `/execute in minecraft:overworld run forceload query`) and remove areas you don't need with `/forceload remove <x> <z>` or `/forceload remove all`.
2. Check whether a pre-generation tool (Chunky, a map renderer) was running during this time; schedule it for hours when the server isn't needed, or pause it while people play.
3. Look for plugins that load chunks far away (random teleport, map or world-border plugins): limit their range or let them only use land that already exists.
4. Install the Chunky plugin (from Hangar or Modrinth) and restart, if you don't have it yet.
5. Pre-generate the area that gets loaded, at a quiet time: `/chunky world world`, `/chunky center <x> <z>` with your spawn coordinates (or the middle of where people play), `/chunky radius 3000`, then `/chunky start`. On a Raspberry Pi this can take many hours; `/chunky pause` and `/chunky continue` let you split it up.
6. Set a world border around the same centre so no new chunks get created during play: `/worldborder center <x> <z>` (the same coordinates), then `/worldborder set 6000` (that is twice the radius).

### C. Small heap: incident 173f8e44 (17:08–17:15, critical, a 9 s freeze, TPS 15.6)

#### Far more villagers and other mobs than usual
*entity-explosion · high · key `world:villager`*

There are 450 villagers, 200 chickens and 78 dropped items in the world `world`, spread over 23 chunks (the most around X 3,048, Z 3,032); usually there are no entities loaded at all. Villagers are among the most expensive mobs: each one keeps looking for a job site, a bed and a path. The server updates every one of them on every tick, and for a Raspberry Pi this many takes a large part of each of the 20 ticks per second.

**Evidence:**
- Villagers on the whole server: 450 (usually none)
- Chickens on the whole server: 200 (usually none)
- Dropped items on the whole server: 78 (usually none)
- All entities on the server: 799 (usually none)
- Chunks with villagers: 23
- Entities in the busiest chunk: 57
- Chunks for /tp: world (190, 189) · world (188, 188) · world (188, 190) · world (188, 189) · world (190, 188) · world (190, 190) · world (189, 188) · world (189, 190) · world (189, 189) · world (190, 187)
- Chart: entities

**What to do:**

1. Go to the busiest chunk: use the /tp buttons (the chunks are listed busiest first), or `/tp @s 3048 ~ 3032`.
2. Check what the villagers are for: a breeder that keeps running, or a trading hall with more villagers than anyone uses.
3. Turn off breeders (remove the beds or food) and reduce the number: `/kill @e[type=minecraft:villager,distance=..24,limit=50]` removes at most 50 nearby; look first so you don't remove villagers someone trades with.
4. Keep trading villagers in single-block cells with their job block, so they don't keep searching for paths.
5. In `paper-world-defaults.yml` let villagers look for job sites and beds less often: under `tick-rates.sensor.villager` set `secondarypoisensor: 80` and `nearestbedsensor: 80`, and under `tick-rates.behavior.villager` set `validatenearbypoi: 60`. Restart afterwards.
6. In `spigot.yml` lower `entity-activation-range.villagers` (for example to `16`) so villagers far from players are updated less often.


#### Lag while new land is being generated
*live-chunk-generation · high · key `chunk-generation`*

During the lag the server generated about 36 new chunks per minute (usually 0) while no players were online, so something on the server was loading new land by itself: a force-loaded area (`/forceload`), a pre-generation tool running at the wrong time, or a plugin that loads far-away chunks (for example for teleports, maps or world borders). The server froze for up to 9 seconds at a time and TPS fell to 15.6. Creating new terrain is heavy work for the CPU and holds up the server until it's done.

**Evidence:**
- New chunks generated per minute (average): 36 /min (usually 0)
- Highest rate: 880 /min
- Longest single tick (server frozen): 9 s
- Freezes of 1 second or more: 1
- Lowest TPS: 15.6 (usually 20)
- Players online: 0
- Chart: chunk_gen_per_min

**What to do:**

1. Find what loads the chunks: run `/forceload query` in each world (for example `/execute in minecraft:overworld run forceload query`) and remove areas you don't need with `/forceload remove <x> <z>` or `/forceload remove all`.
2. Check whether a pre-generation tool (Chunky, a map renderer) was running during this time; schedule it for hours when the server isn't needed, or pause it while people play.
3. Look for plugins that load chunks far away (random teleport, map or world-border plugins): limit their range or let them only use land that already exists.
4. Install the Chunky plugin (from Hangar or Modrinth) and restart, if you don't have it yet.
5. Pre-generate the area that gets loaded, at a quiet time: `/chunky world world`, `/chunky center <x> <z>` with your spawn coordinates (or the middle of where people play), `/chunky radius 3000`, then `/chunky start`. On a Raspberry Pi this can take many hours; `/chunky pause` and `/chunky continue` let you split it up.
6. Set a world border around the same centre so no new chunks get created during play: `/worldborder center <x> <z>` (the same coordinates), then `/worldborder set 6000` (that is twice the radius).

### D. Small heap: server check during the run (-Xms512M -Xmx768M)

#### The server gets very little memory on a machine that has plenty
*jvm-flags · low · key `xmx-too-small`*

Java may use at most 768 MB for the server, while the machine has 7.9 GB of RAM. A Paper server with players, mobs and loaded chunks usually needs 2–4 GB; with less, Java has to clean up memory constantly and the server stalls under load.

**Evidence:**
- Maximum heap (-Xmx): 768 MB
- Starting heap (-Xms): 512 MB
- Machine memory (RAM): 7.9 GB
- Suggested heap: 4 GB
- Chart: heap_used_bytes

**What to do:**

1. Open your start script (for example `start.sh`), the `ExecStart=` line of your systemd service (for example `/etc/systemd/system/minecraft.service`), or the memory / JVM arguments field of your hosting panel.
2. Change `-Xmx768M` and `-Xms512M` to `-Xms4G -Xmx4G`.
3. Restart the server.

### E. Hopper build, no lag (session 2a, 17:47–17:59)

#### Early warning: a very large hopper build is costing tick time
*tile-entity-hotspot · low · key `world:hopper`*

About 1,280 hoppers sit in a single chunk in the world `world` around X 3,032, Z 3,032, and 5 chunks there have 500 or more (about 3,841 together; the world has 5,120 hoppers in total). The server doesn't lag yet, but since they appeared each tick takes about 4.2 ms longer (4.3 ms instead of 0.1 ms). With more players or more builds like this, that adds up to lag.

**Evidence:**
- Hoppers in the busiest chunk (estimated): 1,280
- Chunks with 500 or more hoppers: 5
- Hoppers in those chunks together (estimated): 3,841
- All hoppers in "world": 5,120
- Average tick time: 4.3 ms (usually 0.1)
- Chunks for /tp: world (189, 189) · world (190, 189) · world (188, 189) · world (189, 188) · world (189, 190)
- Chart: mspt_avg

**What to do:**

1. Go to the chunk: use the /tp button next to it, or `/tp @s 3032 ~ 3032`.
2. Replace long hopper chains with water streams or ice item elevators where possible, and remove hoppers that no longer do anything.
3. In `paper-world-defaults.yml` set `hopper.ignore-occluding-blocks: true`: hoppers under a solid block then skip looking for items above them.
4. Optional, with care: in `spigot.yml` set `world-settings.default.ticks-per.hopper-check: 8` (instead of 1) so hoppers look for items less often. This can break redstone that depends on exact hopper timing (some item sorters, clocks and counters), so test your farms afterwards and go back to 1 if something misbehaves.
5. If no plugin needs it (some protection and logging plugins do), set `hopper.disable-move-event: true` in `paper-world-defaults.yml`.
6. Restart the server after changing the config files.

*(Plus the same JVM tuning tip as in F.)*

### F. Idle Pi before the switch (-Xms1G -Xmx3G): the only finding, also shown during every other run

#### Tuning tip: starting memory and maximum memory are different
*jvm-flags · info · key `xms-ne-xmx`*

The server starts with 1 GB of heap (-Xms) and may grow to 3 GB (-Xmx). This is not why a server lags, but setting both to the same value is the recommended setup for Paper: Java then doesn't have to grow and shrink the heap, which avoids a few small extra pauses, and the memory is reserved up front.

**Evidence:**
- Starting heap (-Xms): 1 GB
- Maximum heap (-Xmx): 3 GB
- Machine memory (RAM): 7.9 GB
- Chart: heap_used_bytes

**What to do:**

1. Open your start script (for example `start.sh`), the `ExecStart=` line of your systemd service (for example `/etc/systemd/system/minecraft.service`), or the memory / JVM arguments field of your hosting panel.
2. Change `-Xms1G` to `-Xms3G` so it matches `-Xmx3G`.
3. Optional: if the server needs more memory, this machine has comfortable room for `-Xms4G -Xmx4G`.
4. Restart the server. This finding clears by itself once the new values are reported.

### G. After the switch to -Xms4G -Xmx4G (idle, 19:30): **no findings**


## Design decisions worth knowing
1. **Rules never touch the database.** The engine collects the data (recent samples, 7 days of history, events, snapshot, baseline) into one object and passes it to each rule. That is what made it possible to record the real Pi runs and replay them as tests.
2. **Incidents also open on low TPS.** MSPT p95 alone misses freezes, because a 20-second stall is just one tick. TPS < 18 must last 90 s, so one short hiccup (a world save, a single GC pause) doesn't count as an incident.
3. **Baselines are "this server when healthy"**: up to 24 h of healthy minutes from the last 7 days. With less than 30 healthy minutes, rules only use absolute limits, never "compared with usual".
4. **One finding per problem.** If the same problem appears in a new incident, the finding is updated instead of duplicated. Its evidence shows the **latest** occurrence (so the entity finding now shows the small-heap run's numbers; the entity-spam run's numbers are below).
5. **The detector stays cheap and safe**: about 11 ms per push. Store and detect run under one lock per server. Retries and replayed buffers are ignored. A plugin catching up after an outage never splits one incident into two, and data that arrives late is repaired by `incidents:backfill`.
6. **Severity**: incidents are medium/high/critical from peak p95 and lowest TPS. The two JVM tuning tips (Xms ≠ Xmx, missing Aikar flags) are **info**: they are true, but they don't cause lag. **Your call:** keep them as info tips, or hide them unless there's also lag or GC pressure.

## Review and QA
- **Reviewer** (Opus): 2 HIGH, 6 MEDIUM, 8 LOW. All HIGH and MEDIUM are fixed, and all LOW except one (L7, open findings kept forever, noted for later).
  - H1 was important: in the natural order (change heap, restart, then mark fixed), the JVM finding could never have reached "fixed by owner", because the plugin only sends its config at startup. Fixed: the config-rule recheck now waits for a config report newer than the last time the problem was seen.
  - H2: a plugin catching up after an outage would have had its incident split in two. Fixed.
  - The MEDIUMs covered concurrency (one lock per server), one finding across both scopes, the TPS trigger length, and the context-loading cost.
- **QA** (Sonnet): API 339 tests, Playwright 92 passed (18 skipped by design, API-only tests on mobile), plugin build, typecheck, lint: all green. All 11 scenario checks against the real Pi data pass, and the privacy check is clean. No product bugs. The text issues it found are fixed (chunk generation with nobody online, zero baselines, consistent hopper numbers). New `e2e/tests/incident-windows.spec.ts`.

## For you
1. **Owner path of the heap test.** It resolved by itself (`resolvedBy: auto`, 24 min after the 4G/4G restart), not through "mark fixed": pi-ops hit a usage limit right before that step. The owner path, in both orders (mark first or restart first), is covered by automated tests. If you want it seen live, it's a 30-min Pi session.
2. **Two usage-limit stops** (~16:00–17:30 and ~19:50–22:30) paused all agents. The Pi was left running idle during the second one (heap 4G/4G, 48 °C, no load) until 21:33.
3. **A user account `agent` on the Pi** (uid 1001) existed before our work. It was created 15 Oct by something called "pi-agent-setup". It can only start, stop, restart and check the status of `minecraft.service` via sudo, and it has read access to the server files (ACL). We didn't create it or change it. Is it yours (another project)?
4. **A damaged chunk** near spawn at chunk (3, 13) in `world` ("incorrect data check" when loading it, probably from an earlier hard stop). It's harmless for a test server. The backup from this morning has the old world if you ever want it back.
5. Leftovers on the Pi: world spawn accidentally moved to 0, 80, 0 in session 1, and ~30 MB of generated test chunks far from spawn (x 3000 and x 8000–9150). Say if you want them removed. The comment in `heap.conf` still describes the old 1G/3G setting (the flags themselves are 4G/4G).
6. **Plans**: which rules are "basic" on the Free plan isn't defined yet. All plans currently get all rules (Phase 5/8).

## How to look at it
```sh
cd ~/src/tickdoctor && docker compose up -d
set -a; . ./.env; set +a
docker compose exec -T api node dist/cli.js incident:list $PI_SERVER_ID
docker compose exec -T api node dist/cli.js finding:list $PI_SERVER_ID
docker compose exec -T api node dist/cli.js finding:show <finding-id>
pnpm seed   # demo data: 4 incidents + findings
```

## Next: Phase 5 (app foundation)
I write the app API contract. backend-dev builds auth (email, magic link, Discord), servers, API keys, metrics and live SSE. web-dev builds the auth pages, `/app`, onboarding and the server dashboard, in parallel.
