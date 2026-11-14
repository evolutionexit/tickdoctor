# Contracts

The TypeScript source of truth is `packages/shared/src/contracts/`. This file explains it. Ingest payloads are finalised in Phase 2 and the app API in Phase 5; after that, changes go through the lead and bump `schemaVersion`.

## 1. Plugin → API (ingest) — v1, frozen in Phase 2

Source: zod schemas in `packages/shared/src/contracts/ingest.ts`. Generated JSON Schema for the Java plugin: `docs/contracts/ingest.schema.json` (`pnpm --filter @tickdoctor/shared gen:schema`; re-run after any contract change). Every array and string has a max size.

| Endpoint | When | Body (`payload` inside the envelope) |
|---|---|---|
| `POST /v1/ingest/hello` | On plugin enable, and again after `plugins_changed` | `HelloPayload`: software/versions, JVM flags and heap, host model, view/sim distance, entity activation range, worlds, plugins, privacy mode |
| `POST /v1/ingest/metrics` | Every 10 s (configurable) | `MetricsPayload`: 1..n `MetricSample` (more than one after a reconnect flushes the buffer) |
| `POST /v1/ingest/events` | Batched, flushed within 5 s | `EventsPayload`: start/stop/crash, join/leave, can't-keep-up, exceptions (folded by `stackHash`), plugin changes |
| `POST /v1/ingest/snapshot` | MSPT p95 over threshold, `/tickdoctor snapshot`, or the API asked for one (`config.requestSnapshot`) | `SnapshotPayload`: full sample + all entity/tile types + top 50 chunks + top threads + last 5 min of events |

**Envelope** (all four): `{ schemaVersion, agentVersion, sentAt, bootId, payload }`.

**Auth:** `Authorization: Bearer td_live_<32 random bytes base62>`. The API stores only `sha256(key + pepper)` and the first 12 chars as a display prefix.

**Responses:** `200 { ok: true, config? }` — `config` lets the API change the sampling interval (5–300 s) or snapshot threshold (20–1000 ms) remotely, or request a snapshot now. The agent clamps values to those bounds. `401 invalid_key|revoked_key` (agent stops and logs loudly), `400 invalid_payload` (agent drops the batch, logs), `429 rate_limited` with `retryAfterSeconds` (agent backs off and keeps buffering), `402 plan_limit`, `413 payload_too_large` (agent splits the batch). `402 plan_limit` and any other 4xx/5xx (e.g. 403, 503): agent keeps buffering and backs off; only 401 stops sending. `bootId` on a flushed batch is the boot that *sends* it; each sample's own `ts` is authoritative for time. Error body: `{ ok: false, error, message?, retryAfterSeconds? }`.

**Value bounds (pentest F-03/B-01):** counts ≤ 2147483647 (Postgres int4; the API clamps the stored sums over worlds/types at int4 max), byte counts ≤ 9007199254740991 (safe integer), floats ≤ 1e15, chunk coordinates within int4. Strings are CLEANED, not rejected: control characters (NUL, C0 except tab/LF/CR, DEL, C1) are removed and lone surrogates become U+FFFD, in every string and record key (`stripControl` in the contract). A value Postgres still cannot store returns 400 `invalid_payload`, never a 500. The plugin clamps its own values to these bounds.

**Limits:** body ≤ 1 MB both on the wire and after gzip decompression (the agent keeps uncompressed JSON < 900 KB); count maps (`entitiesByType`, `tileEntitiesByType`, `byType`) ≤ 200 keys (zod-only rule, not expressible in the JSON Schema; the agent caps it); ingest rate limit per key ≈ 30 req/min, snapshots ≤ 1 per 2 min per server.

**Batch sizes:** metrics 1–60 samples, events 1–500.

**Agent overhead** is part of every sample: `agentOverhead.mainThreadMsPerTick` (average), `mainThreadMsMax` (worst tick), `asyncCpuMs`. Entity/chunk counts are gathered incrementally on the main thread in small slices; `world[].countsAgeSeconds` says how old they are. Snapshots do a fresh full pass.

**Redaction (agent side, allow-list):** JVM flags: `-X*` options (`-Xms`, `-Xmx`, `-XX:*`, `-Xlog*`) are kept; `-Dname=value` keeps its value only for `using.aikars.flags` / `aikars.new.flags`, every other `-D` becomes `-Dname=***`; `-javaagent`, `-agentpath`, `-agentlib`, class/module paths, `-jar` and any flag containing a home folder are dropped; kept flags also lose IPs, URL logins and home names. Free text (exception messages, stack frames, crash details) loses IPs, UUIDs, `scheme://user:pass@`, `password/token/secret/key: value`, home-folder names (`/home/NAME` becomes `/home/~`), camelCase and JSON secret pairs (`apiKey: x`, `"password":"x"`) and `Authorization`/`Bearer` tokens. JVM options that hold commands or paths (`-XX:OnError=`, `OnOutOfMemoryError=`, `ErrorFile=`, `HeapDumpPath=`, `Flight*`, `-Xloggc:`) keep only their name, and `-Xlog` keeps tags/decorations but never a file path. The API scrubs the same classes again as defence in depth (`scrubText`). `paperWorldDefaults` contains allow-listed keys only.

**Agent buffering:** bounded on-disk ring buffer (default 50 MB, oldest dropped first); exponential backoff 5 s → 5 min with jitter.

**Privacy:**
- Player identifiers are NOT sent (Phase 8 data minimisation: the API never used them). `player_join`/`player_leave` carry only `playerCount`; `players.pings[]` carries `pingMs` only (`id` is optional and deprecated: agents < 0.1.5 sent a 64-char hex hash, the API ignores it). Config `privacy-mode` `hashed`/`none` is still accepted and means the same today.
- IP addresses are never sent in any mode.

### Units and conventions
Timestamps ISO-8601 UTC. Bytes as integers. Durations in ms unless the name says otherwise. Loads 0..1. Missing host metrics are omitted, never `0` or `null`, so "no data" and "zero" stay distinct.

## 2. Findings
See `Finding` in `contracts/findings.ts` (zod, frozen in Phase 4) and §6 below. Every finding has `severity`, `title`, `explanation`, `evidence` (numbers with baseline, the chart to show, chunks for `/tp`), `suggestedFix`, `status` (`open` → `marked_fixed` → `confirmed_fixed`, or back to `open` if the problem returns).

## 3. App API (Phase 5, frozen)
Source of truth: `contracts/app.ts` (zod + comments per route). Summary:
- **Transport:** same-origin `/api/*` via Caddy, JSON, errors `{ error: { code, message, fields? } }` (`API_ERROR_CODES`).
- **Session:** cookie `td_session` (random 32 bytes; DB stores only `sha256`), httpOnly, SameSite=Lax, Secure when `COOKIE_SECURE=true`, 30 days sliding. Table `sessions(id_hash, user_id, created_at, expires_at, last_used_at)`.
- **CSRF:** every non-GET under `/api` (except the Phase 1 waitlist) needs `Origin == WEB_PUBLIC_URL` **and** `x-csrf-token == td_csrf` cookie. `GET /api/auth/session` issues `td_csrf`.
- **Passwords:** scrypt from `node:crypto` (N=2^15, r=8, p=1, 16-byte salt, encoded with params so they can be raised), 10–200 chars, constant-time compare; a dummy hash is checked for unknown emails so timing doesn't reveal accounts.
- **Auth flows (no account enumeration anywhere; revised 2026-11-10 by Michel):** an unconfirmed account can never log in or hold a session and has no password. Signup asks only for the email (a sentence explains a link will follow, with the privacy link; no checkbox) → always `{ok:true}`; new or unconfirmed email gets a fresh confirm link (earlier attempt discarded, old tokens void); confirmed email gets a "you already have an account" magic link. The `/verify-email` page checks the token read-only (`GET /api/auth/verify-token`), the user presses **Continue**, and for a confirm link chooses the password (plus optional name and the consent checkbox — the only consent record) there; the page then **POSTs** `{token, password, consent, displayName?}` to `/api/auth/verify` (token consumed only on success) → confirmed + logged in. Magic link (15 min, confirmed accounts only), confirm (24 h), reset (60 min; confirmed only; ends other sessions). Every link request for an unconfirmed account sends a confirm link instead. Pending users without servers are purged after 7 days. Tokens in `email_tokens` as sha256, single use. Emails via SMTP (Mailpit in dev), plain text + simple HTML, no tracking.
- **Discord:** optional; `GET /api/auth/providers` says whether it's configured; **no automatic linking by email** (Phase 8, L10): a Discord sign-in whose verified email matches an existing confirmed account is refused with `/login?error=discord_email_exists` (log in normally, then connect Discord from the account page); linking from `/app/account` while signed in needs no email checks (errors `discord_in_use`, `discord_failed` back to `/app/account?error=`). A new account via Discord is created only after the consent checkbox on `/signup/discord` (pending row, 10 min). See app.ts. Stores only the Discord user id (`oauth_accounts`).
- **Rate limits:** `AUTH_LIMITS`; signup also counts toward the per-email send limit (over it: still `{ok:true}`, no mail).
- **Plans:** `users.plan` (default free; CLI `user:set-plan`). Creating a server needs a verified email and a free slot (`plans.ts` `servers`) → `402 plan_limit`.
- **Servers:** list (with health, latest sample, open incident count, top finding — never a severity-info tuning tip), create (key + config snippet shown once), get, rename, delete (type the name), rotate key, first-data (onboarding), metrics + metrics/batch, incidents list (markers; detail page is Phase 6).
- **Health:** one API function: `waiting` (never sent data) / `offline` (> 90 s without a sample) / `lagging` (open incident) / `degraded` (5-min median p95 ≥ 40 or TPS < 19) / `healthy`.
- **Live:** `GET /api/servers/:id/live` SSE: `status` + `sample` events, ping every 15 s, max 5 streams per user; in-process bus fed by ingest.
- **Ownership:** every `:id` route checks `servers.owner_id = session user` → 404 otherwise (one helper: `serverAccess`).
- **Agent download:** `GET /downloads/agent/latest.jar` from `AGENT_JAR_DIR` (public).
- **Defaults/codes:** incidents list `limit` default 200; unknown errors `internal` (500), other non-5xx HTTP errors `invalid_request`.
- **Not in Phase 5:** incident detail, findings endpoints + mark fixed (Phase 6), alerts (6), status pages (7), account export/delete (8).

### 3.1 `POST /api/waitlist` (Phase 1, frozen)
Source: `contracts/waitlist.ts`.
- Body: `{ email, source: "landing-hero"|"landing-footer"|"pricing-dialog"|"other", consent: true, website?: "" }` (`website` is a hidden honeypot).
- `200 { ok: true }` for new, duplicate and honeypot submissions alike, so the endpoint can't be used to check whether someone signed up.
- `400` invalid email / missing consent, `403 bad_origin` (Origin must equal `WEB_PUBLIC_URL`, a missing Origin is rejected too; this is the CSRF guard for a form with no session), `413 payload_too_large` (> 10 KB), `429 rate_limited` with `Retry-After` (5 / 10 min / IP, plus a global cap of `WAITLIST_GLOBAL_CAP_PER_HOUR` new signups per rolling hour, default 200). Unknown routes everywhere: `404 not_found`.
- Stored: email (lower-cased), source, created_at. Nothing else, no IP.
- Same-origin: Caddy (the single entry point) routes `/api/*`, `/v1/*`, `/badge/*`, `/downloads/*` and `/health` to the API and everything else to web, so no CORS in the browser. Caddy replaces client `X-Forwarded-For` with the peer address; the API trusts it only with `TRUST_PROXY=true`. With `pnpm dev` on the host, Next.js rewrites forward `/api` and `/v1` instead.

## 3b. App API Phase 6: incidents UI, findings, alerts (frozen 2026-11-10)
Source of truth: `contracts/app-phase6.ts`. Summary:
- **Tuning tips** = findings with severity `info` (`isTuningTip`, the only definition). Shown only in a separate "Tuning tips" section; never in an incident's causes, never in alerts, never the server card's top finding.
- **Incidents:** list gains `findingCount`, `topFindingTitle`, `status` filter. `GET /api/incidents/:id` → incident + snapshot (worlds, worst 10 chunks with top types) + **what changed?** (API-computed from baseline vs. during; notable = ≥ 1.5× or any plugin/config/JVM change) + non-tip findings in impact order + timeline (−30 min … end).
- **Findings:** `GET /api/servers/:id/findings?status&severity&ruleId` → `{ findings, tuningTips }`; `GET /api/findings/:id`; `PATCH /api/findings/:id { status: marked_fixed | open }` (undo only from marked_fixed; else 409). The Phase 4 recheck job confirms or reopens.
- **Alerts:** one Discord webhook per server (only discord.com/discordapp.com webhook URLs; stored AES-256-GCM encrypted with `SECRETS_KEY`; never returned/logged in full). Events incident opened (≥ min severity) / resolved, server offline / back, crash. Per-event cooldown, quiet hours (critical incidents still go through), every attempt/suppression in `alert_deliveries` (30 days). `GET/PUT /api/servers/:id/alerts`, `POST …/alerts/test`, `GET …/alerts/deliveries`. `allowed_mentions: {parse: []}`; delivery never blocks ingest.
- **Plan gating (F-04, 2026-11-14, a teaser):** `plans.findings` is enforced server-side from the server's EFFECTIVE plan (`planOf`, so `BETA_ALL_PRO` lifts Free to Pro and nothing is locked). `"basic"` (Free): finding title, severity, status, times and counts stay; `explanation`, `evidence`, `suggestedFix` and `dedupKey` are **omitted** (not sent) and the finding gets `locked: true, lockedReason: "plan"`. On `GET /api/incidents/:id` a Free server gets `locked: true`, no `whatChanged`, no `snapshot.worstChunks`, no plugin/config entries in the timeline, and its findings are locked. Tuning tips are never locked. `PATCH /api/findings/:id` (mark fixed / undo) still works on Free (status only). All new fields are optional, so old clients still parse. Alerts only ever carry titles + severity, so they are the same on every plan. The GDPR export (`/api/account/export`) and the CLI/demo export keep the full data (it is the user's own data). Schemas: `findingView`, `patchFindingResponse`.

## 3c. Phase 7: status pages, badge, demo, docs (frozen 2026-11-13)
Source of truth: `contracts/app-phase7.ts`. Summary:
- **Status page settings** (owner): `GET/PUT /api/servers/:id/status-page` — enabled (default off), slug (`STATUS_SLUG_RE`, `RESERVED_SLUGS`, unique; 409 when taken), title, showPlayers / showUptime / showIncidents, theme, hideBranding (only plans with `statusPage: "custom"`).
- **Public:** `GET /api/public/status/:slug` → simplified state (operational / degraded / lagging / offline), players, uptime 1/7/30 d, last-30-day incidents (no findings) — each only when enabled by the owner; 404 identical for unknown and disabled; cached 30 s; rate-limited; never player ids, IPs, plugins, findings or owner data. `GET /badge/:slug.svg` (shields-style, escaped, cached 60 s). Web `/s/[slug]` + Open Graph image; `noindex` until go-public.
- **Demo:** `/demo` renders only the committed `apps/web/content/demo/dataset.json` (exported + cleaned from "Pi (test history)" with a made-up server name; relative timestamps shifted to "now"); works with the Mac and Pi offline.
- **Docs:** Markdown in `apps/web/content/docs/` (+ `findings/<ruleId>.md`, `changelog.md`), front matter title/description, rendered with the safe renderer.

## 3d. Phase 8: beta switch, export, deletion, SEO (frozen 2026-11-13)
Source of truth: `contracts/app-phase8.ts`. Summary:
- **`BETA_ALL_PRO=true`** gives every account Pro limits without changing stored plans; one function `effectivePlan` used by every limit (`apps/api/src/limits.ts`). `sessionUser` gains `effectivePlan` + `planSource` ("stored" | "beta"); the servers list `limits.plan` is the effective plan + `planSource`. Account page shows "Pro (beta)" with the end-of-beta note.
- **Export:** `GET /api/account/export` streams one JSON file with everything we hold (never hashes or the decrypted webhook).
- **Deletion:** `DELETE /api/account { confirmEmail, password? }` removes, in one transaction, all servers and their data, sessions, tokens, Discord links, pending Discord signups, **waitlist rows with that email**, and the user; a schema-driven test checks nothing remains.
- **SEO:** titles, descriptions, canonical, OG/Twitter tags + OG images per public page type; robots disallow /app, /api, /s.

## 4. Public
`GET /api/public/status/:slug`, `GET /badge/:slug.svg`, `GET /downloads/agent/latest.jar` — outline in Phase 7.

## 5. Storage and keys (Phase 3, frozen)

### 5.1 Server API keys
- Format `td_live_` + 32 random bytes base62 (shown **once** at creation/rotation). Stored: `sha256(key + API_KEY_PEPPER)` hex in `api_keys.key_hash` (unique) and the first 12 chars as `prefix` for display. Lookup by hash; `revoked_at` set → `401 revoked_key`; unknown → `401 invalid_key`.
- Until Phase 5 (app + onboarding) servers and keys are created with a CLI: `pnpm --filter @tickdoctor/api cli server:create --name "<name>" --owner-email <email>` (creates the user if missing, prints server id + key once), `server:rotate-key <serverId>`, `server:list`.
- The Phase 2 stub key (`INGEST_STUB_KEY`) is removed in Phase 3.

### 5.2 What each ingest call stores
| Call | Stored |
|---|---|
| hello | `server_info_history`: new row only when the normalized info hash changes (previous row gets `valid_to`). `plugin_inventory_history`: upsert per (server, plugin, version) → `first_seen`, `last_seen`. `servers.last_seen_at`, `servers.boot_id`. |
| metrics | one `metric_samples` row per sample, unique `(server_id, ts)` → retries/flushes are idempotent (`ON CONFLICT DO NOTHING`). Hot columns = `METRIC_NAMES` in `contracts/metrics.ts`; the rest (per-world counts, worst chunks, GC per collector, remaining host fields, agent overhead detail) in `detail jsonb`. `received_at` column for the rollup job. |
| events | `events` (server_id, ts, type, data jsonb), deduplicated by `event_hash = sha256(type + ts + canonical data)` unique per server. |
| snapshot | `incident_snapshots` with `incident_id` NULL until Phase 4 links it, plus `trigger`, `captured_at`, `snapshot jsonb`. |

**Player data minimisation:** the API does **not** store hashed player ids at all in Phase 3. Free text (exception messages/frames, crash detail, stop reason, snapshot thread names) is scrubbed server-side: UUIDs → `<uuid>`, IPv4/IPv6 → `<ip>`, standalone 32/64-hex → `<hex>`. Player *names* can't be detected reliably server-side; the agent removes names of online players before sending, so offline players' names in old messages are a known residual risk (documented in the privacy policy at go-public).

**Timestamps:** samples/events/snapshots more than 10 min in the future are dropped (bad agent clock); samples older than the raw-retention cutoff (rounded up to the hour) are dropped. All bucketing is UTC. From `players.pings` it keeps only `players` (count) and `ping_avg`; from join/leave events only `playerCount`. If a later rule needs per-player data, that's a contract change with a GDPR note.

### 5.3 Rollups and retention
- A job (in the API process, every minute, single-flight via a Postgres advisory lock) aggregates raw → `metric_rollups_1m` and 1m → `metric_rollups_1h`, storing avg/min/max per metric per bucket (+ sample count). It recomputes every bucket touched by rows with `received_at` since its last run, so **late data from an agent's disk buffer is rolled up correctly**. Upserts → idempotent.
- Retention job (hourly): deletes raw / 1m / 1h / events / snapshots older than the server's plan allows (`plans.ts`: `rawRetentionDays`, `rollup1mRetentionDays`, `rollup1hRetentionDays`, `incidentRetentionDays`). All plan limits read through one `limits` module.

### 5.4 Read endpoint
`GET /api/servers/:id/metrics?metric&from&to` → `metricsResponse` (`contracts/metrics.ts`): resolution auto (≤ 6 h raw, ≤ 7 d 1m, else 1h), ≤ 2,000 points `[ts, avg, min, max]`, gaps omitted.
Auth until Phase 5: `Authorization: Bearer <DEV_ADMIN_TOKEN>` (dev only, refused when `NODE_ENV=production`, like the other dev settings). Phase 5 replaces it with the session cookie + "server belongs to user" check (404 otherwise). Errors use the app shape `{ error: { code, message } }`.

### 5.5 Seed data
`pnpm seed` (scripts/seed.ts): demo user `demo@tickdoctor.local`, 2 servers ("Pi Survival" on a Pi 5 profile, "Friends SMP" on a 4-core VPS profile), 30 days of realistic data: day/night player curves, healthy baseline, and lag episodes (entity build-up, a plugin update followed by degradation, a heap-pressure week, a hot afternoon with throttling) so Phase 4's detector and rules have something to find. Older days are written as rollups directly; the last 24 h as raw samples. Idempotent (`--reset` wipes demo data only).

## 6. Incidents, baselines, rules, findings (Phase 4, frozen)

Sources: `contracts/incidents.ts` (`DETECTOR`, `Baseline`, `Incident`), `contracts/findings.ts` (`Finding`, `RULE_IDS`, `RECHECK_DEFAULTS`), and the rule interface `apps/api/src/rules/types.ts` (`Rule`, `RuleContext`, `RuleFinding`).

### 6.1 Incident detection
- Inline after every metrics ingest, per server, samples in ts order. **Open**: MSPT p95 ≥ 50 ms for ≥ 30 s of consecutive samples. **Also open** when tps_1m < 18 for ≥ 90 s (`trigger: "tps"`; catches multi-second single-tick stalls such as chunk generation that p95 misses, found on the real Pi). **Close**: p95 < 40 ms and tps_1m ≥ 19 for ≥ 120 s (`recovered`), or no samples for 5 min (`offline`, ends at the last sample).
- Severity = worse of peak p95 (< 100 ms medium, < 250 ms high, ≥ 250 ms critical) and lowest tps_1m (< 15 high, < 10 critical). Incidents store `minTps1m` and `trigger`.
- Snapshot linking: a snapshot captured in [start − 60 s, end] is linked (`incident_snapshots.incident_id`, FK). No snapshot 30 s after opening → `servers.snapshot_requested_at` is set (the agent sends one with its next response).
- Backfill from 1-min rollups (`incidents:backfill`, run by the seed): bucket `mspt_p95_avg` ≥ 50 opens, two buckets < 40 close; `source = "rollup_1m"`.

### 6.2 Baseline
Built on open, stored on the incident and its snapshot. Healthy minute = 1-min rollup with `mspt_p95_avg` < 30, not within 10 min of an incident; looks back up to 7 days, takes the most recent ≤ 24 h of healthy minutes. Median + p90 per metric, per-type entity/tile medians and per-world medians from raw detail when still available, plugins/config/heap at the end of the window. < 30 healthy minutes → `null`, and rules then only use absolute thresholds.

### 6.3 Rules
One file per rule in `apps/api/src/rules/`, pure `evaluate(ctx) → RuleFinding[]`: no DB, clock or network. Scope `incident` runs when the incident's snapshot is linked (or after 90 s) and again on close. Scope `server` runs on every hello and every 5 minutes over the last 30 minutes. **A rule that fires on a healthy server is a bug:** every rule is tested against healthy seed windows and idle-Pi fixtures, not only against problem fixtures.

### 6.4 Findings lifecycle
Upsert per `(server, ruleId, dedupKey)` among non-confirmed rows: refresh evidence, `lastSeenAt`, `occurrenceCount`, append the incident id; a `marked_fixed` row that fires again goes back to `open`. Recheck job every 5 min: `marked_fixed` + rule silent for the window (server scope 15 min; incident scope 72 h, env `FINDING_RECHECK_INCIDENT_HOURS`) + fresh data in the window (config rules: see below) → `confirmed_fixed`, `resolvedBy: "owner"`. Server-scope findings still `open` whose condition stays absent for the window → `confirmed_fixed`, `resolvedBy: "auto"`. Incident-scope findings never auto-resolve.
- **Config rules** (`CONFIG_RULE_IDS`: jvm-flags, view-distance-too-high) need a hello received after the finding's `lastSeenAt` (the plugin sends hellos only at startup/plugin changes, and the owner may mark fixed after restarting); a pass on a hello older than `markedFixedAt` never reopens them.
- **One finding per (server, rule, dedupKey) across scopes**; a server pass seeing a dual-scope finding sets its scope to `server`.
- Live detection ignores samples older than the per-server watermark (repaired by backfill); store+detect are serialised per server; no offline close while newer stored samples exist (catch-up).

### 6.5 Tables
`incidents` (id, server_id FK cascade, started_at, ended_at, end_reason, severity, peak_mspt_p95, source, baseline jsonb, rules_evaluated_at, timestamps; partial unique index: one open incident per server). `findings` (the `Finding` fields; `evidence` jsonb; partial unique index on (server_id, rule_id, dedup_key) where status ≠ confirmed_fixed). `finding_incidents` (finding_id, incident_id). Retention: incidents and findings follow `incidentRetentionDays`, except open/marked_fixed findings, which are kept.

### 6.6 CLI (until the app API in Phase 5/6)
`incident:list <serverId>`, `incident:show <incidentId>`, `incidents:backfill <serverId> [--from --to]`, `finding:list <serverId> [--status]`, `finding:show <findingId>` (full text as an owner reads it), `finding:mark-fixed <findingId>`, `rules:run <serverId>` (server-scope pass now).
