---
title: Entity explosion
description: What it means when TickDoctor finds far too many mobs, items or minecarts, what it looks at, when it fires, and how to clear and prevent the pile.
---

# Entity explosion

**Typical titles:** "Too many cows in one chunk", "Far more villagers than usual", "Far more dropped items and cows than usual".

## What it means

An entity is anything in the world that isn't a block: mobs, villagers, dropped items, experience orbs, arrows, minecarts, boats, falling sand, armor stands. The server updates every entity 20 times a second. When hundreds pile up in one spot, or thousands exist across the world, a large part of every tick goes to updating them, and the server lags.

Not all entities cost the same. A villager is several times more expensive than a cow because it keeps looking for a bed, a job block and a path. Other "brainy" mobs (piglins, axolotls, goats, allays and similar) cost about twice a plain mob. Dropped items, orbs, projectiles and decorations cost much less. We weigh them that way when we judge how big a pile is.

## What we look at

- The incident's snapshot: every entity type per world and the 50 busiest chunks with what's in them.
- The regular samples around the incident, where the snapshot doesn't cover a world.
- Your server's healthy baseline: how many of each type there usually are, scaled up when more players are online than usual (more players legitimately means more mobs and drops).

## When it fires

Only during an incident. A big farm on a server that runs fine isn't a problem, so it never fires on its own.

It fires when it finds one of these:

- **A pile in one chunk.** At least 250 entities in a chunk, and either that type is clearly above its usual number (at least double and 200 more), or the chunk holds 1,000 or more, which lags on any hardware. Without a baseline to compare with (a new server), it needs 400 in one chunk.
- **A world-wide surge.** A type with at least three times its usual number and 1,000 more, even without a single hot chunk.
- **A heavy load spread out.** The weighted load is at least three times usual and far above it. On a Raspberry Pi that is roughly 600 plain-mob equivalents more than usual (for example 150 villagers). Faster machines get proportionally more room (1,500 on a small server, 3,000 on a large one).

It reports up to three separate piles, worst first. The severity is high for 1,000 or more in one chunk, a very large surge, or a very large spread-out load, otherwise medium.

## How to fix it

The fix depends on the type. The steps always start with going to the place: use the `/tp` button next to the chunk in the app (the chunks are listed busiest first), or the command in the finding.

1. **Look first.** Is it a farm, a breeder, a trading hall or a pile of dropped items? Fix the cause, not only the symptom: a full collection chest or a broken hopper line makes items pile up; a breeder with no kill chamber makes animals multiply; villagers breed when they have beds and food.
2. **Thin them out.** The finding gives you a `/kill` command for the type. This matters:
   - **In-game, standing in the chunk**, `distance=` means "close to me", so the commands look like `/kill @e[type=minecraft:cow,limit=100,distance=..24]`.
   - **From the console**, `distance=` is measured from the world spawn, not from you, so the same command would hit the wrong place. When we know the chunk and its dimension, the finding gives a console version that selects exactly that chunk (`/execute in minecraft:overworld run kill @e[type=…,x=…,y=-64,z=…,dx=15,dy=383,dz=15]`). It is only given for Paper's default world names. For other worlds, run the command in-game.
   - Every `/kill` is permanent. It also removes named pets, villagers players trade with, and valuable dropped items, so look around before you run it. Back up first.
3. **Stop it coming back.** Add a limit to the farm (a kill chamber, fewer breeding animals, a switch to turn it off), or give a collection system more storage.
4. **Optional settings** (for when the simple steps aren't enough; they need a restart):
   - Dropped items: raise `merge-radius.item` in `spigot.yml` (for example to `4.0`) so items merge into fewer entities. In `paper-world-defaults.yml`, `entities.spawning.alt-item-despawn-rate` makes junk items disappear sooner. Orbs: `merge-radius.exp`.
   - Projectiles: `chunks.entity-per-chunk-save-limit.<type>` in `paper-world-defaults.yml` stops a chunk from storing hundreds.
   - Armor stands: `entities.armor-stands.tick: false` in `paper-world-defaults.yml`.
   - Villagers: lower `entity-activation-range.villagers` in `spigot.yml`, so far-away villagers are updated less often.
   - Packed mobs: `collisions.max-entity-collisions` in `paper-world-defaults.yml` (default 8), and the game rule `max_entity_cramming` (on versions before 1.21.11: `maxEntityCramming`; run it without a value first to see the current number).

## After you fix it

Mark it as fixed once the pile is gone. This is an incident finding, so we watch for **72 hours** before confirming. It reopens if a pile like it shows up in another incident. Settings in the config files need a restart to take effect.
