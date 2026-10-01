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

DEST="$ROOT/backups"
mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
FILE="$DEST/shop-${STAMP}.dump"

pg_dump -Fc --no-owner --dbname="$DATABASE_URL" > "$FILE"

echo "$FILE"
