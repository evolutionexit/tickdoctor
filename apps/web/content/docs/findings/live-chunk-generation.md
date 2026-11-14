---
title: Live chunk generation
description: What it means when the server lags while new land is being created, how TickDoctor spots it, and how to pre-generate the world or stop what loads chunks.
---

# Live chunk generation

**Typical title:** "Lag while new land is being generated".

## What it means

Creating new terrain is heavy work for the CPU, and the server waits until it's done. When players explore land nobody has visited before, or something loads far-away land, the server stalls: single ticks can take seconds, and TPS drops even though most ticks look fine. It's a very common cause of lag on small servers.

## What we look at

The number of new chunks generated per minute (average over the incident, because it arrives in bursts), the longest single tick, TPS, which worlds generate, and whether any players were online.

## When it fires

Only during an incident, and only when it coincides with the trouble:

- the average rate is at least 20 new chunks per minute on a Raspberry Pi class board, 40 on a small machine, 60 on a larger one, **and** at least three times what your server usually generates,
- generation shows up in at least 2 samples,
- and either a freeze (a tick of 3 seconds or more) happens in or next to a sample with generation, or the rate is high during the lag samples themselves.

A walking player makes roughly 10 to 20 chunks a minute, someone flying with an elytra 100 or more.

The severity is high at a very high rate (80, 150 or 250 per minute depending on hardware), freezes of 3 seconds or more, or TPS below 15, otherwise medium.

**If nobody was online** during the lag, the finding says so. Players can't have explored, so something on the server loaded the land itself: a `/forceload` area, a pre-generation tool (like Chunky) running at the wrong time, or a plugin that loads far-away land (random teleport, map or world-border plugins).

## How to fix it

**If players were exploring:**

1. Rule out the server itself: run `/forceload query` in each world (for example `/execute in minecraft:overworld run forceload query`), remove areas you don't need with `/forceload remove <x> <z>` or `/forceload remove all`, and check for plugins that load far-away land.
2. Install the **Chunky** plugin (from Hangar or Modrinth) and restart.
3. Pre-generate the land at a quiet time, in the area where players explore: `/chunky world <world>`, `/chunky center <x> <z>`, `/chunky radius 3000`, then `/chunky start`. `/chunky pause` and `/chunky continue` let you split it up. On a Raspberry Pi it can take many hours.
4. Do the same for the Nether if players travel there a lot (`/chunky world world_nether`, with about an eighth of the radius).
5. Optional, and only if nobody has built outside it: set a world border around the same centre (`/worldborder center <x> <z>`, then `/worldborder set 6000`, twice the radius). First check that the spawn and everyone's bases lie inside it.

**If nobody was online:** start with the force-load check above, then check whether Chunky or a map renderer was running during the lag (schedule it for hours when the server isn't needed, or pause it while people play), and look at plugins that load chunks far away (limit their range). Only if none of that explains it, pre-generate as above.

## After you fix it

This is an incident finding, so we watch for **72 hours** after you mark it as fixed. Pre-generating takes time, so mark it once the land is generated and the border (if any) is set.
