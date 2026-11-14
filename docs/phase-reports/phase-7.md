# Phase 7 report: status pages, docs, demo, legal (2026-11-13)

## What exists
- **Status page settings** (new server tab "Status page"): on/off (off by default), address `/s/<slug>` (rules + reserved words incl. brand words like `tickdoctor-status`, checked while typing), title, what to show (players, uptime, recent incidents), theme, hide branding (paid plans only), badge preview + copyable Markdown/HTML embed.
- **Public status page `/s/<slug>`:** state (icon + word + colour), last seen, players, uptime 24 h / 7 d / 30 d, recent incidents — each only when the owner switched it on. "Monitored with TickDoctor" line on Free. Discord preview image (1200×630, bundled font, no outside requests). `noindex` until go-public. Unknown and switched-off pages give the same real 404.
- **Badge** `/badge/<slug>.svg`: "minecraft | online · 12 players", escaped, cached 60 s, grey "unknown" when off.
- **Public data never includes:** player names/ids, IPs, plugins, findings, owner, server id, exact host metrics, cookies.
- **`/demo`:** dashboard, incidents, incident page and findings for the made-up **"Creeper Hollow SMP"**, built only from a committed file (`apps/web/content/demo/dataset.json`, 329 KB) exported and cleaned from "Pi (test history)" (fake ids, relative times shifted to "now", unknown plugins renamed, generic host info, no player data). No network calls — works with your Mac and Pi offline and once deployed. A test checks the committed file stays clean. Regenerate with `cli demo:export <serverId> --name "<name>"`.
- **Docs:** home, install, configuration, data and privacy, troubleshooting, FAQ; one page per finding (11); changelog. Header links Docs, Demo, Changelog, **Sign up**.
- **Legal drafts:** privacy, terms, mentions légales (French) — each with a big "DRAFT — not legally reviewed" banner and TODOs; privacy matches what we actually store (checked against the schema, cookie lifetimes against the code).
- **Plugin 0.1.4:** user-facing messages without developer jargon; config file created readable only by the server user (no confusing permissions warning on a new install); "last push" survives `/tickdoctor reload`. The app serves it. The Pi still runs 0.1.3 (fine; update any time).
- **Graphs:** multi-second freezes no longer flatten the MSPT graph — taller spikes are clipped with a marker and their real value.
- **Infra (your Phase 6 points):** every compose service `restart: unless-stopped`; the Pi's data entrance is a separate ingest-only container (only `/v1`, `/health`, `/downloads`), so a late Tailscale at boot never takes down http://localhost:3000.

## Network (your decision)
Back on Tailscale, by name: plugin `api-url: http://<mac-magicdns-name>:3001`. MagicDNS stays off on the Pi; the name comes from **one line in the Pi's `/etc/hosts`** (`<mac-tailscale-ip> <mac-magicdns-name>`, backup `/etc/hosts.bak-20261113-171715`). Documented in `docs/pi-test-server.md`, the local project notes. Verified: 14 sends with 200 by name; Discord "back online" alert delivered.

## Install docs test (your request)
qa followed `/docs/install` word for word as a new user on a **throwaway Paper server on the Pi** (fresh folder with only the Paper jar copied, Paper created `eula.txt`/`server.properties` itself, port 25599, 2 GB heap; real server stopped + disabled throughout, 48–49 °C). Result: works end to end — "connected", app shows the server HEALTHY. The wrong-key case and `/tickdoctor reload` behave exactly as the docs say. Fixed from its findings: no sign-up link (guide + header now link it), consent sentence now names the Terms, EULA note for brand-new servers, key order and `localhost:4000` default explained, the "Create server" button name, the first-start permissions warning (plugin 0.1.4), "Last push: never" after reload (0.1.4).
**Cleanup confirmed:** `$PI_HOME/td-docs-test` is gone, no test process left, real server inactive + disabled; the test account and server are deleted from the database (0 rows anywhere). Your account owns only "Overleven" and "Pi (test history)". (The tester printed the throwaway account's key once in its own log; that account is deleted.)

## Review and QA
- **Reviewer:** 3 HIGH, 3 MEDIUM, 9 LOW — all fixed.
  - HIGH: all status pages shared one rate-limit bucket (≈60 requests to random addresses would have blocked every status page) → the visitor's real address is forwarded; verified with a flood test (only the flooding address is limited, and it sees "Too many requests, try again in a minute" instead of an error). Free-plan 30-day uptime would have shown ~23 % for an always-up server → windows the plan can't cover show "Not enough data yet, or not kept on this plan". Uptime 0 % for servers whose raw data expired (first-sample time came from arrival, not sample time) → fixed; the test server now shows 1.7 %.
  - MEDIUM: uptime assumed a 10 s sample interval (now uses the server's real interval), unknown pages answered 200, a switched-off page could show old data once more.
  - LOW: badge security headers, control/RTL characters in titles, rate-limited badge image, brand-word squatting, snippet escaping, preview image fetching fonts from Google with the title, Pi hardware details in the demo file, two doc wording issues.
- **QA:** API 555 tests, lint, typecheck, plugin build green; Playwright 120 passed (2 failures were the bugs below, now fixed and re-run green). New specs: status page settings, public page + JSON + badge, rate limit, demo (no network), all docs/finding/legal pages, docs-vs-product walk, phone + accessibility. Bugs found and fixed: an uptime undercount in the first hour of a server's history, the "Connected" panel missing software/plugin version, a duplicate skip link, brand-word names only rejected on save.

## For you
1. **Beta plan wording:** the landing and pricing pages say "Pro is free for everyone during the beta", but new accounts start on Free. Either new accounts get Pro during the beta, or the pages drop that line. Your call; nothing changed yet.
2. **Go-public TODOs** (in the legal drafts and docs, all marked TODO): your legal name, address, SIRET or "sans objet", VAT, publication director, DPO decision; a real contact email (`hello@tickdoctor.example` is shown on troubleshooting/privacy); hosting provider and country; email provider; access-log and backup policy; legal checks (legal bases, cookie exemption, age, liability, governing law/mediator, withdrawal); plugin licence; trademark check of the name (a "LagDoctor" exists); which findings are "basic" on Free.
3. **Plugin on the Pi:** 0.1.3 runs fine; say if pi-ops should install 0.1.4.
4. Your Chrome auto-translates the app to Dutch; the app itself is English (cosmetic, your browser setting).

## How to look at it
```sh
cd ~/src/tickdoctor && docker compose up -d
open http://localhost:3000/demo            # demo, no Mac/Pi data needed
open http://localhost:3000/docs/install
open http://localhost:3000/app             # Overleven → Status page tab
```

## Next: Phase 8 (polish + go-public prep)
Full security + GDPR audit, full e2e/mobile/accessibility pass, plan limits, account export and delete, SEO + Open Graph images, Dockerfiles, `docker-compose.prod.yml`, `docs/hosting.md` (no deploy).
