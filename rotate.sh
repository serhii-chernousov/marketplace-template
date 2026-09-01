#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NEW_PASSWORD="app-$(openssl rand -hex 8)"

echo "1. ALTER ROLE у Postgres…"
docker compose exec -T db psql -U admin -d shop \
	-c "ALTER ROLE app_user WITH PASSWORD '${NEW_PASSWORD}';" >/dev/null

echo "2. Оновлюю файл-секрет…"
printf '%s' "${NEW_PASSWORD}" > secrets/db_password

echo "3. Закриваю старі зʼєднання app_user…"
docker compose exec -T db psql -U admin -d shop -tA \
	-c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app_user';"

echo "Готово: новий пароль ${NEW_PASSWORD:0:6}… уже в БД і у файлі."
echo "Застосунок НЕ рестартував — перевір: curl -s localhost:3000/db"