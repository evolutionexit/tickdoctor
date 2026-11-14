# Architecture (Phase 0)

## 1. Big picture

```
 Minecraft server (Paper)                    TickDoctor cloud                        Browser
┌──────────────────────────┐   HTTPS/JSON   ┌───────────────────────────────┐      ┌──────────────┐
│ tickdoctor-agent.jar     │ ─────────────▶ │ apps/api (Hono, Node 22)      │ ◀──▶ │ apps/web     │
│  collectors (main+async) │  hello/metrics │  ingest → metric_samples      │ JSON │ (Next.js)    │
│  disk ring buffer        │  events/snap   │  rollup job (1m, 1h)          │ SSE  │ marketing,   │
│  /tickdoctor commands    │ ◀───────────── │  incident detector → snapshot │      │ docs, app,   │
└──────────────────────────┘  remote config │  rules engine → findings      │      │ status pages │
                                            │  alerts → Discord webhooks    │      └──────────────┘
                                            │  Postgres 17 (Drizzle)        │
                                            └───────────────────────────────┘
```

All TypeScript shares one contract package (`packages/shared`). The Java plugin follows the same contract through a JSON Schema generated from it (Phase 2), so the plugin's tests fail if it drifts.

## 2. Stack decisions

| Area | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces | Fast, strict deps, no extra build tool needed at this size. |
| API | **Hono** on Node 22 | Small, web-standard Request/Response, built-in SSE helper and zod validator; easy to test with `app.request()` without a running server. Fastify would also work; Hono is less code for the same thing. |
| Validation | **zod** schemas in `packages/shared` | One definition gives runtime validation in the API, types for web, and JSON Schema for the plugin. (Phase 0 drafts are plain TS types; they become zod in Phase 2.) |
| DB | **Postgres 17 + Drizzle**, no TimescaleDB for now | Volume is small: one sample per 10 s = 8,640 rows/day/server. Plain tables with a `(server_id, ts)` index plus our own 1 m / 1 h rollup tables and a retention job are enough for hundreds of servers. Timescale isn't offered by most cheap managed Postgres hosts (Neon, Supabase dropped it for new projects), so it would limit hosting. If volume grows we can partition `metric_samples` by day (native Postgres) without changing the API. |
| Auth | Own small implementation: `sessions` table + httpOnly cookie, argon2id passwords, magic links and email tokens in `email_tokens`, Discord OAuth via `arctic` | Matches the tables in the brief exactly, and it's ~400 lines you can actually read. (Lucia, the usual library, is deprecated; Better Auth would hide the tables behind its own schema.) |
| Web | **Next.js App Router + Tailwind**, MDX for docs/legal/changelog | Static generation for marketing/docs (good SEO, cheap hosting), client components for the live dashboard. |
| Charts | **uPlot** | ~45 KB, renders 100k points smoothly; we still cap API responses at ~2,000 points per series. ECharts is nicer out of the box but ~10× heavier. |
| Email | nodemailer → Mailpit in dev, any SMTP in prod | |
| Tests | Vitest (api, shared, rules), JUnit 5 (plugin), Playwright (e2e) | |
| Plugin | **Java 25**, Gradle Kotlin DSL, Paper API 26.2, shadow plugin | ⚠️ Change from the brief (Java 21): your Pi runs **Paper 26.2 on Java 25**, and Paper 26.x requires Java 25, so the plugin must be compiled for it. HTTP via the JDK's built-in `HttpClient`, JSON via Gson (already bundled in Paper), so almost nothing to shade. |

### How the plugin measures without hurting the server
- **MSPT/TPS:** Paper's `ServerTickStartEvent` / `ServerTickEndEvent` give exact per-tick durations; we keep them in a fixed-size ring (no allocation per tick) and compute avg/p95/p99/max on an async thread every 10 s.
- **Entities/chunks:** must be read on the main thread (Bukkit API). We spread the work: each tick we visit a small slice of loaded chunks (budget ~0.2 ms) and build the counts incrementally, so a full pass takes a few seconds instead of one big spike. The agent measures its own main-thread time and reports it as `agentOverhead`.
- **Host:** `/proc/stat`, `/proc/meminfo`, `/proc/diskstats`, `/proc/net/dev`, `/sys/class/thermal/*`, `vcgencmd get_throttled` — all async, all optional.
- **GC/heap/threads/CPU:** JMX beans, async.
- **"Can't keep up" warnings and exceptions:** a Log4j appender that only pattern-matches and enqueues; parsing happens async.

## 3. Data model (Postgres)

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, email (unique, citext), password_hash null, email_verified_at, display_name, created_at | No other personal data. |
| `sessions` | id (hash of cookie token), user_id, expires_at, created_at, user_agent_hint | Cookie holds a random token; DB holds only its hash. |
| `oauth_accounts` | provider ('discord'), provider_user_id, user_id | |
| `email_tokens` | token_hash, user_id/email, purpose (verify/magic/reset), expires_at, used_at | Single-use, 15–60 min. |
| `waitlist` | email (unique), source, created_at | Phase 1. |
| `servers` | id, owner_id, name, slug, plan ('free'/'pro'/'network'), created_at, last_seen_at, boot_id | |
| `api_keys` | id, server_id, key_hash, prefix, created_at, revoked_at | |
| `server_info_history` | server_id, valid_from, valid_to, info jsonb, info_hash | New row only when the hello payload's hash changes → change detection is a diff of two rows. |
| `plugin_inventory_history` | server_id, plugin, version, first_seen, last_seen | |
| `metric_samples` | server_id, ts, tps1m, mspt_avg/p95/p99/max, players, heap_used, cpu, temp, swap_used… + detail jsonb | Hot columns as real columns (fast charts), everything else in jsonb. |
| `metric_rollups_1m`, `metric_rollups_1h` | server_id, bucket, metric columns as avg/max/min | Built by a job every minute / hour. |
| `events` | server_id, ts, type, data jsonb | |
| `incidents` | id, server_id, started_at, ended_at, severity, peak_mspt | |
| `incident_snapshots` | incident_id, captured_at, snapshot jsonb, baseline jsonb | Baseline = medians over the last healthy hours. |
| `findings` | id, server_id, incident_id null, rule_id, severity, title, explanation, evidence jsonb, suggested_fix, status, marked_fixed_at, recheck_at, fingerprint | `fingerprint` dedupes the same problem across incidents. |
| `alert_configs` | server_id, discord_webhook_url (encrypted), events[], cooldown_min, quiet_hours (tz, from, to), thresholds jsonb | |
| `alert_deliveries` | id, server_id, kind, status, http_status, sent_at, error | |
| `status_pages` | server_id, slug, enabled, show_players, show_uptime, show_incidents, theme | |

Retention: one job deletes raw/1m/1h/incidents older than the server's plan allows (`plans.ts`). Account deletion cascades through every table above.

## 4. Incident detection and rules (Phase 4)
- Detector runs on every ingested sample: opens an incident when MSPT p95 > threshold (default 50 ms) for N consecutive seconds (default 30), closes after M seconds healthy (default 120). Hysteresis avoids flapping.
- On open: take the agent's snapshot (or request one via the `config` response field) and build a baseline from the last healthy samples.
- Rules are pure functions `(context) => Finding[]` in `apps/api/src/rules/<rule>.ts`, where context = snapshot, baseline, recent samples, info/plugin history, events. Pure functions = easy to test with fixtures captured on the Pi.

## 5. Page map
See brief §5. Grouping in `apps/web/app/`:
- `(marketing)/` → `/`, `/pricing`, `/changelog`, `/demo`
- `docs/` → MDX pages, `docs/findings/[rule]` generated from the rule list
- `(auth)/` → login, signup, forgot/reset password, verify-email
- `app/` → logged-in area, layout with server switcher
- `s/[slug]` → public status pages + OG image route
- `legal/` → MDX drafts

## 6. Where things run (dev)
- Code lives on the Mac in `~/src/tickdoctor`: Node 22, pnpm, Docker via OrbStack, Temurin JDK 25 in `~/.local`.
- Pi = test Minecraft server only, operated by `pi-ops`.

## 7. Risks
1. **Main-thread cost of entity/chunk counting** on big worlds. Mitigation: time-sliced sampling + self-measured overhead + config to reduce frequency. Phase 2 must prove overhead < 0.5 ms/tick on the Pi.
2. **Paper 26.x is new** (year-based versions). APIs we rely on (tick events, chunk/entity access) need checking against the 26.2 API jar; avoid NMS entirely so updates don't break us.
3. **False positives in findings** hurt trust more than missing findings. Rules only fire with clear evidence vs baseline; every rule has a "healthy server" fixture that must produce nothing.
4. **One test server.** The Pi is small (4 cores, 8 GB); good for "small host" findings but not for big-network scale. Seed data covers larger shapes.
5. **Market overlap** with free tools (spark, Plan, ServerAnalytics). The differentiator is diagnosis over time; the landing page and waitlist (Phase 1) test whether people care before most of the build.
6. **GDPR / legal**: hashed player ids, no IPs, retention per plan, real deletion. Legal pages stay drafts until reviewed.
7. **Log scraping** ("can't keep up", exceptions) is fragile across versions; treat it as best-effort and never let it throw.
