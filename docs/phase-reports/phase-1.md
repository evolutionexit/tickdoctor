# Phase 1 report: landing page + waitlist (2026-11-09)

## What exists
- **`/`** landing page: hero led by the waitlist form, the problem, how it works, an example finding card (the real reusable `FindingCard` component), features, an honest comparison with spark / Plan / ServerAnalytics (Hangar, by clanme), pricing teaser, FAQ, final CTA.
- **`/pricing`** from `plans.ts`: Free / Pro €7 / Network €19, "Pro is free during the beta + founding discount" (exact terms = TODO), upgrade buttons open an early-access dialog with the waitlist form.
- **`/legal/privacy`, `/legal/terms`, `/legal/mentions-legales`**: stubs with a visible DRAFT banner (real drafts in Phase 7).
- Header (mobile menu, theme toggle), footer with the Mojang disclaimer, 404, error and loading states, robots.txt, sitemap, Open Graph image. Dark-first + light mode.
- **`POST /api/waitlist`** (Hono + Drizzle + Postgres), stores only email + source + timestamp.

## How to run it
```sh
cd ~/src/tickdoctor
docker compose up -d --build     # → http://localhost:3000   (Mailpit UI http://localhost:8025)
docker compose exec postgres psql -U tickdoctor -c 'select * from waitlist'
```
Tests: `pnpm --filter @tickdoctor/api test` (37) · `cd e2e && npx playwright test` (desktop + mobile, 67 pass / 3 skipped by design).

## Design decisions worth knowing
1. **Caddy is the single front door** (`Caddyfile`). It sends `/api`, `/v1`, `/badge`, `/downloads`, `/health` to the API and everything else to the website. Why: Next.js passes a client's own `X-Forwarded-For` header through unchanged, so the reviewer and I could bypass the per-IP rate limit by faking it. Caddy replaces that header with the real address. The API isn't reachable directly any more. Caddy also adds security headers (CSP, no framing…) and keeps no access log, so no IPs land on disk. The same setup is what we'll use in production.
2. **The waitlist never reveals who signed up**: new email, duplicate and bot (hidden honeypot field) all get the same `200 { ok: true }`.
3. **Abuse protection in layers**: Origin check (the CSRF guard for a form without a session), 5 requests / 10 min per IP, a global cap of 200 new signups per hour, 10 KB body limit.
4. **GDPR**: explicit consent checkbox enforced server-side, privacy link at the form, no IPs stored or logged. I removed the "unsubscribe with one click" promise because no such mechanism exists yet; the copy now says "you can ask us to remove your email at any time".
5. **Copy and pricing numbers can't drift**: pricing cards read limits from `plans.ts`; brand name, colours and disclaimer come from `brand.ts`.

## Review and QA
- **Reviewer** (Opus): 1 HIGH (rate-limit bypass, fixed with Caddy, re-verified live), 6 MEDIUM (all fixed: dockerignore, GDPR link + copy, input-border contrast now 3.6:1 dark / 3.9:1 light, Open Graph per page, hidden links to unbuilt pages, stale container), 8 LOW (fixed except: none blocking; security headers added; createApp prepared for later phases).
- **QA** (Sonnet): Playwright suite for landing, waitlist states (mocked + 1 real submission verified in Postgres), pricing dialog, legal pages, theme persistence, keyboard, SEO; no horizontal scroll at phone width, no console/CSP errors. Found 3 bugs (missing og:image on /pricing, hamburger visible on desktop, dialog focus) → fixed. I added 2 visual fixes from the screenshots ("1 days", orphan feature card). Final: **all green**.

## What you should look at
1. Open http://localhost:3000 and http://localhost:3000/pricing on your laptop **and phone-sized window**, in both themes. Screenshots: `e2e/screenshots/`.
2. Read the copy for tone: `apps/web/content/landing.md`, `pricing.md`.
3. The comparison table (fairness to spark / Plan / ServerAnalytics).

## Open items / TODOs for you
- Founding-discount terms (TODO in copy). Pricing FAQ answers for "what happens at the limit?" and "cancel/change plan" are hidden until written.
- Real domain + support email (`brand.ts` uses `tickdoctor.example`).
- Before the waitlist goes public: a real privacy policy (what's stored, purpose, retention, contact) and a way to remove emails. The legal pages are still stubs.
- Links to /docs, /demo, /changelog are hidden until Phase 7 (one flag in `apps/web/lib/site.ts`).
- Performance claim ("< 0.5 ms/tick") stays out until Phase 2 measures it.

## Next: Phase 2 (plugin MVP)
pi-ops first: move ServerTelemetry.jar to `plugins-disabled/`, check the Pi can reach the API on this Mac (IP stability, macOS firewall, client isolation; fall back to running the API on the Pi). Then I finalise the ingest contract as zod + JSON Schema, plugin-dev builds the plugin, pi-ops installs it and measures overhead.
