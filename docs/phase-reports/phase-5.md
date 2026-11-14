# Phase 5 report: app foundation (2026-11-10)

## What exists
- **Accounts:** sign-up, confirm by email, log in with password or an emailed login link, forgot/reset password, log out, log out everywhere. Discord login is built and tested against a mocked Discord, but it's off until a real Discord app exists (`DISCORD_*` in `.env.example`).
- **Servers:** create (key + config snippet shown once), list with health, rename, rotate key, delete (type the name), first-data check for onboarding, metrics and incidents for graphs.
- **Live:** `GET /api/servers/:id/live` (SSE through Caddy): a `sample` per stored push, a `status` event when health changes, at most 5 streams per user, closed at once on logout, password change/reset, server delete or transfer.
- **Plugin download:** `/downloads/agent/latest.jar` (newest jar from `agent/build/libs`, `X-Agent-Version` header).
- **Website:** auth pages, `/app` server cards, the onboarding wizard (name → key + jar + snippet → "Waiting for first data…" turning green live), the dashboard (live tiles, uPlot graphs 1h/24h/7d/30d with the 50 ms line and incident bands, host panel that hides metrics a server doesn't send, server info), server settings, account page. Phone layout, keyboard and screen-reader labels checked.
- **CLI additions:** `user:set-plan`, `server:transfer` (rotates the key unless `--keep-key`).

## The sign-up model (your change, 2026-11-10)
After the first review I proposed accepting a small takeover gap; you rejected it. Now:
1. **An unconfirmed account can't log in or hold a session.** Login answers exactly like a wrong password. A session that somehow belongs to an unconfirmed account is deleted.
2. **Sign-up is email + consent only.** The confirmation link opens a page that checks the link without using it; you press **Continue**, then choose your password (plus optional name, and the consent box again — that tick is the recorded one). The link is used up only when a valid password is saved. A password sent to sign-up is refused, never stored.
3. **Signing up again on an unconfirmed email** wipes the earlier attempt (password, name, sessions, tokens, Discord links) and sends a new link; old links stop working. All in one transaction.
- Every "send me a link" request for an unconfirmed account sends a confirmation link; login and reset links only go to confirmed accounts.
- Discord can only *create* an account after the consent box was ticked on `/signup`.
- Unconfirmed accounts without servers are deleted 7 days after the last sign-up attempt.
- Existing data: migrations 0006/0007 removed passwords, sessions, links and Discord links from unconfirmed accounts. The two CLI-created accounts (`demo@`, `michel@tickdoctor.local`) stay unconfirmed and own their servers.
- The focused re-review confirmed all three requirements hold.

## Review and QA
- **Reviewer, full review:** 1 HIGH (pre-registered email takeover → led to the model above), 6 MEDIUM, 10 LOW. All fixed: reset-password hashing before the token check and without rate limit (DoS), email links logging in on page load (scanners, account switching), live streams surviving logout/reset/delete/transfer, one viewer hiding a status change from another, two SSE streams per dashboard, IPv6 rate-limit bypass. LOWs included CSRF token rotation on login, a broken login label, the server switcher navigating while arrowing through it.
- **Reviewer, focused re-review of sign-up:** no HIGH; 3 MEDIUM (old Discord links on pending accounts, consent recorded at the wrong step, pending accounts kept forever) and 5 LOW (one transaction for sign-up, a confirm link working after confirmation, a Discord JSON error, timing differences, missing tests). All fixed.
- **QA:** API 431 tests, lint, typecheck, plugin build, Playwright 109 passed (37 skipped by design: desktop-only/mobile-only/Pi-only), all green. 19 new e2e tests in `e2e/tests/phase5-*.spec.ts`: the whole sign-up model incl. the takeover attempt, onboarding turning green live from a fake plugin, dashboard, settings (old key 401 after rotate), account, plan limit, another user's server (404), phone layout, accessible names. One small bug (a brand-new server's 24 h graph said "no data" for the first minute) — fixed: it now says the graphs are filling in, with a "Show the last hour" button.
- The "404 in the browser console during sign-up" web-dev once saw did not reproduce; the e2e test now records any 404 in that flow.

## Not verified
- **Your Pi through the wizard** (the phase's "exists" line: sign up, add the Pi through the wizard, see it turn green). Covered with a fake plugin pushing real-shaped data, not the real Pi. See "For you" 1.
- Discord (no real app), email rendering in real mail clients, real expiry timings (24 h / 15 min / 60 min / 7 days are unit-tested with an injected clock).

## For you
1. **Pi live demo.** To do it for real, the wizard's snippet must point to the Mac's Tailscale address (set `AGENT_API_URL=http://<mac-tailscale-ip>:3001` in `.env`), then: sign up in the browser, run the wizard, and pi-ops installs the new key on the Pi and starts the server for ~10 minutes. The Pi's current history stays on its old (CLI) server entry. Alternative: keep the Pi's server and history and move it into your new account with `server:transfer --keep-key`. Your choice, or skip.
2. **Consent is asked twice** (sign-up and the password page; the second is the recorded one). If you prefer once, the sign-up box could become a sentence ("By continuing you agree…") — but you asked for consent at sign-up, so I kept it.
3. **Account timing nuance:** "email me a login link" for an unknown email is a few ms faster than for a known one (one read vs. a write). Responses are identical and the send limits cap probing; documented in code.
4. **e2e repeatability:** the in-memory sign-up limit (10/hour/IP) means a second full e2e run within an hour needs `docker compose restart api`. A test-only switch could fix that later.
5. The local dev database has a few smoke-test users and servers from today's runs; harmless.

## How to look at it
```sh
cd ~/src/tickdoctor && docker compose up -d
open http://localhost:3000/signup      # mail arrives in Mailpit: http://localhost:8025
```

## Next: Phase 6 (incidents UI + alerts)
Incidents list, incident page with "what changed?", findings page, "mark fixed" through the real UI button (your Phase 4 decision), JVM tuning tips in their own section and never alerting, Discord alerts.
