---
title: Plugin change before lag
description: What it means when the server got slower after a plugin was added, updated or removed, how TickDoctor decides, and how to test and roll back safely.
---

# Plugin change before lag

**Typical titles:** "The server got slower after WorldEdit was updated", "The server got slower after a plugin change".

## What it means

A plugin was added, updated or removed shortly before the lag started, and since then ticks take measurably longer **with the same number of players online**. That points at the change as the likely cause. It can't prove it, and the finding says so.

## What we look at

- Plugin changes that the plugin noticed (or that show in the plugin inventory): added, updated, removed.
- Average tick time before the change and after it, compared **at the same player counts**, so a busy evening doesn't look like a regression.
- Startup is always slow, so the minutes right around a restart are left out.

## When it fires

Only during an incident. A plugin change counts if it happened up to 72 hours before the incident started, or up to 15 minutes after it (a restart with a new plugin often is what opens the incident). Changes made together are treated as one batch.

It fires only when all of this holds:

- there is enough data: at least an hour of history in the week before the change, and at least 20 matching minutes after it,
- the average tick is slower by at least 4 ms **and** at least 25 %,
- the incident itself doesn't explain the difference. When there's enough other data after the change, the incident is left out of the comparison. If not, the incident is used only when the change was at most 3 hours earlier, and the evidence says so.

Plugins change all the time without consequences, so a change on its own is never a finding. The severity is high when the lag was severe (slowest ticks 100 ms or more) and ticks are at least 10 ms slower, otherwise medium.

## How to fix it

1. **Back up** the whole `plugins` folder.
2. **Test.** The finding gives the right step for what changed:
   - *Updated:* stop the server and put the previous version of the plugin's jar back in `plugins/`. Back up the plugin's config folder too, because newer versions sometimes rewrite it.
   - *Added:* stop the server and move the new jar out of `plugins/`.
   - *Removed:* the removed plugin may have been keeping the load down (for example by limiting farms or mobs). Reinstall it to test.
3. **Watch** the server for a day with a similar number of players.
4. **If the lag is gone,** stay on the old setup, tell the plugin's author which versions you compared and when the lag shows up, and read the new version's changelog for an option you can turn off.
5. **If the lag stays,** the change wasn't the cause. Put the new version back and look at the other findings for the incident.

## After you fix it

Mark it as fixed after your test. This is an incident finding, so we watch for **72 hours** before confirming. Plugin changes need a restart anyway, so the server will have restarted.
