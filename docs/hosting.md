# Hosting options (Phase 8, 2026-11-13)

Nothing is deployed. This compares three ways to run TickDoctor once Michel decides. Prices are rough monthly
figures from public price lists as known in late 2026 — **check current prices before deciding**. EU hosting is
preferred (GDPR, French business, customers in Europe).

## What TickDoctor needs
- 4 containers: Caddy (TLS), web (Next.js), api (Node), Postgres 17 — `docker-compose.prod.yml` runs them all on one machine.
- Resources for the first ~100 servers: 2 vCPU, 4 GB RAM, 40–80 GB disk. Each monitored server sends a small batch every 10 s
  (~8,600 requests/day); raw samples are the main disk user (kept 1–7 days by plan, then rolled up).
- Outgoing email (confirmations, login links, resets, account-deleted) through a transactional provider.
- Backups of Postgres off the machine.
- A domain (TODO: final name).

## Option A — one small EU VPS + Docker Compose (recommended to start)
| Item | Example | ~€/month |
|---|---|---|
| VPS 2 vCPU / 4 GB / 40–80 GB | Hetzner Cloud (DE/FI), Scaleway (FR), OVHcloud (FR) entry plans | 5–12 |
| Off-site backups | Object storage (Scaleway / Hetzner / OVH), a few GB | 1–3 |
| Transactional email | Brevo (FR), Scaleway TEM (FR), Postmark — free/low tiers cover early volume | 0–15 |
| Domain | .com / .fr / .gg | ~1 (10–30/year) |
| **Total** | | **~€7–30** |

- **Pros:** cheapest, simple (`docker compose -f docker-compose.prod.yml up -d`), everything in one EU data centre, no vendor lock-in, the stack already runs exactly like this in dev.
- **Cons:** you run updates, backups and monitoring yourself; one machine = one point of failure (fine for a beta; restore from backup in ~30 min).
- **Setup outline:** create the VPS (Debian/Ubuntu), firewall: only 22 (SSH key only), 80, 443; install Docker; clone the repo; `cp .env.prod.example .env.prod` and fill it; point the domain's A/AAAA records at the VPS; `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`; copy plugin jars into `agent-jars/`; set up the email provider's SPF/DKIM/DMARC records; set `BACKUP_AGE_RECIPIENT` (see Backups below) and sync `backups/` to object storage nightly (e.g. `rclone`; the files are already encrypted); enable unattended security updates.

## Option B — managed containers + managed Postgres
| Item | Example | ~€/month |
|---|---|---|
| Container hosting (web + api, always on) | Scaleway Serverless Containers, Fly.io, Render, Railway | 10–30 |
| Managed Postgres with backups | Scaleway Managed DB, Neon, Supabase, Aiven | 10–25 |
| Transactional email + domain | as in A | 1–16 |
| **Total** | | **~€25–70** |

- **Pros:** no OS to maintain, automatic database backups and point-in-time restore, easier to scale later.
- **Cons:** 2–4× the cost; more moving parts (several dashboards, networking between services); some providers are US-based (check data location and DPA); the in-process live-update hub and alert dispatcher assume **one** API instance — keep the API at one replica until that's changed.

## Option C — the Raspberry Pi at home (private beta only)
| Item | ~€/month |
|---|---|
| Hardware (already owned) | 0 |
| Electricity (~5–8 W) | ~1 |
| Tunnel for public HTTPS (e.g. Cloudflare Tunnel, free) | 0 |
| Email provider + domain | 1–16 |

- **Pros:** almost free; good for a handful of friendly testers.
- **Cons:** home internet and power outages = TickDoctor outages (and servers buffer meanwhile); the Pi already runs the Wi-Fi AP, WireGuard and the test Minecraft server; SD/NVMe wear from Postgres writes; exposing a home machine to the internet; not suitable for paying customers.

## Recommendation
Start with **Option A** in France or Germany (e.g. a Scaleway or Hetzner VPS, ~€10/month all-in), with nightly encrypted off-site backups and an EU email provider. Move to B only when one machine isn't enough or uptime needs to be guaranteed. Use C, if at all, only for a private beta before the domain exists.

## Before going live (from docs/go-public.md)
Final name + domain, real contact email, legal pages reviewed (no longer drafts), the hosting provider and country named in the privacy policy and data-and-privacy page, email provider named, decision on the end of the beta, Discord app (optional), and **Michel's explicit go-ahead**.

## Backups (age, public-key encryption)

- **What:** the `backup` service runs `backup/backup.sh` nightly: `pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT` into `backups/tickdoctor-YYYY-MM-DD.sql.gz.age` (mode 600, directory 700), keeps about 14 days, deletes old files only after a successful backup. age gives authenticated encryption (ChaCha20-Poly1305): a modified file fails to decrypt, it is never silently accepted.
- **Key custody:** the server holds only the PUBLIC key (`BACKUP_AGE_RECIPIENT=age1...` in `.env.prod`), so a compromised server cannot read old backups. Generate the pair on your own machine, not the server: `age-keygen -o backup-identity.txt` (install: `brew install age` or `apt install age`). Keep `backup-identity.txt` (the `AGE-SECRET-KEY-...` line) offline in at least two places (password manager entry plus paper or USB). Lose it and every backup is unreadable. To rotate: generate a new pair, change the variable, `docker compose ... up -d backup`; keep the old identity for as long as old backups exist.
- **Verification without the key:** the server cannot decrypt, so the script checks the plaintext stream while encrypting (complete gzip, pg_dump's "dump complete" marker at the end, age header, non-empty) before moving the file into place. A real restore drill is still the only full proof: do one after setup and then each quarter.
- **Restore** (on a machine that has the identity file; copy the `.age` file from `backups/` or object storage):

  ```
  age -d -i backup-identity.txt tickdoctor-2026-11-14.sql.gz.age | gunzip > restore.sql
  # into an empty database (stop api/web first if restoring over production):
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c 'create database restored'
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres psql -U "$POSTGRES_USER" -d restored < restore.sql
  ```
- **Test:** `scripts/test-backup-roundtrip.sh` (scratch Postgres in docker: dump, encrypt, decrypt, restore and compare; tampered file, wrong key and failed dump must fail).
