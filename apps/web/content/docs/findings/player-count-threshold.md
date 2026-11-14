---
title: Player-count threshold
description: What it means when your server starts lagging above a certain number of players, how TickDoctor works out that number, and what to do about it.
---

# Player-count threshold

**Typical title:** "The server starts lagging above about 11 players".

## What it means

Your server has a capacity. Every extra player means more chunks, mobs and redstone to update, and at some number your machine can't finish all of it in time. TickDoctor found that number from the last week of data.

## What we look at

The last 7 days, minute by minute: how many players were online, and whether the server clearly lagged in that minute (slowest ticks 60 ms or more, or an average tick of 45 ms or more). Ticks that rise gently with players but stay below that line mean a busy, healthy server, not a problem.

## When it fires

Only during an incident that happened at or above the threshold number, and only when the pattern is solid:

- N is the lowest player count from which **every** count (with at least 5 minutes of data) lags in at least half of its minutes,
- at N players or more, at least 60 % of the minutes lag, below N at most 5 % do,
- it shows in at least two separate sessions at least 12 hours apart, so one bad evening isn't called capacity,
- there are at least 30 minutes of data above N and 60 below,
- and if the server handled that many players fine before a plugin or settings change, it stays quiet. That is a change problem, which the [plugin change](/docs/findings/plugin-change-before-lag) finding covers.

The severity is high when the slowest ticks above N are 100 ms or more, otherwise medium.

## How to fix it

1. **Check the other findings for the incident first.** They may show which part of the load grows with players, such as an entity farm or chunk generation.
2. **Lower `simulation-distance`** in `server.properties` (the finding shows your current value and a suggestion). It cuts the work per player the most, and players still see as far as before. If it is already low, lower `view-distance` by 1 or 2.
3. **Cap the players** with `max-players` in `server.properties` as a stop-gap, until you move to faster hardware.
4. **Optional settings** (they need a restart):
   - `entities.spawning.per-player-mob-spawns: true` in `paper-world-defaults.yml`, and a lower `entities.spawning.spawn-limits.monster`, for example `50` (the default `-1` uses `bukkit.yml`, normally 70).
   - Lower `entity-activation-range` in `spigot.yml` (the default is 32; for example animals 16, monsters 24).
5. Restart the server after changing these files.

## After you fix it

Mark it as fixed after a restart. This is an incident finding, so we watch for **72 hours**. A real fix needs a busy evening to prove itself, so don't be surprised if it takes a few days to be confirmed.
