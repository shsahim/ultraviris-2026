#!/usr/bin/env bash
#
# Syncs the GitHub issue-reporter credentials (GITHUB_TOKEN + GITHUB_ISSUE_REPO)
# into ./.env.local from the gh CLI, so the admin "Report an issue" window works
# in local dev and in the containers started by `make build/run/run-local`.
# Production receives these (and all other secrets) via `make ship`, which syncs
# .env.local into Secrets Manager (see scripts/sync-secrets.mts).
#
#   github-token.sh env-local
#
# Safe to run repeatedly. It never aborts a build: when gh is unavailable or not
# authenticated it warns and exits 0, leaving any existing configuration intact.
set -euo pipefail

GITHUB_ISSUE_REPO="${GITHUB_ISSUE_REPO:-shsahim/ultraviris-2026}"

# Replace an existing `KEY=...` line or append `KEY=VALUE` if absent. Reads the
# current dotenv body from stdin and prints the updated body to stdout. Other
# lines are preserved verbatim.
upsert() {
  local key="$1" value="$2"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^"k"=" { print k"="v; found=1; next }
    { print }
    END { if (!found) print k"="v }
  '
}

sync_env_local() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "WARNING: gh CLI not found; skipping GITHUB_TOKEN sync to .env.local." >&2
    echo "         Install GitHub CLI + run 'gh auth login' to enable the issue reporter." >&2
    return 0
  fi

  local token=""
  if ! token="$(gh auth token 2>/dev/null)" || [ -z "$token" ]; then
    echo "WARNING: not authenticated with gh (run 'gh auth login'); skipping GITHUB_TOKEN sync." >&2
    return 0
  fi

  local file=".env.local" body=""
  [ -f "$file" ] && body="$(cat "$file")"
  body="$(printf '%s' "$body" | upsert GITHUB_TOKEN "$token")"
  body="$(printf '%s' "$body" | upsert GITHUB_ISSUE_REPO "$GITHUB_ISSUE_REPO")"
  printf '%s\n' "$body" > "$file"
  chmod 600 "$file" 2>/dev/null || true
  echo "Synced GITHUB_TOKEN (via gh) and GITHUB_ISSUE_REPO=$GITHUB_ISSUE_REPO into $file"
}

case "${1:-}" in
  env-local) sync_env_local ;;
  *)
    echo "usage: $0 env-local" >&2
    exit 2
    ;;
esac
