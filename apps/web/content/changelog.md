---
title: Changelog
description: What changed in TickDoctor and when, in plain words. Newest first.
---

# Changelog

TickDoctor is in early access. Entries are newest first.

## 14 November 2026: plugin 0.1.6

- **Safer limits on what the plugin reports.** Very large or impossible numbers (for example a player count in the billions) are capped before sending, so one odd value can never make a batch fail.

## 14 November 2026: plugin 0.1.5

- **No player identifiers are sent at all.** Join and leave events carry only the number of players online, and ping samples carry only the values. The `privacy-mode` option is still accepted, but both settings now behave the same. The plugin no longer creates `salt.txt`; an old one is harmless and you can delete it.
- **Stricter filtering of Java start flags.** Standard options (`-Xmx`, `-XX:…` and similar) are sent as before. Every other `-Dname=value` is sent as `-Dname=***`. Flags that load agents, classpaths or jars, and flags containing a home folder, are not sent.
- **Stricter cleaning of error text.** IP addresses, UUIDs, logins inside URLs, `password`/`token`/`secret`/`key` values and home folder names are removed in the plugin, and again on our server.
- **Reliability fixes.** If the address of an `http://` API can't be looked up right now, the plugin keeps retrying instead of stopping. It shuts down cleanly, and its crash-detection heartbeat keeps running while the server is idle.
- **Quieter console.** Plugin log lines no longer start with a second "TickDoctor: ", for example `[TickDoctor] collecting every 10 s, …`.
- **`/tickdoctor status` shows losses.** A `Losses: …` line appears only when something was dropped (data, damaged buffer lines, events, log lines or failed disk writes).

## 13 November 2026: export, delete and Pro for everyone

- **Pro for everyone during the beta.** Every account now has Pro limits (more servers, longer history, all findings, custom status pages). The account page shows "Pro (beta)". When the beta ends, accounts go back to Free unless upgraded; we'll announce the date and email you first.
- **Export my data.** Download one file with everything we hold about you and your servers. It never includes password or key hashes.
- **Delete my account.** Remove your account, servers, history and waitlist entry yourself, immediately and for good.
- **Status pages, demo and docs** are live (see the entry below).

## 13 November 2026: status pages, docs and a demo

- **Public status pages.** Switch one on for a server and share a link that shows whether it is operational, degraded, lagging or offline, plus (if you choose) player count, uptime over 1, 7 and 30 days, and recent incidents. A page is **off by default**, shows nothing private, and looks the same as a missing page when it is switched off. Free pages show "Monitored with TickDoctor"; on Pro and Network you can hide it.
- **Status badge.** A small image you can put in your Discord, README or website.
- **Demo.** Look around a read-only example server without signing up.
- **Documentation.** An install guide, every plugin option, a data and privacy page, troubleshooting, an FAQ, and a page for each of the 11 findings.
- **Legal pages.** First drafts of the privacy policy, terms and legal notice. They are drafts and not final.

## 13 November 2026: incidents, findings and Discord alerts

- **Incident page.** Every lag spike gets its own page: a graph, a timeline, the worst chunks with copy-able `/tp` commands, and **"What changed?"**, which compares the lag with your server's healthy times.
- **Findings with fixes.** Plain-language notes on what is probably wrong, with the numbers behind them and numbered steps. The wording was reviewed for people who aren't Java experts.
- **Mark as fixed.** Tell us you changed something and we watch whether the problem comes back: 15 minutes for server-state findings, 72 hours for incident findings.
- **Tuning tips.** Suggestions that may help a little but aren't why you lag. They have their own section and never trigger alerts.
- **Discord alerts.** One webhook per server for: incident opened, incident resolved, server offline and back, and crash. Choose the minimum severity, a cooldown and quiet hours (critical incidents still come through). Send a test alert, and see a log of what was sent or skipped. Your webhook address is stored encrypted.

## 10 November 2026: accounts, servers and a live dashboard

- **Sign up and log in** with email and password, an emailed login link, or Discord. Accounts are created only after you confirm your email.
- **Add a server** with a short wizard: name it, copy your key, download the plugin, and watch "Waiting for first data…" turn green.
- **Dashboard.** Live TPS, MSPT and players; graphs for the last hour, day, week and month; incident markers; and a panel for CPU, temperature, memory, swap and disk.
- **Server settings.** Rename, rotate the API key (the old one stops working immediately) and delete a server.

## 9 November 2026: the plugin, storage and the first findings

- **Plugin 0.1.** Measures ticks, memory, entities, chunks and (on Linux) host health, and sends them to TickDoctor. Player ids are hashed by default and IP addresses are never sent. If the app can't be reached, the plugin keeps data in a size-limited buffer on disk and sends it later. `/tickdoctor status` shows what it is doing and how much it costs.
- **Incident detection.** An incident opens when the slowest ticks stay above 50 ms, or when TPS stays low, and TickDoctor saves a snapshot and a baseline.
- **Eleven findings.** Entity explosions, hopper hotspots, plugin changes before lag, player-count limits, memory pressure, overheating, swap, view distance, chunk generation, repeating plugin errors and Java flags. All eleven are tested against realistic data and stay quiet on a healthy server. Four of them (entity piles, hopper builds, chunk generation and Java flags) were also confirmed on a real Raspberry Pi server with deliberately caused lag.
- **Landing page and waitlist.** The first version of the site.
