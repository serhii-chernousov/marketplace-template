#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -z "${DATABASE_URL:-}" ]; then
	if [ -n "${DB_URL:-}" ]; then
		DATABASE_URL="$DB_URL"
	else
		echo "DATABASE_URL: unbound variable" >&2
		exit 1
	fi
fi

without_scheme="${DATABASE_URL#*://}"
hostpath="${without_scheme#*@}"
PGDATABASE="${hostpath##*/}"
PGDATABASE="${PGDATABASE%%\?*}"

DEST="$ROOT/backups"
mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
FILE="$DEST/shop-${STAMP}.dump"

docker compose exec -T db pg_dump -Fc --no-owner -U admin -d "$PGDATABASE" > "$FILE"

echo "$FILE"
