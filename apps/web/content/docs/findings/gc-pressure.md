---
title: GC pressure
description: What it means when Java's memory limit is too small and clean-ups keep freezing the server, how TickDoctor detects it, and how to raise the limit safely.
---

# GC pressure

**Typical title:** "The server is running low on memory (Java's memory limit is too small)".

## What it means

Java gives the server a fixed amount of memory, its "heap". When the heap is nearly full, Java has to clean it up (garbage collection, "GC") again and again, and each clean-up briefly freezes the server. Players feel it as lag spikes and short stutters, often before a full incident.

## What we look at

- **How full the heap stays right after clean-ups.** A healthy Paper server sits at roughly 30 to 60 % after a clean-up. We take the floor of the sawtooth (the 20th percentile over the window).
- **How much of the time the server is frozen for clean-ups.** On a healthy server this is well under 1 %.
- The longest single pause, the number of full clean-ups (these stop everything), the heap limit, the machine's RAM and any swap in use.

## When it fires

On a server pass (every 5 minutes, over the last 30 minutes) and during incidents. It needs at least 10 minutes of data, and **both** must be true:

- even right after clean-ups, **75 % or more** of the heap stays in use, and
- clean-ups freeze the server for **2 % or more** of the time (about 200 ms every 10 seconds).

The severity is high when the freeze share is 5 % or more or the server is lagging, otherwise medium.

Whether the heap is too large for the machine is a different problem, reported by the [JVM flags](/docs/findings/jvm-flags) finding, so you don't get two findings for it.

## How to fix it

If the machine has room, the finding suggests a new limit: about 50 % more (at least 2 GB more), but only what the machine can give.

1. Open your start script (for example `start.sh`), the `ExecStart=` line of your systemd service, or your hosting panel's memory setting.
2. Raise `-Xmx` to the suggested value and set `-Xms` to the same value.
3. **Restart the server** and check back after an hour or two of normal play. If the finding is gone, mark it as fixed.
4. If memory fills up again after a while, something probably keeps growing (a plugin cache, many loaded chunks). Restart once a day and check plugins that store a lot of data.

If the machine has **no room** for more:

1. Reduce what the server keeps in memory: lower `view-distance` in `server.properties` (for example by 2) and remove plugins you don't need.
2. Restart once a day so memory starts clean.
3. If it is still full, the server needs a machine or plan with more RAM.

## After you fix it

This is a server-state finding, so after you restart and mark it as fixed we watch for **15 minutes** with fresh data. A memory change only counts after the restart, so don't mark it before restarting.
