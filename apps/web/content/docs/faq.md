---
title: FAQ
description: Answers about supported servers, performance cost, privacy, plans, and how TickDoctor compares with spark, Plan and ServerAnalytics.
---

# FAQ

## Will it slow my server down?

It is built not to. The plugin does almost everything off the main thread. The few things the Bukkit API only allows on the main thread (counting entities and chunks) are done in tiny slices, with a budget of about 0.2 ms per tick. The plugin also measures its own cost and shows it in `/tickdoctor status`, so you can check instead of trusting us.

On an idle Raspberry Pi 5 running Paper 26.2 we measured about 0.024 ms per tick on average, which is 0.05 % of the 50 ms tick budget. A busy server with many chunks and entities will cost more. The numbers in `/tickdoctor status` are the ones that count for you.

## Which servers does it support?

Paper 26.2 or newer (the 26.x line) on Java 25. Spigot, CraftBukkit, Folia, Velocity and BungeeCord are not supported. Paper forks such as Purpur or Pufferfish are untested. See [Install](/docs/install#requirements).

## What does it collect? What about my players' privacy?

Performance numbers, your plugin list and versions, server settings and host health. It never sends IP addresses, chat, commands or world files. It sends no player identifiers at all, only how many players are online and ping values. The full list is in [Data and privacy](/docs/data-and-privacy).

## Can I turn off player identifiers completely?

You don't need to. The plugin sends no player identifiers in any setting. The `privacy-mode` option still exists, but `hashed` and `none` behave the same today. See [Configuration](/docs/configuration).

## How long do you keep my data?

It depends on the plan, from 1 day of detailed samples and 7 days of history on Free to 7 days and one year on Network. The table is in [Data and privacy](/docs/data-and-privacy#how-long-we-keep-it).

## Where is the data stored?

TODO (Michel): answer with the real hosting country and provider once decided. Do not publish this page before this is filled in.

## Can I delete everything?

You can delete a server and its data from its settings. Account deletion and a download of your data are coming in the app; until then, write to us and we do it by hand. See [Data and privacy](/docs/data-and-privacy#deleting-your-data).

## Is it free?

During the beta, Pro is free for everyone and nothing can be bought yet. Afterwards there will be a free plan for one server. Free shows that something is wrong and how serious it is; Pro adds why it happens, the evidence, the fix, what changed and the worst chunks' coordinates. Tuning tips are always free.

The plans and limits are on the [pricing page](/pricing).

## Do I need spark?

No, but they work well together. spark ships with Paper and is an excellent profiler: it shows exactly which code is slow at the moment you run it. TickDoctor watches all the time and tells you what changed, then points you to a likely cause and a fix. When TickDoctor says "something is slow but we can't name it", that's the time to run spark.

## How is TickDoctor different from spark, Plan and ServerAnalytics?

These tools solve different problems, and several of them are free.

- **spark** is a profiler, bundled with Paper. It shows which code takes the time, right now, in detail. It can't tell you what happened last night, and its reports are written for people who can read stack traces.
- **Plan** is a self-hosted web panel focused on players: joins, playtime, activity, with performance graphs on the side.
- **ServerAnalytics** is a free, hosted dashboard with TPS, MSPT, memory, entity and chunk counts, a health score, player stats, alerts and a public status page. Its focus is monitoring and alerting.
- **TickDoctor** focuses on diagnosis over time: a snapshot at the moment of lag, a comparison with your server's healthy baseline ("what changed?"), the worst chunks with coordinates, plain-language findings with fixes, and host health (CPU temperature, throttling, swap, disk) that matters on small machines.

Use spark to dig into code, Plan to understand players, and TickDoctor to find out why the server lagged last night and what to do first. These descriptions come from the tools' public pages and may be out of date. If something here is wrong, tell us. TODO: re-check before launch.

## Can I self-host TickDoctor?

Not at the moment. It is a hosted service.

## What is an incident?

A stretch of time when your server lagged. TickDoctor opens one when the slowest 5 % of ticks stay above 50 ms for 30 seconds, or when TPS stays under 18 for 90 seconds (this second rule catches short, heavy freezes such as world generation). It closes the incident once things have been normal for two minutes, or when the server stops sending data. Each incident has a severity (medium, high or critical), a snapshot, a "what changed?" comparison and the findings that apply.

## Do the findings guess?

They say "probably" when they are guessing, and they show the numbers behind them. A finding never claims more than the data supports. When TickDoctor can't find a clear cause it says so instead of inventing one. Read about each one in the [findings reference](/docs/findings).

## What are tuning tips?

Findings marked as tips (for example "starting memory and maximum memory are different") are suggestions that may help a little. They aren't why your server lags. They live in their own section and **never** trigger alerts, appear as incident causes, or show up as a server's top finding.

## What does "Mark as fixed" do?

It tells TickDoctor you changed something. We then watch whether the problem comes back: for 15 minutes for findings about the server's current state, and for 72 hours for findings about a specific incident. If it stays away, the finding becomes "confirmed fixed". If it comes back, it is reopened. For settings such as memory, restart the server first. More in the [findings reference](/docs/findings#what-mark-as-fixed-does).

## Why do I need to restart instead of using /reload?

Paper doesn't support `/reload`, and it can leave plugins in a broken state. A restart is the safe way. The plugin's own `/tickdoctor reload` is fine after changing its config.

## Does it work on Windows or macOS?

The plugin runs, and the Minecraft numbers (tick times, entities, chunks, memory) work everywhere. CPU temperature, throttling, swap and disk throughput are read from Linux, so those graphs are empty elsewhere.

## Does it need open ports on my server?

No. The plugin only makes outgoing HTTPS requests.

## Not an official product?

Right. TickDoctor is not an official Minecraft product. It is not approved by or associated with Mojang or Microsoft.
