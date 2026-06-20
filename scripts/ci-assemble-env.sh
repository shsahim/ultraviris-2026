#!/usr/bin/env bash
#
# Assembles a dotenv file on stdout from the repo's GitHub Actions Secrets and
# Variables. Reads two JSON objects from the environment:
#
#   SECRETS_JSON   e.g. ${{ toJSON(secrets) }}
#   VARS_JSON      e.g. ${{ toJSON(vars) }}
#
# Every entry named APP_<KEY> is emitted as <KEY>=<value> (the APP_ prefix is
# stripped). This is how CI mirrors `make ship`: the output is fed to
# scripts/sync-secrets.mts, which validates it and writes ultraviris/env.
#
# Non-APP_ entries (AWS_ROLE_ARN, the built-in GITHUB_TOKEN, DEV_* dev-bundle
# secrets, etc.) are ignored.
set -euo pipefail

emit() {
  local json="$1"
  [ -z "$json" ] && json='{}'
  jq -r 'to_entries[]
           | select(.key | startswith("APP_"))
           | "\(.key[4:])=\(.value)"' <<<"$json"
}

emit "${SECRETS_JSON:-}"
emit "${VARS_JSON:-}"
