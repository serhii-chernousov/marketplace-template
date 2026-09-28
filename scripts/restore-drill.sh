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

LATEST="$(ls -1t "$ROOT/backups"/*.dump 2>/dev/null | head -n 1 || true)"
if [ -z "$LATEST" ]; then
	echo "no dump in $ROOT/backups" >&2
	exit 1
fi

CHECKSUM_SQL="SELECT CASE WHEN to_regclass('public.orders') IS NULL THEN '0|0' ELSE (SELECT count(*)::text || '|' || coalesce(sum(total_cents), 0)::text FROM public.orders) END"

BEFORE="$(docker compose exec -T db psql -U admin -d "$PGDATABASE" -Atc "$CHECKSUM_SQL")"

NAME="shop-restore-$$"
docker volume create "$NAME" >/dev/null
docker run -d --name "$NAME" \
	-e POSTGRES_USER=admin \
	-e POSTGRES_PASSWORD=admin-secret \
	-e POSTGRES_DB=shop \
	-v "$NAME":/var/lib/postgresql/data \
	postgres:16-alpine >/dev/null

cleanup() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 30); do
	if docker exec "$NAME" pg_isready -U admin -d shop >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

docker exec "$NAME" psql -U admin -d shop -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public; GRANT ALL ON SCHEMA public TO admin;"

START="$(date +%s)"
docker exec -i "$NAME" pg_restore --no-owner --no-acl --exit-on-error -U admin -d shop < "$LATEST"
END="$(date +%s)"
RTO="$((END - START))"

AFTER="$(docker exec "$NAME" psql -U admin -d shop -Atc "$CHECKSUM_SQL")"

echo "dump=$LATEST"
echo "rto_seconds=$RTO"
echo "before=$BEFORE"
echo "after=$AFTER"

if [ "$BEFORE" = "$AFTER" ]; then
	echo "MATCH"
else
	echo "MISMATCH" >&2
	exit 1
fi
