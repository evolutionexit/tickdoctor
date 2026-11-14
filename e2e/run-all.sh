#!/usr/bin/env bash
# Full e2e: desktop + mobile (beta switch as in .env) and then the Free-plan pass (switch off). Run `docker compose restart api` first if a full run happened in the last hour.
set -u
cd "$(dirname "$0")"
set -a; . ../.env; set +a
npx playwright test --project=desktop --project=mobile; a=$?
./run-free.sh; b=$?
exit $((a || b))
