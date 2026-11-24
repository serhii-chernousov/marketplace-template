#!/usr/bin/env bash
# Prints exports for running demo scripts on the host against the local compose stack:
#   eval "$(bash scripts/dev-env.sh)"
# Values are the dev-only defaults from docker-compose.yaml; JWT keys come from the keygen volume.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

keys="$(docker compose run --rm --no-deps -T --entrypoint cat keygen /keys/jwt.env)"

cat <<ENV
export SKIP_VAULT=1
export PORT=3000
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=app_user DB_PASSWORD=${APP_DB_PASSWORD:-app-secret-initial} DB_NAME=shop
export DB_URL=postgresql://app_user:${APP_DB_PASSWORD:-app-secret-initial}@127.0.0.1:6432/shop
export BROKER_URL=amqp://${RABBITMQ_DEFAULT_USER:-app}:${RABBITMQ_DEFAULT_PASS:-app}@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:16379 REDIS_QUEUE_URL=redis://127.0.0.1:16380
export STORAGE_ENDPOINT=http://127.0.0.1:19000 STORAGE_REGION=us-east-1 STORAGE_BUCKET=hw26-files
export STORAGE_ACCESS_KEY=${MINIO_ROOT_USER:-hw26user} STORAGE_SECRET_KEY=${MINIO_ROOT_PASSWORD:-hw26secretpass}
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:22918 PROMETHEUS_URL=http://127.0.0.1:22901 TRACE_API_URL=http://127.0.0.1:22904
ENV
while IFS='=' read -r name value; do
	[ -n "$name" ] && printf 'export %s=%q\n' "$name" "$value"
done <<<"$keys"
