---
title: Swap in use
description: What it means when the machine runs low on memory and moves some of it to swap, how TickDoctor tells real pressure from harmless swap, and how to fix it.
---

# Swap in use

**Typical title:** "The machine is low on memory and moving some of it to swap".

## What it means

Swap is overflow space for when RAM is full, usually on the disk or SD card. (On Raspberry Pi OS it is often compressed memory instead, called zram.) It is far slower than RAM, so whenever the server needs something that was moved there, it has to wait, which shows up as lag spikes and slow garbage collection.

## What we look at

Swap in use, how much memory is still available, the machine's RAM, the Java memory limit, and whether swap grows during the period.

## When it fires

On a server pass and during incidents. A little swap is normal: Linux parks memory nobody uses and leaves it there, so swap alone is **not** a finding. It fires only when **both** of these hold:

- swap use is meaningful: at least 256 MB, and at least 5 % of the swap space, **and**
- the machine is actually under pressure: the memory still available is below 10 % of RAM or below 512 MB, whichever is larger, **or** swap grew by at least 256 MB during the period (needs at least 10 minutes of data).

The severity is high when the server is lagging, otherwise medium.

## How to fix it

1. See what uses the memory: run `free -h` and `top` (press `Shift+M` to sort by memory).
2. If Java's memory limit is too large for the machine, set `-Xms` and `-Xmx` to the size the finding suggests and restart. Otherwise don't raise `-Xmx` further: that limit plus about 1 GB for Java itself must fit in RAM next to everything else.
3. Stop programs you don't need on the machine (other servers, databases, a desktop session).
4. Check what kind of swap it is: `swapon --show`.
   - **`/dev/zram0`:** compressed memory, normal on Raspberry Pi OS. Leave `vm.swappiness` alone and use the steps above.
   - **A swap file or a partition on a disk or SD card:** `sudo sysctl vm.swappiness=10` makes Linux prefer RAM. Add `vm.swappiness=10` to `/etc/sysctl.conf` to keep it after a reboot.
5. If it keeps swapping after that, the machine needs more RAM.

## After you fix it

This is a server-state finding. Mark it as fixed once memory is under control and we watch for **15 minutes**. If you changed the Java memory flags, restart first.
