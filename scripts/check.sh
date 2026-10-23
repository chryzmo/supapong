#!/usr/bin/env bash
# Runs every check: typecheck, unit tests, database tests, integration tests.
# The pre-commit hook runs this.  Run it yourself with `npm run check`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Git hooks started from an IDE may not have your shell profile, so point the
# Supabase CLI at Podman if there's no Docker and DOCKER_HOST isn't set.
if [ -z "${DOCKER_HOST:-}" ] && ! command -v docker >/dev/null 2>&1 \
  && [ -S "${XDG_RUNTIME_DIR:-}/podman/podman.sock" ]; then
  export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
fi

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

step 'Typecheck'
npx tsc --noEmit

step 'Unit tests'
npx vitest run --project unit

if ! npx supabase status >/dev/null 2>&1; then
  echo
  echo "✗ The local Supabase stack isn't running, so the database and integration"
  echo "  tests can't run.  Start it with \`npx supabase start\`."
  echo "  (To commit anyway: git commit --no-verify)"
  exit 1
fi

step 'Generated types match the local schema'
if ! npx supabase gen types typescript --local 2>/dev/null | cmp -s - src/database.types.ts; then
  echo "✗ src/database.types.ts is out of date with the local database."
  echo "  Run \`npm run gen:types\` (after \`npx supabase db reset\` if you added a migration)."
  exit 1
fi
echo 'ok'

step 'Database tests (pgTAP)'
npx supabase test db

step 'Integration tests'
npx vitest run --project integration

printf '\n\033[1;32m✓ All checks passed\033[0m\n'
