---
title: View distance too high
description: What it means when view or simulation distance is more than your hardware handles, when TickDoctor reports it, and what values to use instead.
---

# View distance too high

**Typical title:** "View or simulation distance is probably too high for this hardware".

## What it means

- **View distance** is how far players can see: the chunks the server sends to them.
- **Simulation distance** is how far away mobs, crops and redstone keep running.

The further either reaches, the more the server has to update, and it grows quickly with every player. A high distance on a server that keeps up is your choice, not a problem. It becomes a finding only when the server clearly lags and the settings are above what the hardware handles.

## What we look at

Your view and simulation distance (from the server's hello), the number of loaded chunks while it lagged, the hardware class (Raspberry Pi and similar boards, small machines up to 4 cores, larger machines), and whether something else explains the lag better.

## When it fires

Only during an incident, and only when all of these hold:

- a distance is above what the hardware class handles comfortably: simulation 6 and view 8 on a Raspberry Pi class board, simulation 8 and view 10 on a small machine, simulation 10 and view 12 on a larger one,
- the server clearly lagged (slowest ticks 60 ms or more, or an average of 45 ms or more) for at least 2 minutes,
- many chunks were loaded: at least 1,500 on a Pi class board, 4,000 on a small machine, 8,000 on a larger one,
- and it is **not** better explained elsewhere: not lots of new chunks being generated, no pile of 250 or more entities in a chunk, and no big jump in entity count. Those have their own findings.

The severity is high when the loaded chunks reach twice the budget, otherwise medium.

## How to fix it

1. In `server.properties`, set the value(s) the finding suggests (`simulation-distance`, and `view-distance` if it is also above the limit). Players still see as far as before when only simulation distance changes. Mobs, crops and redstone further away just pause.
2. **Restart the server.** These settings are read at startup.
3. Watch the next busy evening. Loaded chunks and tick times should drop. If the server keeps up easily, you can raise view distance again by 1.
4. Optional: if you use per-world overrides, check `view-distance` and `simulation-distance` in `spigot.yml` under `world-settings`. A number there overrides `server.properties`. Restart after changing it.

## After you fix it

This is a settings finding. **Restart the server first, then mark it as fixed.** We check again once the restarted server reports its new settings. A finding about a specific incident is also watched for **72 hours**.
