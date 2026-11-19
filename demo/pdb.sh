#!/usr/bin/env bash
# Spends the PodDisruptionBudget through the Eviction API. The codes are the
# HTTP statuses the API server returned, read through kubectl proxy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NS=marketplace
NAME=marketplace-api
SELECTOR=app=marketplace-api

WORK="$(mktemp -d)"
PROXY_PID=""
cleanup() {
	if [ -n "$PROXY_PID" ]; then
		kill "$PROXY_PID" 2>/dev/null || true
		wait "$PROXY_PID" 2>/dev/null || true
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

kubectl -n "$NS" rollout status "deploy/$NAME" --timeout=180s >/dev/null
for _ in $(seq 1 60); do
	allowed=$(kubectl -n "$NS" get pdb "$NAME" -o jsonpath='{.status.disruptionsAllowed}')
	[ "${allowed:-0}" -ge 1 ] && break
	sleep 1
done

healthy=$(kubectl -n "$NS" get pdb "$NAME" -o jsonpath='{.status.currentHealthy}')
min_available=$(kubectl -n "$NS" get pdb "$NAME" -o jsonpath='{.spec.minAvailable}')
read -r POD1 POD2 _ <<<"$(kubectl -n "$NS" get pods -l "$SELECTOR" \
	--field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}')"
if [ -z "${POD2:-}" ]; then
	echo "need two running pods, got: ${POD1:-none}" >&2
	exit 1
fi

kubectl proxy --port=0 >"$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
PORT=""
for _ in $(seq 1 50); do
	PORT=$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$WORK/proxy.log" | head -1)
	[ -n "$PORT" ] && break
	sleep 0.1
done
[ -n "$PORT" ] || { echo "kubectl proxy did not start" >&2; exit 1; }

evict() {
	curl -s -o "$WORK/$1.json" -w '%{http_code}' -X POST \
		-H 'Content-Type: application/json' \
		"http://127.0.0.1:$PORT/api/v1/namespaces/$NS/pods/$1/eviction" \
		-d "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$1\",\"namespace\":\"$NS\"}}"
}

evict1=$(evict "$POD1")
evict2=$(evict "$POD2")

echo "disruptions-allowed-before=$allowed"
echo "healthy=$healthy"
echo "minAvailable=$min_available"
echo "evict-1=$evict1"
echo "evict-2=$evict2"
