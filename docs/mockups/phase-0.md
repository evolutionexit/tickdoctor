# Phase 0 mockups: react to these

## Landing hero

Dark background (#0e1116), a faint 16 px block grid in the background that fades out toward the bottom. One teal pixel accent (#5eead4) on the logo mark (a small square "heartbeat" line made of blocks).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣ TickDoctor            Features  Pricing  Docs  Demo        [Join waitlist] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Find out why your Minecraft server lags                ┌────────────────┐  │
│   — in plain English.                                    │ ▲ LAGGING      │  │
│                                                          │ MSPT 87 ms     │  │
│   TickDoctor watches your server around the clock.       │ ╱╲__╱╲╱╲___    │  │
│   When lag hits, it captures what changed and tells      ├────────────────┤  │
│   you what to fix, with coordinates.                     │ Finding (HIGH) │  │
│                                                          │ 2,340 item     │  │
│   [ you@email.com            ] [Join the waitlist]       │ entities at    │  │
│   Free for one server. No credit card.                   │ world 1204,-388│  │
│                                                          │ → Add a clear- │  │
│   Works with Paper · Runs async · < 0.5 ms/tick          │   lag timer    │  │
│                                                          │ [Copy /tp]     │  │
│                                                          └────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The card on the right is the **real finding component** from the app, fed with a static example, so the landing page shows exactly what you get. On phones it stacks below the form.

## Server dashboard (`/app/servers/[id]`)

```
┌ Servers ▾ Pi Survival ───────────────────────────── ● Healthy · 20.0 TPS ─┐
│ Overview  Incidents (2)  Findings (3)  Alerts  Status page  Settings      │
├───────────────────────────────────────────────────────────────────────────┤
│ ┌ TPS ──────┐ ┌ MSPT p95 ─┐ ┌ Players ──┐ ┌ Open findings ─────────────┐  │
│ │ 20.0      │ │ 18 ms     │ │ 3 / 8     │ │ ▲ Hopper hotspot (medium)  │  │
│ │ live ●    │ │ ▁▂▁▃▁▂    │ │ ▁▁▂▃▃▂    │ │ ◆ JVM flags: Xms≠Xmx (low) │  │
│ └───────────┘ └───────────┘ └───────────┘ └────────────────────────────┘  │
│                                                                           │
│ MSPT                                               [1h] 24h  7d  30d      │
│ 100┤                    ▲ incident #12                                    │
│  50┤- - - - - - - - - - ┃╲- - - - - - - - - - - - - - - - - - - - - - -   │
│   0┤▁▁▂▁▁▂▁▁▁▂▁▁▁▂▁▁▁▂▁╱┃ ╲▁▁▂▁▁▂▁▁▁▂▁▁▁▂▁▁▁   ░ players (overlay)       │
│                                                                           │
│ Host (Raspberry Pi 5)                                                     │
│ CPU 34% · 52 °C · not throttled · RAM 4.1/7.9 GB · Swap 0 · Disk 22%      │
└───────────────────────────────────────────────────────────────────────────┘
```

- Health always shown as **icon + word + colour** (● healthy blue, ◆ degraded amber, ▲ lagging magenta, ○ offline grey) so it works for colour-blind users and in screenshots.
- Incident markers are clickable bands on every graph.
- Mobile: the four tiles become a 2×2 grid, graphs go full width, the tab bar scrolls horizontally.

Questions for you: does the block-grid / teal pixel direction feel right, or would you rather go more neutral? Should the hero lead with the waitlist (validation now) or with "See the demo" (later)?
