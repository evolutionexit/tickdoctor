---
title: Thermal throttling
description: What it means when the CPU overheats or the power supply is too weak and the processor slows down, how TickDoctor detects it, and how to fix it on a Pi or PC.
---

# Thermal throttling

**Typical titles:** "The CPU is overheating and slowing itself down", "The power supply is probably too weak, so the CPU slows down".

## What it means

When a processor gets too hot, it lowers its own speed to cool off. A slower CPU needs longer for every tick, so the server lags even though nothing in the game changed. On a Raspberry Pi the board also slows down when the power supply can't deliver enough current (under-voltage), which can additionally corrupt the SD card or SSD.

This is one of the host problems that Minecraft tools don't show.

## What we look at

- On a Raspberry Pi, the throttling flag from the firmware (`vcgencmd get_throttled`). Only the state **right now** counts. "Throttled at some point since boot" is history and is ignored.
- The CPU temperature, on any machine that reports it.

## When it fires

On a server pass and during incidents. There are two separate findings:

- **Overheating.** Either the median temperature over at least 5 minutes is at or above the limit (80 °C for Raspberry Pi and similar boards, 95 °C for other machines, because desktop and server CPUs run safely much hotter), or throttling is active in at least 20 % of the samples (and at least 3 of them). Severity is high when the server is lagging, otherwise medium.
- **Under-voltage** (Raspberry Pi only). The board reports too little power in at least 20 % of the samples. If the CPU is cool and under-voltage is reported, it is treated as a power problem, not heat.

Without the `video` group on a Pi, the throttling flag isn't available and the temperature alone is used. See [Configuration](/docs/configuration#extra-for-raspberry-pi).

## How to fix it

**Raspberry Pi:**

1. Check the cooling. On a Pi 5 use the official Active Cooler (or a case with a fan) and make sure the fan actually spins.
2. Give it air: not in a closed cupboard or a case without vents, away from direct sun and other warm devices.
3. Check over SSH: `vcgencmd measure_temp` should stay well below 80 °C under load, and `vcgencmd get_throttled` should print `throttled=0x0` after a reboot.
4. If you overclocked it, remove the `arm_freq` and `over_voltage` lines from `/boot/firmware/config.txt` and reboot.
5. Until it's fixed, lower `simulation-distance` in `server.properties` by 1 or 2.

**Other machines:** clean the fans and heatsinks, make sure the fans run and the machine has free airflow, and ask your host whether the machine is overheating if it's rented. Lower `simulation-distance` meanwhile.

**Under-voltage:** use the official power supply for your board (a Pi 5 needs the 27 W USB-C supply, 5.1 V at 5 A) with its own cable, not a phone charger. Don't power an SSD from the Pi's USB ports without enough power; use a powered hub. After a reboot `vcgencmd get_throttled` should print `throttled=0x0`.

## After you fix it

This is a server-state finding. Mark it as fixed once the cooling or power is sorted, and we watch for **15 minutes**. Hot weather can bring it back, in which case it reopens.
