#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"

if [ ! -f "$CREDS" ]; then
	echo "Please either run infisical init to connect to a project…" >&2
	exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CREDS"
set +a

exec infisical run --env="$ENV_SLUG" -- "$@"
