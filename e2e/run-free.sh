#!/usr/bin/env bash
# Free-plan pass: restarts the dev API with BETA_ALL_PRO=false, runs the @free tests, restores the API afterwards (always).
set -u
cd "$(dirname "$0")/.."
trap 'docker compose up -d api >/dev/null 2>&1; sleep 8; echo "api restored (BETA_ALL_PRO from .env)"' EXIT
BETA_ALL_PRO=false docker compose up -d api >/dev/null 2>&1
sleep 8
curl -sf localhost:3000/health >/dev/null || { echo "api not healthy"; exit 1; }
set -a; . ./.env; set +a
cd e2e && BETA_ALL_PRO=false npx playwright test --project=freeplan "$@"
