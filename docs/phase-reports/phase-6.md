# Phase 6 report: incidents UI + alerts (2026-11-13)

## What exists
- **Server tabs:** Dashboard · Incidents · Findings · Alerts · Settings on every server page. Incident bands on the dashboard graphs link to the incident.
- **Incidents list:** open first, then newest; severity, duration, slowest ticks, lowest TPS, finding count, top finding.
- **Incident page:** graph of the incident (±30 min, shaded), **"What changed?"** (during vs. this server's healthy baseline; notable = ≥ 1.5× with a minimum absolute change, or any plugin/config/memory change), findings in impact order, worst chunks with a copy-`/tp` button, timeline (plugin and config changes, starts, crashes).
- **Findings page:** filters, **Mark as fixed** (dialog explains the 15-minute / 72-hour watch and the restart note for config findings), undo, status chips (Open / Marked fixed – watching / Confirmed fixed by you / automatically), incidents listed by date.
- **Tuning tips** (severity info, one shared definition `isTuningTip`): only in their own "Tuning tips" section (findings page, collapsed on the dashboard); never among incident causes, never in alerts, never the server card's top finding.
- **Discord alerts:** one webhook per server; incident opened (≥ chosen severity, also when it gets worse later) / resolved, server offline / back online, crash; per-event cooldown, quiet hours (time zone, across midnight; critical incidents still come through), failed sends retried, a webhook Discord rejects is marked invalid and no longer called, every send or skip logged (30 days). Only discord.com webhook URLs; stored AES-256-GCM encrypted (bound to the server); never shown or logged in full; server names can't ping anyone. Alerts never slow down ingest. No false "offline" after an API restart.
- **Finding texts rewritten** after a copywriter review: plain words, "probably" where it's a guess, config-file steps under a collapsed "Optional, for when the simple steps aren't enough". Factual fixes: the entity finding names the real types (it said "mobs" for dropped items); `/kill … distance=` only works in-game (from the console it measured from spawn), with a console command limited to exactly one chunk for the default worlds; chunk-generation steps check force-loads/plugins first and the world border is optional with a warning; the memory tip says a restart is needed. Paper settings were checked against Paper's source: one villager setting is a no-op on current Paper (open Paper bug) and was removed, one unconfirmed one removed, the hopper setting's description corrected.
- **Your Phase 5 sign-up decision:** the sign-up page shows a sentence ("We'll email you a link to finish creating your account" + privacy link), no checkbox; the password page keeps the consent checkbox (the recorded consent). A new account via Discord gets a short "Finish creating your account" page with the same checkbox.

## Live tests (2026-11-13, your Pi "Overleven")
1. **Mark as fixed through the real UI button** — passed. Pi started with `-Xms1G -Xmx4G` → tip "starting memory and maximum memory are different" appeared within seconds (15:33 UTC) → memory back to 4G/4G + restart → **Mark as fixed** pressed in your app (15:37:58) → **Confirmed fixed, resolved by owner** at 16:02:14 (24 min: 15-min window + the 5-min recheck job). Heap drop-in back to the original checksum, server stopped + disabled.
2. **Discord alerts in a real channel** (`#tickdoctor-test` on Bouzelouf's server) — passed. Test alert sent (200) at 15:37; a real **"Overleven is offline"** alert went out at 16:08:14, 5½ min after the Pi stopped. A "back online" message follows the next time the Pi starts.
- Earlier the same day (Phase 5 demo): you signed up, ran the wizard, and watched "Overleven" turn green with the Pi's real data.

## Review and QA
- **Reviewer:** 1 HIGH, 7 MEDIUM, 12 LOW — all fixed except L1 (a possible duplicate alert if the API dies between Discord accepting a message and us logging it; documented). HIGH: every API restart would have sent false "offline" + "back online" alerts to everyone. MEDIUMs: failed alerts lost for good, critical-during-quiet-hours silent, "back to normal" when the server actually died, the console kill command hitting the main Nether for worlds like `creative_nether`, the copy-`/tp` button producing commands Minecraft rejects, a heavy incident endpoint polled every 30 s, Discord login failing for unconfirmed email sign-ups.
- **QA:** API 505 tests, lint, typecheck, plugin build green; Playwright 116 passed (50 skipped by design). New specs for incidents, findings (mark fixed / undo / 409s / tips only in their section), alerts (7 lookalike URLs rejected, URL never in any response or page, live incident → alert row, invalid webhook pauses alerts), IDOR, phone layout, accessibility. Bugs found and fixed: the incident page scrolled sideways on phones; form errors weren't announced to screen readers.
- An e2e run restarts the API to reset in-memory sign-up limits; during a live Pi session that briefly drops the dashboard's live connection (data isn't lost).

## Changes on your Mac / Pi
- **The Pi now sends data over its own Wi-Fi, not Tailscale.** Your Mac is a client of the Pi's access point (Mac `<mac-lan-ip>`, Pi `<pi-lan-ip>`). `.env`: `INGEST_BIND_IP=<mac-lan-ip>`, `AGENT_API_URL=http://<mac-lan-ip>:3001`; plugin `api-url: http://<mac-lan-ip>:3001` (backup `config.yml.bak-20261113-153234`). If the Mac gets another address or you switch networks, these three must change (or go back to Tailscale `<mac-tailscale-ip>`).
- Pi leftovers (harmless): heap backups `heap.conf.bak-20261113-152059` and `…-153250` next to the older one.
- Your account: confirmed, Pro, owns "Overleven" and "Pi (test history)" (Phase 2–4 history; old key revoked).

## For you
1. **Network:** keep the Pi-Wi-Fi route, or go back to Tailscale when you're not on the Pi's Wi-Fi? (Tailscale was off on the Mac today.)
2. **Discord channel:** `#tickdoctor-test` stays as the alert channel for "Overleven". Delete it or the webhook any time; the app then shows "alerts paused".
3. **OrbStack** still doesn't start by itself after a restart (it was down twice this week).
4. Still open from earlier: which rules are "basic" on Free; a cleanup policy for old open incident findings before go-public.

## How to look at it
```sh
cd ~/src/tickdoctor && docker compose up -d
open http://localhost:3000/app     # Overleven → Findings: the confirmed-fixed tip; Pi (test history) → Incidents
```

## Next: Phase 7 (status pages, docs, demo, legal)
`/s/[slug]` public status page + badge + Open Graph image, `/demo`, status-page settings; copywriter: all `/docs` pages, the findings reference (one page per rule), legal drafts, changelog.
