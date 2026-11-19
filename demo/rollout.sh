#!/usr/bin/env bash
# Measures a rolling update under load. Every number is counted from the
# file the load generator writes, one line per response.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-tag.sh
source scripts/wait-settled.sh

CLUSTER=${CLUSTER:-hw28}
PROFILE="${PROFILE:-correct}"
MIN_REQUESTS="${MIN_REQUESTS:-6000}"
LOAD_PATH="${LOAD_PATH:-/health}"
NS=marketplace
DEPLOY=marketplace-api
URL="http://127.0.0.1:30080$LOAD_PATH"

WORK="$(mktemp -d)"
CODES="$WORK/codes.txt"
LOADGEN_PID=""

app() { bash scripts/pulumi.sh app "$@"; }
now_ms() { node -p 'Date.now()'; }

cleanup() {
	if [ -n "$LOADGEN_PID" ] && kill -0 "$LOADGEN_PID" 2>/dev/null; then
		kill -TERM "$LOADGEN_PID" 2>/dev/null || true
		wait "$LOADGEN_PID" 2>/dev/null || true
	fi
	rm -rf "$WORK"
	if [ "$PROFILE" != "correct" ]; then
		echo "restoring profile=correct" >&2
		app config set profile correct
		app up --yes --skip-preview >/dev/null
		wait_settled "$NS" app=marketplace-api
	fi
}
trap cleanup EXIT

if ! docker exec "$CLUSTER-control-plane" crictl inspecti "docker.io/library/$IMG" >/dev/null 2>&1; then
	echo "image $IMG is not loaded into kind; run npm run image:build && npm run cluster:up" >&2
	exit 1
fi

echo "preparing profile=$PROFILE (not measured)" >&2
app config set profile "$PROFILE"
app up --yes --skip-preview >/dev/null
wait_settled "$NS" app=marketplace-api

: >"$CODES"
node scripts/loadgen.mjs "$URL" "$CODES" &
LOADGEN_PID=$!
sleep 3

echo "rolling out a new revision under load" >&2
t0=$(now_ms)
app config set image "$IMG"
app config set rev "$(date +%s)"
app up --yes --skip-preview >/dev/null
kubectl -n "$NS" rollout status "deploy/$DEPLOY" --timeout=300s >/dev/null
t1=$(now_ms)

sleep 3
while [ "$(wc -l <"$CODES")" -lt "$MIN_REQUESTS" ]; do sleep 1; done
kill -TERM "$LOADGEN_PID"
wait "$LOADGEN_PID" || true
LOADGEN_PID=""

requests=$(wc -l <"$CODES" | tr -d ' ')
ok=$(grep -cx '200' "$CODES" || true)
failed=$((requests - ok))

job=$(kubectl -n "$NS" get jobs -l app=marketplace-migrate \
	--sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}')
migrate_seconds=$(kubectl -n "$NS" get job "$job" -o json | node -e '
	let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
		const st = JSON.parse(s).status;
		const ms = Date.parse(st.completionTime) - Date.parse(st.startTime);
		console.log(Number.isFinite(ms) ? Math.round(ms / 1000) : -1);
	});')

echo "image=$IMG"
echo "profile=$PROFILE"
echo "requests=$requests"
echo "ok=$ok"
echo "failed=$failed"
echo "rollout-seconds=$(((t1 - t0) / 1000))"
echo "migrate-seconds=$migrate_seconds"
echo "migrations-applied=$(kubectl -n marketplace-data exec postgres-0 -- \
	psql -U marketplace -d shop -tAc 'SELECT count(*) FROM migrations')"
{ grep -vx '200' "$CODES" || true; } | sort | uniq -c | while read -r count code; do
	echo "failed-${code//:/-}=$count"
done

if [ "$PROFILE" = "correct" ] && { [ "$failed" -ne 0 ] || [ "$requests" -lt 5000 ]; }; then
	exit 1
fi
