#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

: "${DB_USER:?DB_USER не задано (перевір .env)}"
: "${DB_NAME:?DB_NAME не задано (перевір .env)}"
POSTGRES_USER="${POSTGRES_USER:-admin}"

NEW_PASSWORD="app-$(openssl rand -hex 8)"

echo "1. ALTER ROLE у Postgres…"
docker compose exec -T db psql -U "${POSTGRES_USER}" -d "${DB_NAME}" \
	-c "ALTER ROLE ${DB_USER} WITH PASSWORD '${NEW_PASSWORD}';" >/dev/null

echo "2. Оновлюю файл-секрет…"
printf '%s' "${NEW_PASSWORD}" > secrets/db_password

echo "3. Закриваю старі зʼєднання ${DB_USER}…"
docker compose exec -T db psql -U "${POSTGRES_USER}" -d "${DB_NAME}" -tA \
	-c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = '${DB_USER}';"

echo "Готово: новий пароль ${NEW_PASSWORD:0:6}… уже в БД і у файлі."
echo "Застосунок НЕ рестартував — перевір: curl -s localhost:3000/db"
