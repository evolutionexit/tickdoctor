# Phase 0 report: reconnaissance and setup (2026-11-09)

## Built
- Repo `~/src/tickdoctor` (git, branch `main`) with the layout from brief §2, pnpm workspace, TS base config, Prettier/EditorConfig, `.gitignore`, `.env.example`, dev `docker-compose.yml` (Postgres 17 + Mailpit; api/web slots ready).
- `README.md`, the project guide and the 8 subagent definitions (kept locally, not in the repo) (as written in the brief; `pi-ops` and `plugin-dev` got the real SSH host and the Pi facts added, no rules loosened).
- `packages/shared`: `brand.ts`, `plans.ts`, draft contracts (`contracts/ingest.ts`, `contracts/findings.ts`).
- `docs/architecture.md` (stack + reasons, data model, page map, risks), `docs/contracts.md` (draft v0), `docs/mockups/phase-0.md` (landing hero + dashboard).
- No product code.

## Pi recon (pi-ops)
| | |
|---|---|
| Server | `/opt/minecraft/server`, **Paper 26.2 build 83** (Minecraft 26.2), **Java 25** |
| Launch | `minecraft.service`, disabled on boot, currently stopped. Drop-in `heap.conf`: **-Xms1G -Xmx3G** (not 4 GB) + full Aikar's flags |
| Hardware | Pi 5, 4 cores, 7.9 GB RAM (6.9 GB available), 2 GB zram swap, NVMe 88 GB free, 40 °C, not throttled |
| Config | view-distance 8, simulation-distance 6, max-players 8, world `world`, RCON off |
| Plugins | spark bundled with Paper; custom `ServerTelemetry.jar` (your earlier `~/mc-telemetry` project, its endpoint is unreachable) |
| playit.gg | `playit.service` enabled but **failed** since Nov 6 ("Could not reach the playit API"). Not touched. |
| Backup | `$PI_HOME/mc-backup-20261109-0932.tar.gz` (225 MB) |

## Decisions worth knowing
1. **Plugin targets Java 25, not 21** — Paper 26.x requires it and that's what the Pi runs.
2. **Hono** over Fastify (less code, SSE + zod built in, testable without a server).
3. **Plain Postgres, no TimescaleDB** — our volume is small, and Timescale would rule out most cheap managed hosts. Own rollup tables + retention job.
4. **Own small auth** (sessions table, argon2id, `arctic` for Discord) rather than a library, so the tables match the brief and you can read all of it.
5. **uPlot** for charts (tiny and fast), API caps series at ~2,000 points.
6. Health states use **icon + word + colour** (blue/amber/magenta/grey), safe for colour-blind users.

## Suggested models for subagents
`opus` (inherit): plugin-dev, backend-dev, rules-engineer, reviewer. `sonnet` is enough for: pi-ops, copywriter, web-dev, qa. Say yes and I'll set `model: sonnet` in those four files.

## What I need from you
1. **Dev machine.** This Mac has Node 22 but **no Docker and no JDK**. Options: (a) install OrbStack or Docker Desktop on the Mac (prebuilt, but virtualisation on the hackintosh may not work); (b) run dev Postgres + Mailpit on the Pi in Docker (I'd need `michel` added to the `docker` group: a system change, needs your OK); (c) the Windows desktop. For the plugin I'd install a prebuilt Temurin JDK 25 into `~/.local` (no admin, no Homebrew compile). My pick: try (a), fall back to (b).
2. **Old ServerTelemetry plugin:** OK for pi-ops to move it out of `plugins/` during TickDoctor tests (so it doesn't skew overhead numbers)?
3. **Heap:** keep 1–3 GB, or set the Aikar-style 4 GB/4 GB? (The "heap too small" scenario in Phase 4 changes it temporarily anyway.)
4. **Mockups** in `docs/mockups/phase-0.md`: block-grid + teal pixel accent OK? Hero leads with the waitlist?
5. Reviewer/qa were not run: there's no code to review or test yet in Phase 0.

## How to look at it
`cd ~/src/tickdoctor && git log --stat` · read `docs/architecture.md`, `docs/contracts.md`, `docs/mockups/phase-0.md`.
