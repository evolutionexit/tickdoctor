---
title: JVM flags
description: What TickDoctor checks in your Java start settings, including memory size, Xms and Xmx, and Aikar's flags, and which of those are tuning tips that never alert.
---

# JVM flags

JVM flags are the options after `java` in your start script, systemd service or hosting panel. They decide how much memory the server gets and how Java cleans it up. TickDoctor reads them from the plugin's hello at startup and checks a handful of common problems. This is configuration, so it doesn't need an incident, and each problem is its own finding, so fixing one clears exactly that one.

## The checks

| What | Title | Severity |
|---|---|---|
| `-Xmx` too large for the machine | "Java's memory limit leaves too little for the rest of the machine" or "Java may use more memory than the machine has" | medium, high if `-Xmx` is at least the RAM |
| No `-Xmx` set | "The server's memory limit isn't set, so Java picks one" | low |
| `-Xmx` very small on a machine with plenty of RAM | "The server gets very little memory on a machine that has plenty" | low |
| `-Xms` different from `-Xmx` | "Tuning tip: starting memory and maximum memory are different" | tuning tip |
| Slow collector (`-XX:+UseSerialGC` or `-XX:+UseParallelGC`) | "The server is set to a memory clean-up mode that freezes it for long stretches" | low |
| No garbage-collection tuning at all | "Tuning tip: your server doesn't use the Java settings Paper recommends" | tuning tip |

**Tuning tips never alert.** They are suggestions, not the reason your server lags. They appear only in the "Tuning tips" section, never as an incident's cause, never in a Discord alert, and never as a server's top finding.

## What each one means and when it fires

**Memory limit too large (`xmx-too-large-for-ram`).** Java needs memory on top of the heap (about 0.5 to 1 GB) and so does the operating system. It fires when `-Xmx` is larger than the RAM minus a reserve (12 % of RAM, at least 1.25 GB, at most 3 GB). When the machine runs out, it moves memory to swap (slow) or, without swap, Linux may shut the server down. Fix: set `-Xms` and `-Xmx` to the suggested size, equal to each other, and restart.

**No `-Xmx` (`xmx-missing`).** Java picks a quarter of the RAM by itself and grows into it step by step. Setting it yourself keeps memory predictable. Fix: add `-Xms<size> -Xmx<size>` right after `java`.

**Very small heap (`xmx-too-small`).** Fires when `-Xmx` is under 1 GB on a machine with at least 4 GB of RAM. Paper with a few players usually needs 2 to 4 GB. Owners of genuinely small machines (1 to 2 GB) never see this.

**`-Xms` different from `-Xmx` (`xms-ne-xmx`, tuning tip).** Paper recommends the same value for both, so Java doesn't grow and shrink its memory, which avoids a few small pauses. It is only checked when the difference is more than 2 %.

**Slow collector (`slow-gc-collector`).** The serial and parallel collectors freeze the whole server for long stretches on a game server's heap. Fix: remove the flag and use the G1 flags that [Paper's guide](https://docs.papermc.io/paper/aikars-flags) generates for your memory size.

**No GC tuning (`aikar-flags-missing`, tuning tip).** The server uses Java's defaults, which are meant for general programs. "Aikar's flags" are a set of options the Paper community tested to keep clean-up freezes short. We only suggest them when there is **no** tuning at all. If you already picked some flags, or use ZGC or Shenandoah on purpose, we don't second-guess you.

## How to fix it

1. Open your start script (for example `start.sh`), the `ExecStart=` line of your systemd service (for example `/etc/systemd/system/minecraft.service`), or the memory or JVM arguments field of your hosting panel.
2. Make the change the finding shows.
3. **Restart the server.** JVM flags only take effect on a restart.

## After you fix it

These are settings findings. **Restart first, then mark the finding as fixed.** The plugin sends a fresh report of your flags when the server starts. Once it has arrived, and the problem is gone, the finding becomes confirmed fixed, and it clears by itself too. A finding that is still marked fixed is watched for **15 minutes**. If you mark it before restarting, it stays "watching" until the restarted server reports its new values.
