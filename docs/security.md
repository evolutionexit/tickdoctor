# Security and privacy (Phase 8, 2026-11-14)

Scope: plugin (`agent/`), API, web, Caddy/compose, dependencies, git history. Method: a fresh read-only reviewer audited the code (not the phase reports), then every fix was re-checked by the reviewer. The penetration test (`docs/pentest-plan.md`) is a separate, later step and is not covered here. Data details: `docs/data-inventory.md`.

## Threat model
- **Attacker A: another tenant** (a logged-in user) trying to read or change someone else's servers, incidents, findings, alerts, status pages or account.
- **Attacker B: anonymous internet** (signup, login, reset, public status pages, badge, ingest with bad keys, webhooks/SSRF).
- **Attacker C: a malicious or compromised Minecraft server/plugin** sending hostile ingest data (huge payloads, XSS/Markdown payloads in names and exception text, a key used for another server).
- **Privacy risk: our own data** leaking personal data (players, server owners, hosts) through the plugin, the database, public pages, logs, backups or exports.
- Out of scope: a compromised host machine, Discord/Mojang themselves, the owner's own server operating system.

## Checked and held
- **Plugin:** collects no IP, server-ip/port, MOTD, hostname or interface name; no environment variables, RCON or raw configs (paper-world-defaults through an allow-list); sends no player identifiers; no auto-download, self-update or class loading; JDK default certificate checks; redirects refused; `http://` only to loopback/private/link-local/CGNAT/ULA addresses (public hosts need https); idle without a real key; key never logged; config and buffer files owner-only; `/tickdoctor` needs op.
- **Tenant isolation:** every `/servers/:id` route goes through one owner check (404 for foreign, unknown or malformed ids); incidents and findings join on `owner_id`; the live (SSE) hub re-checks session and ownership every 15 s and closes on logout/password change/delete; alerts, status page settings and deliveries use the authorised server id; the dev admin bearer is GET-only and refused in production.
- **SQL:** parameterised everywhere; the few `sql.raw`/`sql.identifier` uses take constants or enum-validated values.
- **Ingest:** 1 MB cap on the wire and after gunzip; zod validation with value-free errors; 256-bit keys stored as peppered sha256; revoked keys rejected; per-key limit; one snapshot per 2 minutes per server; no body or player data in logs.
- **Sessions and auth:** random 32-byte tokens stored as sha256; HttpOnly, SameSite=Lax, Secure in production cookies; new session on login; unconfirmed accounts never hold a session; CSRF = exact Origin + double-submit cookie with constant-time compare; scrypt N=2^15 with a dummy hash for unknown users; identical responses for signup/login/magic link/forgot/resend (no enumeration); per-IP and per-email limits that fail closed; single-use hashed email tokens; password change voids reset links, reset ends all sessions; `next` paths validated.
- **Webhooks:** strict Discord URL regex on save and before every fetch (SSRF guard), `redirect: "error"`, 5 s timeout; AES-256-GCM at rest with the server id as AAD; masked in responses, never exported or logged; messages escape Markdown/mentions and send `allowed_mentions: {parse: []}`.
- **Public pages:** status JSON built field by field from an allow-list (no IP, port or MOTD); unknown and disabled slugs give the same 404; badge XML-escaped with CSP `default-src 'none'`; `/demo` is a static dataset that a test keeps clean; no `dangerouslySetInnerHTML` with data.
- **Headers:** nosniff, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy; HSTS in production.
- **Account deletion:** one transaction removing the user, sessions, tokens, oauth links, servers and all per-server tables, the waitlist row and pending Discord signups.
- **Repository:** `.env` ignored; a search over the full history (149 commits at audit time) found only placeholders and fake test webhooks; lockfiles committed. (`gitleaks` itself was not installed: a real scan is on the go-public list.)

## Found and fixed
| ID | Sev | Finding | Fix (commit area) |
|---|---|---|---|
| H1 | HIGH | Per-IP ingest limit counted authenticated traffic: a Network-plan owner behind one NAT, or any customers sharing a hosting egress IP, got 429; spraying `Bearer junk` locked out neighbours | Key is checked first; only FAILED auth counts against the per-IP bucket (fail-closed when the limiter store is full) |
| M1 | MED | JVM flags only partly redacted and stored forever | Plugin allow-list (standard flags kept, other `-D` masked, agent/classpath/home-path flags dropped, IPs/URL logins removed) + server-side `scrubJvmFlag`; old history rows age out with the new retention |
| M2 | MED | Free-text scrub missed home paths, URL credentials, `key: value` secrets | Same rules in plugin `redactText` (messages and stack frames) and server `scrubText` |
| M3 | MED | Caddy logged client IP, URI with query and headers on aborted streams | ERROR level only plus a filter deleting IP, port, headers and query (3 Caddyfiles) |
| M4 | MED | Account export could pin the DB pool | At most 2 concurrent exports (429), statement/idle/transaction timeouts, 5-minute abort, release on client abort |
| M6 | MED | Hashed player ids sent but never used | No player ids sent at all (plugin 0.1.5); contract ping `id` optional/deprecated |
| L1 | LOW | Markdown/link injection through plugin names; `/\evil.com` redirect | `safe-link.ts` (app paths and an https host allow-list only) + `plainName()` for every agent-supplied name in finding text |
| L3 | LOW | Retention gaps | Superseded server info, stale plugin inventory (not current), revoked keys (30 days) pruned |
| L4 | LOW | Export incomplete | `lastSignupAt`, pending Discord signups added |
| L5 | LOW | Unhandled-error log could contain personal data | Logs method, path, error name and code only |
| L6 | LOW | Backups plaintext | Encrypted (now age, see L6b), mode 600; privacy policy wording TODO |
| L7 | LOW | Production accepted `COOKIE_SECURE=false` | Refused when `NODE_ENV=production` |
| L8 | LOW | `vcgencmd` lookup trusted relative PATH entries | Absolute entries only |
| L9 | LOW | Dependency advisories | `next>postcss` forced to 8.5.33; zod deferred (below) |
| L10 | LOW | Discord sign-in auto-linked to an existing account by email | Never auto-links: redirects to `/login?error=discord_email_exists`; linking only from the account page with a session |
| M3b | MED | Caddy error strings from reverse_proxy (`write tcp a->CLIENT_IP:port: broken pipe`) can embed a client address | IPv4/IPv6 addresses (with optional port) in the `error` and `msg` log fields become `[redacted]` (filter `regexp`, 3 Caddyfiles). In Caddy 2.10 that abort line is logged at WARN, so the ERROR level already drops it; the regexp is the second layer. Test: `scripts/test-caddy-log-redaction.sh` (real client abort through a scratch Caddy; unfiltered log leaks, filtered does not) |
| L6b | LOW | Backups used unauthenticated `openssl aes-256-cbc` with a passphrase stored on the server | `age` with an X25519 recipient (public key only on the server, private identity offline): authenticated encryption, server cannot decrypt its own backups. Plaintext never on disk; stream verified before the file is moved into place. Test: `scripts/test-backup-roundtrip.sh` (real pg_dump, restore compare, tamper and wrong-key fail) |
| Re-check (round 2) | MED/LOW | Export `HEAD` held a slot and spent the budget (now: HEAD answered first, one running export per user); backup pipeline did not stop on a failed dump (now `pipefail`, verified decrypt+gunzip, no cleanup on failure); secret scrub missed camelCase keys, JSON pairs, `Authorization`/`Bearer`, `td_` keys; `constructor`/`__proto__` keys from agent data in rules and incident code (`Object.hasOwn`, prototype-less counters); batches lost when shutdown closed the client mid-send (spilled to disk); log-capture idle race; leftover `salt.txt` deleted on enable; `-XX` command/path options and `-Xlog` file paths; repeated bad keys cost a DB lookup each (60 s bounded negative cache) | Fixed, each with a test |
| INFO | | `/og/__proto__` 500; prototype keys in query-driven lookups | `own()` (`Object.hasOwn`) |
| Plugin reliability | | Transient DNS failure stopped sending for good; HttpClient never closed; interrupted send logged a false error and skipped delivery; disk-write warning every second; log queue filled while idle; heartbeat only while collecting (wrong crash time) | Fixed in plugin 0.1.5, each with a test; counters surfaced in `/tickdoctor status` |

## Pentest findings (sandbox, rounds 1 + 2)

Fixed (full report: written by the lead later):
- F-03/B-01 (MEDIUM): unbounded ingest numbers and control characters reached Postgres and gave a 500. Counts are bounded to int4 (sums clamped), byte counts to safe integers, strings and record keys are cleaned of control characters, unstorable values return 400, the plugin clamps its own values. Commit 35eb789.
- F-05 (INFO): `Cache-Control: private, no-store` is the default on authenticated `/api` responses (public status, badge, downloads, export keep their own). Commit 466e8c1.
- F-06/F-01 (INFO): `Cross-Origin-Opener-Policy`, `X-Permitted-Cross-Domain-Policies` and `Cross-Origin-Resource-Policy` on pages; badges, OG images, downloads and public status JSON explicitly `cross-origin`; no COEP. Commit 3ea2175.

## Open / deferred (decided by Michel)
- **M5, personal infrastructure details in git history** (Tailscale addresses/name, SSH user, home paths): current files are scrubbed and the values live in a gitignored local notes file; history is NOT rewritten. Go-public: squash into a fresh repo first.
- **L2, CSP `script-src 'unsafe-inline'`:** nonce-based CSP before paid launch.
- **L9, zod 3.25.76 (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections):** deferred because every input we validate is already bounded before zod sees it (1 MB ingest and 10 KB other JSON body caps, explicit `.max()` on every array and string in the contracts), so the advisory's amplification case cannot be reached; the patched line is zod 4 (a migration). Revisit with the zod 4 migration. `esbuild`/`minimatch` advisories are dev-only.
- **Gradle:** no dependency locking/verification metadata. Low risk: the plugin has only `compileOnly` dependencies, nothing shaded, wrapper checksum pinned.
- **Real `gitleaks` scan of the full history:** go-public checklist.
- **Backups:** deleted accounts stay in encrypted backups up to 14 days (privacy policy TODO).
- **Unconfirmed-account takeover via Discord:** a Discord sign-in matching an UNCONFIRMED local account still goes to the pending signup (takeover only on `/discord/complete` with consent). Such an account has no session and no data; Discord's verified email proves the inbox.
- **Existing data is not re-scrubbed:** JVM flags stored before this change stay raw until each server's next hello; old history rows age out with the new retention.
- Known residual privacy risk: offline players' names in old exception messages (documented; goes into the privacy policy at go-public).
- **Discord OAuth state cookie** is unsigned and has no `__Host-` prefix (pre-existing): cookie tossing from a same-site subdomain could link an attacker's Discord to a victim session. Not exploitable without a controlled sibling subdomain; sign it (HMAC) or use a `__Host-` name before go-public.
- **Backups keep about 15 days** (`-mtime +14`, privacy-policy wording says 14 days at most; acceptable, tighten if the policy needs it).
- **Backfill:** hellos stored before the fixes keep raw flags until the next hello; run a one-off `scrubJvmFlag` backfill over `server_info_history` (or wipe dev data) before go-public.
- **Penetration test:** planned as the last Phase 8 step, not yet run.
