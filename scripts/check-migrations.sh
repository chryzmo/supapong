#!/usr/bin/env bash
# Fails if the hosted database is missing any migration in
# supabase/migrations.  CI runs this before deploying, because a frontend
# that needs a new table, view or function would break against an older
# schema.  Run it yourself with `make db-check`.
#
# Needs either a linked project (`make supabase-link`) or SUPABASE_PROJECT_REF,
# plus SUPABASE_ACCESS_TOKEN in CI.  It only does a dry run: nothing is applied.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  target=(--project-ref "$SUPABASE_PROJECT_REF")
elif [ -f supabase/.temp/project-ref ]; then
  target=(--linked)
else
  echo "✗ No hosted project to check.  Set SUPABASE_PROJECT_REF, or run \`make supabase-link\`." >&2
  exit 1
fi

# fail <message> <summary markdown> [title]
# In GitHub Actions, also show the problem as an annotation and in the run summary.
fail() {
  local title=${3:-Migration check failed}
  echo "✗ $1" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=$title::$1"
    { echo "### ✗ Not deployed: ${title,}"; echo; printf '%s\n' "$2"; } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

# Locally the CLI falls back to your `supabase login`, but CI has only the
# token it's given.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  fail "SUPABASE_ACCESS_TOKEN isn't set." \
    "Add a Supabase access token as the \`SUPABASE_ACCESS_TOKEN\` secret in the repository's \`production\` environment, then re-run this job."
fi

# The CLI also errors when the two histories disagree (a migration on the
# hosted project that isn't in the repo, or an older one that was never
# applied), and that should stop a deploy too.  In JSON mode its errors go to
# stdout as {"_tag":"Error","error":{"message":...}}, so pull the message out.
if ! result=$(npx supabase db push --dry-run "${target[@]}" --output-format json --agent no); then
  message=$(node -e '
    try { console.log(JSON.parse(process.argv[1]).error.message); } catch { console.log(process.argv[1]); }
  ' "$result")
  fail "Couldn't compare migrations with the hosted project: ${message:-no output from the Supabase CLI}" \
    "$(printf 'The Supabase CLI said:\n\n```\n%s\n```\n\nCheck the `SUPABASE_ACCESS_TOKEN` secret and the `SUPABASE_PROJECT_REF` variable in the `production` environment.\n' "${message:-no output}")"
fi

pending=$(node -e '
  const result = JSON.parse(process.argv[1]);
  if (result.upToDate !== true) console.log(result.migrations.join("\n"));
' "$result")

if [ -n "$pending" ]; then
  echo "Migrations not yet applied to the hosted project:" >&2
  sed 's/^/  • /' <<<"$pending" >&2
  fail "$(wc -l <<<"$pending" | tr -d ' ') migration(s) not applied.  Run \`make db-push\`, then re-run this job." \
    "$(printf 'These migrations are in this commit but not on the hosted project:\n\n'; sed 's/^/- `/; s/$/`/' <<<"$pending"; printf '\nRun `make db-push` from your machine, then re-run this job to deploy.\n')" \
    'Hosted database is behind'
fi

echo "✓ The hosted database has every migration."
