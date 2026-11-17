#!/usr/bin/env bash
# A platform change (new Redis version/config) restarts Redis while the API
# serves traffic. Two streams: /health at full rate (are pods kept in the
# Service?) and a Redis-cached product card at 1 rps (does the cache fail open?).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/wait-settled.sh

NS=marketplace
DATA_NS=marketplace-data
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
	for pid in "${PIDS[@]:-}"; do
		[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
	done
	rm -rf "$WORK"
}
trap cleanup EXIT

psql() { kubectl -n "$DATA_NS" exec postgres-0 -- psql -U marketplace -d shop -tAc "$1"; }
psql "INSERT INTO users (email, full_name, role) VALUES ('blip-seller@example.test', 'Blip Seller', 'seller') ON CONFLICT (email) DO NOTHING" >/dev/null
PRODUCT_ID=$(psql "INSERT INTO products (name, price_cents, stock, seller_id)
	SELECT 'Blip demo product', 1000, 5, id FROM users WHERE email = 'blip-seller@example.test'
	ON CONFLICT (name) DO UPDATE SET stock = products.stock RETURNING id" | head -1)

restarts() {
	kubectl -n "$NS" get pods -l app=marketplace-api \
		-o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' |
		awk '{s+=$1} END{print s+0}'
}
count() { awk -v want="$2" '$0==want{n++} END{print n+0}' "$1"; }

wait_settled "$NS" app=marketplace-api
restarts_before=$(restarts)
node scripts/loadgen.mjs "http://127.0.0.1:30080/health" "$WORK/health.txt" &
PIDS+=($!)
LOAD_CONCURRENCY=1 LOAD_RPS=1 node scripts/loadgen.mjs \
	"http://127.0.0.1:30080/v1/products/$PRODUCT_ID" "$WORK/card.txt" &
PIDS+=($!)
sleep 5

kubectl -n "$DATA_NS" rollout restart statefulset/redis-cache statefulset/redis-queue >/dev/null
kubectl -n "$DATA_NS" rollout status statefulset/redis-cache --timeout=120s >/dev/null
kubectl -n "$DATA_NS" rollout status statefulset/redis-queue --timeout=120s >/dev/null
sleep 10

for pid in "${PIDS[@]}"; do kill -TERM "$pid"; wait "$pid" || true; done
PIDS=()

health_requests=$(wc -l <"$WORK/health.txt" | tr -d ' ')
card_requests=$(wc -l <"$WORK/card.txt" | tr -d ' ')
echo "health-requests=$health_requests"
echo "health-failed=$((health_requests - $(count "$WORK/health.txt" 200)))"
echo "card-requests=$card_requests"
echo "card-failed=$((card_requests - $(count "$WORK/card.txt" 200)))"
for stream in health card; do
	{ grep -vx '200' "$WORK/$stream.txt" || true; } | sort | uniq -c | while read -r n code; do
		echo "$stream-failed-${code//:/-}=$n"
	done
done
echo "api-restarts-during-blip=$(($(restarts) - restarts_before))"
