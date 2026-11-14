# Data inventory (Phase 8, 2026-11-14)

Every piece of data the plugin sends, the API stores, public pages show, and logs write, why it is needed, and how long it is kept. Source: fresh code audit (see `docs/security.md`), updated for the fixes made after it. The privacy policy and `/docs/data-and-privacy` must match this file.

**Never collected:** IP addresses (server or player), server-ip/port, MOTD, hostnames, network interface names, environment variables, RCON settings, raw config files, player UUIDs, player names, player identifiers of any kind (hashed or not; since plugin 0.1.5).

## Accounts and sessions
| Data | Where | Why | Kept |
|---|---|---|---|
| Email | `users.email`, `waitlist.email` | login, mail | account lifetime. Waitlist rows without an account: no limit and no self-removal yet (go-public item) |
| Display name (optional) | `users.display_name` | greeting | account lifetime |
| Password hash (scrypt) | `users.password_hash` | login | account lifetime |
| `email_verified_at`, `consent_at`, `created_at`, `last_signup_at`, `plan` | `users` | consent record, limits, purge of stale pending signups | account lifetime (all in the export) |
| Session id hash, created/last used/expires (no IP, no user agent) | `sessions` | login | at most 30 days, purged hourly |
| Email token hash, kind, next path, times | `email_tokens` | confirm / magic link / reset | until expiry or 1 day after use |
| Discord user id (+ email in pending signups) | `oauth_accounts`, `discord_pending_signups` | Discord login/linking | account lifetime / 10 minutes. No Discord tokens are stored |

## Servers and plugin data
| Data | Source, where | Why | Kept |
|---|---|---|---|
| Server name, slug, plan, seen timestamps, boot id | owner/agent, `servers` | dashboard, health | until server/account deleted |
| API key: peppered sha256 + 12-char prefix | `api_keys` | agent authentication | active: server lifetime. Revoked: pruned after 30 days |
| Hello: software/version, MC version, online-mode, max players | agent, `server_info_history` | findings, public "max players" | superseded rows pruned after the plan's incident retention |
| Hello: JVM version/vendor, heap, CPUs, **flags (allow-list)** | agent, `server_info_history` | jvm-flags rule | same. Flags: standard `-X*`/`-XX:*`/`-Xlog*` kept, other `-D` values masked, agent/classpath/home-path flags dropped; scrubbed again server-side |
| Hello: OS name + kernel, arch, device model, RAM | agent, `server_info_history` | host rules | same |
| Hello: view/sim distance, activation ranges, allow-listed paper-world-defaults | agent, `server_info_history` | rules | same |
| World names + environment | agent, samples, snapshots | per-world stats, /tp hints | plan retention |
| Plugin name/version/enabled | agent, `server_info_history`, `plugin_inventory_history`, events | plugin-change and exception rules | inventory rows not in the current hello are pruned after the incident retention |
| Tick stats (TPS, MSPT avg/p95/p99/max, slow ticks) | agent, `metric_samples` + rollups | core product | raw 1-7 days, rollups per plan |
| Online player **count**; average ping value | agent, samples | lag vs players | plan retention. No player ids are sent |
| JVM heap/GC/threads/CPU; entities and tile entities by type; loaded chunks; chunk generation; worst chunks (world, x, z) | agent, samples/snapshots | findings | plan retention |
| Host: load, CPU %, temperature, throttled flags, memory/swap/disk use, disk and network throughput (totals only) | agent, samples | host rules | plan retention |
| Exception events: plugin guess, class, message, stack hash, 5 frames | agent, `events` | plugin-exceptions rule | rollup retention. **Scrubbed twice** (plugin and API): IPs, UUIDs, URL credentials, `key: value` secrets, home-folder names |
| Crash / stop detail, can't-keep-up, plugins-changed, join/leave **counts** | agent, `events` | incidents, alerts | plan retention (scrubbed like exceptions) |
| Incident snapshots (sample, per-world detail, thread names/CPU, recent events) | agent, `incident_snapshots` | incident evidence | incident retention |
| Incidents, findings, analysis state | derived | product | incident retention |

## Alerts, status pages, public output
| Data | Where | Why | Kept |
|---|---|---|---|
| Discord webhook (AES-256-GCM, server id as AAD) + masked display | `alert_configs` | Discord alerts | server lifetime. Never in responses, exports or logs |
| Alert preferences; deliveries (status, HTTP code, own error text) | `alert_configs`, `alert_deliveries` | alerts | config: server lifetime; deliveries 30 days |
| Status page: slug, title, toggles, theme | `status_pages` | public page | server lifetime |
| **Public status JSON / page / OG image** | API to anyone | status | live: title, state, last seen, optional players online/max, optional uptime 1/7/30 d, optional incident start/end/severity, theme, branding. Allow-list built field by field. **No IP, port or MOTD.** |
| **Badge** | API to anyone | README badge | title + state word only |
| **/demo** | static JSON in the repo | marketing | fake ids; a test checks it stays clean |

## Logs and transient data
| Data | Where | Kept |
|---|---|---|
| Client IP | in-memory rate-limit keys only (IPv6 as /64) | at most 1 hour, RAM only, never written |
| Caddy logs | ERROR level only; IP, port, headers and query string stripped from entries, and IPv4/IPv6 addresses inside `error`/`msg` text replaced by `[redacted]` (all three Caddyfiles; `scripts/test-caddy-log-redaction.sh`) | container log, rotated |
| API logs | ingest summaries (counts, p95, 8-char server/boot prefixes), mail recipient domain only, alert status, unhandled errors as `METHOD path name code` only | container log, rotated |
| Plugin console | status lines; with `debug-log-payloads` only sizes and kinds; no key ever logged | the owner's server |
| Plugin disk buffer | `plugins/TickDoctor/` (mode 600, at most 50 MB) | until delivered |
| Backups | nightly `pg_dump` | **encrypted with `age` (authenticated, public key only on the server; private identity offline), mode 600, about 14 days.** Deleted accounts remain in backups until they age out (privacy policy TODO) |

## Account export and deletion
Export (`GET /api/account/export`, streamed, 3/hour/user, 2 at a time globally): account details incl. `lastSignupAt`, Discord link, sessions (no ids), waitlist entries, pending Discord signups (no token hash), servers with key prefixes (no hashes), info/plugin history, status page settings, alert config (webhook masked), incidents, findings. Never: password hash, key hashes, webhook address.
Deletion (`DELETE /api/account`, one transaction): user, sessions, tokens, oauth links, servers and every per-server table, waitlist row by email, pending Discord signups. Already-posted Discord messages stay in Discord. Backups: see above.
