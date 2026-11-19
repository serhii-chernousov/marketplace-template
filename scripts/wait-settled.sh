#!/usr/bin/env bash
# Sourced by demos: a rollout is "complete" before old pods finish terminating,
# and a measurement started in that window counts someone else's shutdown.
wait_settled() {
	local ns="$1" selector="$2"
	kubectl -n "$ns" rollout status deploy/marketplace-api --timeout=180s >/dev/null
	for _ in $(seq 1 90); do
		local terminating
		terminating=$(kubectl -n "$ns" get pods -l "$selector" \
			-o jsonpath='{range .items[*]}{.metadata.deletionTimestamp}{"\n"}{end}' | grep -c . || true)
		[ "$terminating" -eq 0 ] && return 0
		sleep 1
	done
	echo "pods still terminating after 90s" >&2
	return 1
}
