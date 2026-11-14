# TickDoctor (working name)

Find out why your Minecraft server lags — in plain English.

> Status: Phase 1 done (landing page + waitlist). See `docs/architecture.md` and `docs/phase-reports/`.

## Requirements
- Node 22+, pnpm (`corepack enable pnpm`)
- Postgres 17 + Mailpit: via Docker (setup A) or installed natively (setup B)
- JDK 25 (only to build the plugin in `agent/`). On Michel's Mac: Temurin in `~/.local/jdk/current`, `java`/`javac` symlinked into `~/.local/bin`.

## Setup A: Docker (default; OrbStack on the Mac)
```sh
cp .env.example .env
docker compose up -d --build   # caddy + web + api + postgres + mailpit → http://localhost:3000
```

## Setup B: no Docker (native Postgres + Mailpit)
```sh
brew install postgresql@17 mailpit
brew services start postgresql@17
brew services start mailpit
createuser -s tickdoctor && psql -d postgres -c "ALTER USER tickdoctor PASSWORD 'tickdoctor'"
createdb -O tickdoctor tickdoctor
cp .env.example .env     # defaults already point at localhost:5432 and localhost:1025
pnpm install && pnpm dev # api + web on the host
```

Docker: everything at http://localhost:3000 (Caddy routes /api and /v1 to the API). Native: web http://localhost:3000, API http://localhost:4000 (Next.js forwards /api). Mailpit UI http://localhost:8025.

## Tests
```sh
pnpm --filter @tickdoctor/api test
cd e2e && pnpm install --ignore-workspace && npx playwright install chromium && npx playwright test
```

## Layout
| Path | What |
|---|---|
| `agent/` | Paper plugin (Java 25) |
| `apps/api` | API: ingest, storage, incidents, rules, auth, alerts |
| `apps/web` | Website: marketing, docs, dashboard, status pages |
| `packages/shared` | Contracts, brand, plans |
| `e2e/` | Playwright tests |
| `scripts/seed.ts` | Realistic fake data |
| `docs/` | Architecture, contracts, hosting, phase reports |

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
