#!/usr/bin/env bash
# Sources the local Supabase instance's live keys (same approach as
# scripts/supabase-env.sh, used by `make up`/`make e2e-up`) and runs
# Playwright against them. Requires `make e2e-up` to already be running.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
eval "$(../scripts/supabase-env.sh)"
npx playwright test "$@"
