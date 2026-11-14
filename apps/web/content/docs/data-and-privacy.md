---
title: Data and privacy
description: Exactly what the TickDoctor plugin sends, what it never sends, how long data is kept for each plan, and how to export or delete it.
---

# Data and privacy

Short version: the plugin sends **performance numbers and server settings**. It never sends IP addresses, chat, commands or world files, and no player identifiers at all: only how many players are online, and ping values with no name or id attached.

The legal text is in the [privacy policy](/legal/privacy). This page explains the same thing in plain words and goes into the technical detail.

> TODO (Michel): where the data is stored (country, hosting provider) isn't decided yet. This page must name it before launch.

## What the plugin sends

**When it starts, and again when your plugin list changes (a "hello"):**

- Server software and version, Minecraft version, online mode, max players.
- Java version and vendor, the JVM start flags, heap size, number of CPUs, operating system and architecture, device model (for example "Raspberry Pi 5"), total RAM.
- View distance, simulation distance, entity activation range, and a short allow-list of Paper settings.
- World names.
- Your plugin list with versions.
- Your privacy mode.

Before sending, the plugin filters the JVM flags. Standard options (`-Xms`, `-Xmx`, `-XX:…`, `-Xlog…`) and a couple of Aikar's-flags markers are sent with their values. Every other `-Dname=value` is sent as `-Dname=***`, because those are where passwords and tokens usually hide. Flags that load agents, classpaths or jars, and any flag containing a home folder, are not sent at all. Options that point at commands or files (for example `-XX:OnError=` or `-XX:HeapDumpPath=`) are sent without their value, and log options (`-Xlog`) never include the file path. IP addresses and logins inside URLs are removed.

**Every 10 seconds (a "metrics" sample):**

- Tick numbers: TPS, MSPT (average, p95, p99, worst), ticks over 50 ms.
- Memory: Java heap used, committed and maximum, garbage-collection pauses, thread count, the server process's CPU use.
- Per world: loaded chunks, entity count, entity counts by type (top 20), block-entity counts by type (hoppers, furnaces, chests, …), chunks newly generated per minute.
- The 10 busiest chunks: world, chunk coordinates, number of entities and block entities, and the most common entity type.
- Player count, and each online player's ping as a bare number (no name, no id).
- Host numbers when your system provides them (mostly Linux): CPU load and use, CPU temperature, throttling state (Raspberry Pi), RAM, swap, disk size and use, disk and network throughput. Anything unavailable is left out.
- The plugin's own overhead.

**As they happen (events):** server start, stop and crash, a player joined or left (only the new player count), "can't keep up" warnings from the server log, plugin changes, and errors (exceptions) with the plugin they most likely came from, the error type, the first few lines of the stack trace, and a count.

**During lag (a snapshot):** a full count of entities and block entities by type per world, the 50 busiest chunks per world, the busiest threads, and the last five minutes of events.

## What the plugin never sends

- **IP addresses.** Not in any privacy mode, not in any message.
- **Player names, Minecraft UUIDs or any other player identifier.** Not even hashed ones. This is the same in both privacy modes.
- **Chat messages, commands, or the console.** The plugin watches the server log only to detect "can't keep up" warnings and errors with a stack trace. It doesn't send ordinary log lines.
- **World files, builds, inventories or player positions.** Only chunk-level counts and chunk coordinates of busy places are sent, so you can walk there.
- **Your API key's text in logs, or secrets from your JVM flags or config.**
- **Anything at all before you've put your key in.** With no key, the plugin stays idle.

## What we do on our side

- **Player data.** The plugin sends no player ids, so there are none to store. The app keeps the number of players and the average ping.
- **Error text is scrubbed twice.** In the plugin before sending, and again on our server before storing, error messages, crash details and stack frames lose IP addresses, UUIDs, `scheme://user:pass@` logins and `password`, `token`, `secret` or `key` values (`key: value` pairs). Home folder names are shortened (`/home/alex` becomes `/home/~`). Our server also replaces long hex strings and thread names that look like identifiers. The plugin also removes the names of players who are online. Names of players who are *offline* can't be recognised reliably, so an old error message could, in rare cases, still contain one. Exception messages can also contain file paths. If you find something that shouldn't be there, [contact us](#contact) and we'll remove it.
- **Wrong clocks.** Samples that claim to be more than 10 minutes in the future are dropped.
- **Your API key** is shown once. We store only a one-way hash and the first 12 characters (so you can recognise the key).

## What we store about you (your account)

- **Account:** your email address, an optional display name, a salted hash of your password (never the password itself), the time you gave consent, and your sign-up and last-use times.
- **Sessions:** a hashed session identifier, so you stay logged in (up to 30 days).
- **Discord:** only your Discord user id, and only if you choose to connect or sign in with Discord.
- **Servers:** the name you chose, a short web address for the status page if you create one, your plan, and the hashed API keys.
- **Alerts:** your Discord webhook address, stored encrypted and never shown in full again, plus a log of alerts sent or skipped (kept 30 days).
- **Status page:** only what you switch on. See below.
- **Waitlist:** your email address, the place you signed up from, and the time.

We use no analytics, no advertising trackers and no tracking cookies. See the [privacy policy](/legal/privacy) for the cookies the site does set (they only keep you signed in).

## Status pages

A status page is **off by default**. When you turn it on, anyone with the link can see only what you choose: the server's state (operational, degraded, lagging, offline), the player count, uptime, and the dates and length of recent incidents. It never shows player names, IP addresses, your plugin list, findings, your API key, or who you are. A page that is switched off looks exactly like a page that doesn't exist.

## How long we keep it

Retention depends on your plan. After these periods the data is deleted automatically.

| | Free | Pro | Network |
|---|---|---|---|
| Detailed samples (every 10 s) | 1 day | 3 days | 7 days |
| Per-minute averages | 3 days | 14 days | 30 days |
| Hourly averages | 7 days | 90 days | 365 days |
| Events, incidents and snapshots | 7 days | 90 days | 365 days |
| Findings for resolved incidents | 7 days | 90 days | 365 days |

Findings that are still open or marked as fixed are kept until they are resolved. The alert delivery log is kept 30 days on every plan. Pending accounts that never confirmed their email and have no servers are deleted after 7 days.

If a plan ends or is downgraded, your data stays for 14 days. After that, anything older than the Free plan's history is trimmed, and we email you before it happens so you can export first. <!-- TODO: grace period and warning email are not built yet (docs/go-public.md section 6). -->

**During the beta** every account gets Pro limits for free (the account page shows "Pro (beta)"). When the beta ends, accounts go back to Free unless upgraded, and history older than Free's limits (the first column) is trimmed. We will announce the date and email you in advance.

**What Free shows.** On Free, findings and incidents show what is wrong, how serious it is and when (title, severity, time). The explanation, evidence, suggested fix, "what changed?" and worst-chunk coordinates are Pro. Tuning tips are free. The locked content is never sent to your browser, but your data export always contains everything we hold, including it.

> TODO (Michel): beta end date, and the cleanup rule for old open findings.

## Export and deletion

You can do both yourself, in the app, under **Account**.

- **Export my data.** Downloads one JSON file with everything we hold about you: your account details, your servers with their history (metrics, incidents, findings, events, snapshots), alert settings, status page settings, API key prefixes, and your waitlist entry if there is one. It never contains your password hash, API key hashes, or your Discord webhook address (only a masked version). You can export a few times per hour.
- **Delete my account.** Removes your account and, in one step, all your servers and their data: history, incidents, findings, alerts and the alert log, status pages (their web addresses become free again), API keys, your Discord link, your login sessions, and any waitlist entry with your email. You confirm by typing your email address and your password. It is **immediate and final**: there is no grace period and we can't restore anything. We send one short email to confirm.
- **What deletion can't reach.** Alert messages already posted in your Discord channel stay in Discord. Backups: deleted accounts remain in encrypted backups for up to 14 days, then are gone. TODO (Michel) confirm this backup policy before launch.
- **A server and its data:** delete the server in its settings (you confirm by typing its name).
- **Rotate or revoke a key:** rotate the key in the server's settings. The old key stops working immediately.
- **Stop sending:** remove the plugin's jar, or clear `api-key` in the config and run `/tickdoctor reload`.

If you can't sign in, write to us and we will do it by hand within one month.

> TODO (Michel): decide who answers manual requests.

## Your rights

If you are in the EU or UK you can ask for access, correction, deletion, restriction and portability of your data, and object to its use. You can also complain to your data protection authority (in France, the CNIL). The [privacy policy](/legal/privacy) lists the details.

## Contact

Write to hello@tickdoctor.example. TODO (Michel): replace with the real address.
