# Go-public checklist (landing page + waitlist)

**Not now.** Do this once Michel picks the final name. Nothing gets bought, deployed or published before he says go.
Prices below were checked on 2026-11-09 from third-party summaries. Check the provider's own pricing page before choosing.

## 0. Security and repo hygiene (before ANY public step)
- [ ] **Squash into a FRESH repo** before making anything public. The current history contains personal infrastructure details (Pi SSH address, Tailscale IPs and MagicDNS name, home paths) and was not scrubbed. Do not just flip this repo to public.
- [ ] **Run a real `gitleaks` scan** of the fresh repo before it goes public. First real run 2026-11-14 on this repo (gitleaks via docker, `detect --log-opts=--all`, 228 commits): 2 hits, both test fixtures (a fake pepper in `apps/api/test/auth.test.ts` and a fake agent key constant in `apps/api/test/ingest.test.ts`), no real secrets. Add a `.gitleaksignore` for them in the fresh repo.
- [ ] **CSP: remove `'unsafe-inline'`** by moving to a nonce-based CSP. **BEFORE PAID LAUNCH** (can wait for the free waitlist phase).
- [ ] **zod 3.25.76 advisory GHSA-mrhx-c7xc-m3w5 is deferred** (see `docs/security.md` once written). Revisit with the zod 4 migration.

## 1. Name, domain, sender email
- [ ] Final product name + tagline in `packages/shared/src/brand.ts` (`name`, `domain`, `supportEmail`) — everything else reads from there.
- [ ] Register the domain (~€10–15/year for a .com/.dev/.gg at most registrars).
- [ ] Sender address, e.g. `hello@<domain>` (receiving) and `noreply@<domain>` (sending). Set up SPF, DKIM and DMARC DNS records for the chosen email service.
- [ ] Run a sweep for leftover "TickDoctor" / `tickdoctor.example` strings.

## 2. Double opt-in for the waitlist
Flow: submit form → row stored as `pending` → email with **confirm** link and **remove me** link → confirmed rows only are "on the list"; pending rows deleted after 7 days. Every later email carries a removal link. Removal really deletes the row.
**Explicit gap:** waitlist rows without an account currently have NO retention limit and no self-removal. The double opt-in work above must add both (removal link, retention maximum), and the privacy policy must state the maximum.
Code work (backend-dev + web-dev, ~half a day): `waitlist.status`, `confirmed_at`, single-use hashed tokens (reuse the `email_tokens` design), `/api/waitlist/confirm`, `/api/waitlist/remove`, two small pages, Mailpit tests in dev. The "same response for everyone" rule still applies.

Transactional email options (free tiers):

| Service | Free tier | Paid entry | Notes |
|---|---|---|---|
| **Resend** | 3,000/month, max 100/day, 1 domain | ~$20/mo for 50k | Simplest API, good Node SDK. 100/day could bite on a Reddit-launch day: excess sign-ups would wait for their email. |
| **Brevo** | 300/day (shared with marketing mail) | from ~€9/mo | EU (French) company: convenient for GDPR/data location. Free plan adds Brevo branding; account approval step. |
| **Postmark** | 100/month (testing only, no overage) | ~$15/mo for 10k | Best deliverability reputation; free tier is too small for a launch, but cheap once paying. |

**Recommendation:** Brevo for the waitlist phase (EU, 300/day is enough for a launch spike, free), keeping the code provider-agnostic via SMTP (nodemailer is already the plan) so switching to Resend/Postmark later is a config change.

## 3. Privacy policy that matches reality
- [ ] Rewrite `/legal/privacy` from what the waitlist actually stores: email, source, timestamps, confirmation status. No IPs (Caddy keeps no access log; rate limiting is in memory only).
- [ ] Purpose (early-access emails), legal basis (consent), retention (e.g. deleted at launch +3 months or on request; pending unconfirmed rows after 7 days), processors (email service, host), contact address, right to access/delete, CNIL complaint right.
- [ ] Mentions légales: publisher identity (student, France) — TODO legal check; hosting provider's details.
- [ ] **Backups:** the policy must say that deleted accounts stay in encrypted backups for up to 14 days (nightly backups, 14-day retention), then are gone. (Placeholder TODO already in `apps/web/content/legal/privacy.md`.)
- [ ] Consider storing a `consent_text_version` with each signup (proof of consent, GDPR Art. 7(1)).

## 4. Founding-discount terms
- [ ] Exact terms (percentage, duration, who qualifies, e.g. "confirmed waitlist members before launch date X") → replace the TODOs in `apps/web/content/pricing.md` and `landing.md`.

## 5. Minimal hosting (landing + waitlist only)
Only caddy + web + api + postgres from `docker-compose.yml` are needed; no plugin traffic yet.

| Option | Rough cost | Pros | Cons |
|---|---|---|---|
| **A. One small VPS** (e.g. Hetzner shared-vCPU entry plan, EU) running the existing compose file; Caddy gets TLS automatically | ~€5–6/month + domain | Same setup as dev, EU data location, room for the real app later, full control | You maintain the box: updates, backups (nightly `pg_dump` to object storage, ~€1/mo) |
| **B. Free tiers split up**: static-exported landing on Cloudflare Pages, API on a free container host (Fly.io/Render), Postgres on Neon free | €0 + domain | No server to maintain | More moving parts, cold starts on free API hosts, free-tier terms change often, CORS/origin setup differs from dev |
| **C. The Pi via Cloudflare Tunnel** (cloudflared is already installed on the Pi; a tunnel opens no router ports) | €0 + domain | Free, hardware you own | Home uplink capped ~90 Mbit/s, student-housing network/power outages = site down, mixes production with the test server. Needs Michel's explicit OK (Pi rules). |

**Recommendation:** A. It's the cheapest option that behaves exactly like what we test locally, and it grows into the full product without a migration.

Sources: Resend/Brevo/Postmark/Hetzner pricing summaries (automationatlas.io, costbench.com, dreamlit.ai, kuberns.com), retrieved 2026-11-09.

## 6. Decision: end of the beta
Today `BETA_ALL_PRO=true` gives every account Pro limits (stored plans unchanged). Ending it is a product decision with user-facing promises already in the copy ("we'll announce the date", "we email a warning", "founding discount applies", "history older than Free's retention is trimmed"). Free keeps: 1 server, detailed samples 1 day, per-minute 3 days, hourly 7 days, incidents and findings 7 days.
- [ ] **TODO (Michel): beta end date.** Then fill it into the account note, pricing, privacy policy §7 and terms §6 (all say "we'll announce the date" until then).
- [ ] **TODO (Michel): warning emails.** Timing, e.g. 30 days and 7 days before. Write the email text (copywriter), build the send (once per account, skip deleted accounts), and add a banner on the account page.
- [ ] **TODO (Michel): founding-discount terms and deadline** (amount, duration, who qualifies, last day to claim). Replace the TODOs in `pricing.md` and `landing.md` and the beta note in `phase8-copy.md`.
- [ ] **BLOCKER FOR ENDING THE BETA (`BETA_ALL_PRO=false`) OR LAUNCHING PAID PLANS — not for going public with the beta.** Build as one small task once the product name is settled: **downgrade handling** (decided 2026-11-14):
  - **Grace + history:** data stays 14 days after a plan ends or is downgraded, then anything older than the Free plan's history is trimmed; an email warns BEFORE it happens (tell users to export first). Today the retention job trims by the server's plan immediately, so ending the beta would cut history at once. Build: a `downgraded_at` on the user, retention uses the higher plan until `downgraded_at + 14 days`; warning email (copywriter text, once per downgrade, skip deleted accounts, banner on the account page).
  - **Extra servers (Free allows 1):** the owner picks which server stays active (default: the oldest). The others are PAUSED: ingest answers with a clear "server paused, plan limit" response that the plugin shows in `/tickdoctor status` (contract + plugin change), the app marks them paused, their history follows Free retention, and they are deleted after 30 days paused, with emails at the start of the pause and 3 days before deletion. Upgrading again unpauses them immediately. Needs: `paused_at` on servers, the chooser UI, ingest response + contract (`docs/contracts.md`), plugin status line, retention/deletion job, two emails, tests (API, plugin, e2e).
  - The pricing FAQ and `/docs/data-and-privacy` already describe this (`apps/web/content/pricing.md`, TODO comments mark it as not built). Don't publish those answers beyond the beta before it exists.
- [ ] Extra servers on downgrade: decided (owner picks the active server, others paused, deleted after 30 days paused); see the blocker item above. Not built.
- [ ] Set `BETA_ALL_PRO=false` in production env on the end date, restart the API, check that the account page no longer says "Pro (beta)" and that limits apply.
- [ ] Update copy that says "Free during the beta" (landing, pricing, changelog entry for the end of the beta).
- [ ] Add a changelog entry the day the beta ends.

