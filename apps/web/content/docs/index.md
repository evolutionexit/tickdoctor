---
title: Documentation
description: How to install the TickDoctor plugin, what it measures, how your data is handled, and how to read and fix every finding.
---

# TickDoctor documentation

TickDoctor explains **why** your Minecraft server lags, not only that it does. A small plugin sends tick, memory, entity, chunk and host numbers to the TickDoctor app. When the server falls behind, the app opens an incident, saves a snapshot of that moment, compares it with how your server looks when it is healthy, and writes a plain-language finding with a suggested fix.

## Start here

1. [Install the plugin](/docs/install): five minutes, one jar and two lines of config.
2. [Configuration](/docs/configuration): every option in the plugin's `config.yml`, with defaults.
3. [Findings reference](/docs/findings): one page per finding, with what it means and how to fix it.

## Good to know

- [Data and privacy](/docs/data-and-privacy): exactly what the plugin sends, what it never sends, and how long we keep it.
- [Troubleshooting](/docs/troubleshooting): "nothing shows up", "invalid key", Discord alerts that don't arrive.
- [FAQ](/docs/faq): supported servers, performance cost, how we compare with spark, Plan and ServerAnalytics.
- [Changelog](/changelog): what changed and when.

## A few words used throughout

- **Tick**: the server's heartbeat. It does its work 20 times a second, so each tick has 50 ms.
- **TPS**: ticks per second. 20 is perfect; lower means the server is falling behind.
- **MSPT**: milliseconds per tick. Under 50 ms is fine; above 50 ms the server can't keep up.
- **Chunk**: a 16 × 16 block column of the world, the unit the server loads and updates.
- **Incident**: a stretch of time when your server lagged.
- **Finding**: what we think is wrong, with the evidence and what to do about it.

## What TickDoctor is not

It is not a profiler. [spark](https://spark.lucko.me/) (bundled with Paper) shows exactly which code is slow at the moment you run it, and it is excellent at that. TickDoctor watches continuously, so it can tell you what changed between a healthy hour and a laggy one. The two work well together. See the [FAQ](/docs/faq).

TickDoctor is not an official Minecraft product. It is not approved by or associated with Mojang or Microsoft.
