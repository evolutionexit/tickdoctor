---
title: Tile-entity hotspot
description: What it means when TickDoctor finds hundreds of hoppers, furnaces or similar blocks packed into one chunk, when it fires, and how to ease the load.
---

# Tile-entity hotspot

**Typical titles:** "Too many hoppers packed into one chunk", "Early warning: a very large hopper build is slowing the server a little".

## What it means

Most blocks cost the server nothing. A few, called block entities (or tile entities), do work every tick: hoppers, furnaces and their relatives, brewing stands, beacons, spawners, sculk sensors, pistons, and so on. A hopper checks for items above it and tries to move items several times per second. A few dozen are fine. A few hundred in one chunk are a well-known source of lag on Paper.

Chests, barrels and signs don't tick on the server, so a storage room with 500 chests is fine and never triggers this finding.

## What we look at

- The incident's snapshot: block-entity counts by type and the busiest chunks.
- The regular samples: the worst chunks, with block-entity totals. When the samples have no per-type detail, we estimate the hoppers in a chunk from that world's overall mix, and say so ("estimated").
- Your usual numbers, when there are any.

## When it fires

**During an incident:**

- 100 or more hoppers in one chunk, or 300 or more ticking block entities of any kind in one chunk. 300 hoppers or 600 ticking block entities make it high severity, otherwise it's medium.
- A world-wide surge: a ticking type at least double its usual count, and 300 more.
- Without any type information, only chunks with 800 or more block entities count, because the total may be mostly chests.

**As an early warning, without an incident:** it fires with **low** severity only for an extreme concentration (500 or more hoppers, or 1,000 or more ticking block entities, in one chunk, in at least half of the last 5 minutes) **and** when the cost is measurable (the average tick is at least 2 ms above usual, or at least 5 % of the 50 ms budget when there is no history). A normal server with a few hopper farms stays silent.

## How to fix it

1. **Go to the chunk** with the `/tp` button or the command shown.
2. **Simplify the build.** Replace long hopper chains with water streams or ice item elevators where you can, and remove hoppers that no longer do anything. Check whether all those furnaces or spawners are needed, switch off the idle ones, and spread large arrays over several chunks.
3. **Optional settings** (they need a restart; test your farms afterwards):
   - `hopper.ignore-occluding-blocks: true` in `paper-world-defaults.yml`: a hopper that points into a solid block no longer checks for a minecart hidden inside it. Only builds that feed a minecart buried in a block notice.
   - With care: `world-settings.default.ticks-per.hopper-check: 8` in `spigot.yml` (the default is 1) makes hoppers look for items less often. This can break redstone that depends on exact hopper timing (some item sorters, clocks and counters). Go back to 1 if something misbehaves.
   - `hopper.disable-move-event: true` in `paper-world-defaults.yml`, only if no plugin needs it (some protection and logging plugins do).

## After you fix it

Mark it as fixed when the build is lighter. Incident findings are watched for **72 hours**. The early warning is a server-state finding, so it is watched for **15 minutes** and can also clear by itself once the condition has stayed away. Config changes need a restart first.
