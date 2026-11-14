---
title: Findings reference
description: What each TickDoctor finding means, what we look at, when it fires, how to fix it, and what Mark as fixed does. One page per finding.
---

# Findings reference

A finding is TickDoctor's note about what is wrong, written like a doctor's note: what's wrong, the evidence, and what to do. Every finding has a severity, the numbers behind it (with your server's usual value next to them when we have one), a graph, and a suggested fix.

On the Free plan you see each finding's title, severity and time; the explanation, evidence and suggested fix (everything described on these pages) are part of Pro. Tuning tips are free. During the beta every account has Pro.

We would rather say nothing than guess. A rule that fires on a healthy server is a bug, so each rule is tested against healthy data as well as against problem data. Where a finding is a best guess, its text says "probably".

## The findings

| Finding | In one line | Looks at |
|---|---|---|
| [Entity explosion](/docs/findings/entity-explosion) | Far too many mobs, items or minecarts, in one chunk or spread out. | During an incident |
| [Tile-entity hotspot](/docs/findings/tile-entity-hotspot) | Hundreds of hoppers, furnaces or similar blocks in one place. | During an incident, plus a mild early warning |
| [Plugin change before lag](/docs/findings/plugin-change-before-lag) | The server got slower after a plugin was added, updated or removed. | During an incident |
| [Player-count threshold](/docs/findings/player-count-threshold) | The server lags above a certain number of players. | During an incident, using the last week |
| [GC pressure](/docs/findings/gc-pressure) | Java's memory limit is too small, so clean-ups freeze the server. | Continuously and during incidents |
| [Thermal throttling](/docs/findings/thermal-throttling) | The CPU is overheating or underpowered and slows itself down. | Continuously and during incidents |
| [Swap in use](/docs/findings/swap-in-use) | The machine is out of memory and moving some to swap. | Continuously and during incidents |
| [View distance too high](/docs/findings/view-distance-too-high) | View or simulation distance is more than the hardware handles. | During an incident |
| [Live chunk generation](/docs/findings/live-chunk-generation) | Lag while new land is being created. | During an incident |
| [Plugin exceptions](/docs/findings/plugin-exceptions) | The same error repeats over and over in the log. | Continuously and during incidents |
| [JVM flags](/docs/findings/jvm-flags) | Java start settings that cost you memory or stability. | Whenever the server starts |

TODO (Michel): Free shows "basic" findings and Pro and Network show all. Which findings count as basic is not decided yet. Update this page once it is.

## Severity

- **Critical, high, medium, low:** how much attention a finding deserves. High and critical mean players are very likely feeling it.
- **Tuning tip:** a suggestion that may help a little but is **not** why the server lags. Tips live in their own "Tuning tips" section. They never count as the cause of an incident, never appear in alerts, and are never shown as a server's top finding.

## When rules run

- **Incident findings** are worked out when an incident opens (once its snapshot arrives, or after about 90 seconds) and again when it closes. They compare the lag with your server's healthy baseline.
- **Server findings** are checked every time the server starts and every 5 minutes, over the last 30 minutes. They don't need an incident, because the problem is visible all the time.

## What mark as fixed does

When you've changed something, press **Mark as fixed** on the finding. That doesn't hide it. It starts a watch:

- **Findings about the server's current state** (memory, temperature, swap, errors, Java flags): we watch for **15 minutes**.
- **Findings about a specific incident** (entities, hoppers, plugin change, player count, view distance, chunk generation): we watch for **72 hours**, because that kind of problem may only show itself again at the next busy evening.
- If the problem **doesn't come back** in that time, and the server kept sending data, the finding becomes **confirmed fixed**. Findings about the server's current state may also close by themselves once their condition has stayed away for 15 minutes.
- If it **does come back**, the finding is **reopened**, with a note.
- You can **undo** a mark while the finding is still marked fixed.
- **Settings that need a restart** (the Java memory flags, view and simulation distance): restart the server first, then mark it as fixed. We check again once the restarted server reports its new settings, so the plugin must be running and the server must have started after your change.

The check runs every 5 minutes, so confirmation can arrive a few minutes after the window ends.

## What each action means for you

- Findings show a numbered fix. Do the simple steps first.
- Steps under "Optional, for when the simple steps aren't enough" involve Paper or Spigot config files and need a restart.
- Before running `/kill` or editing config files, make a backup.
