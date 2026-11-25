#!/usr/bin/env bash
# Forces a Multi-AZ failover and records the zone before/after, how long it
# took (from RDS's own events) and the event that says it finished.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/aws/lib.sh"
OUT="$ROOT/evidence/demos.txt"

R="$(stack_region demo)"
ID="$(pulumi_aws demo stack output dbIdentifier)"

describe() {
	aws rds describe-db-instances --region "$R" --db-instance-identifier "$ID" \
		--query 'DBInstances[0].[DBInstanceStatus,AvailabilityZone]' --output text
}

read -r status az_before <<<"$(describe)"
if [ "$status" != available ]; then
	echo "instance is '$status'; --force-failover needs 'available', wait and rerun" >&2
	exit 1
fi

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t0=$(date +%s)
aws rds reboot-db-instance --region "$R" --db-instance-identifier "$ID" \
	--force-failover >/dev/null

# `aws rds wait db-instance-available` can return before the reboot even starts.
for _ in $(seq 1 60); do
	read -r status _ <<<"$(describe)"
	[ "$status" != available ] && break
	sleep 2
done
for _ in $(seq 1 120); do
	read -r status az_after <<<"$(describe)"
	[ "$status" = available ] && break
	sleep 5
done
wallclock=$(($(date +%s) - t0))

events='[]'
for _ in $(seq 1 24); do
	events="$(aws rds describe-events --region "$R" --source-type db-instance \
		--source-identifier "$ID" --start-time "$since" --query 'Events' --output json)"
	jq -e 'any(.[]; .Message | test("failover completed"; "i"))' <<<"$events" >/dev/null && break
	sleep 5
done

started_at="$(jq -r '[.[] | select(.Message | test("failover started"; "i"))][0].Date // empty' <<<"$events")"
completed="$(jq -c '[.[] | select(.Message | test("failover completed"; "i"))] | last // empty' <<<"$events")"

if [ -n "$started_at" ] && [ -n "$completed" ]; then
	seconds="$(seconds_between "$started_at" "$(jq -r .Date <<<"$completed")")"
	source_of_seconds=rds-events
else
	seconds="$wallclock"
	source_of_seconds=wallclock
fi

evidence_set "$OUT" az-before "$az_before"
evidence_set "$OUT" az-after "$az_after"
evidence_set "$OUT" failover-seconds "$seconds"
evidence_set "$OUT" failover-seconds-source "$source_of_seconds"
evidence_set "$OUT" failover-wallclock-seconds "$wallclock"
if [ -n "$completed" ]; then
	event="$(jq -r .Message <<<"$completed")"
else
	event="$(jq -r 'last.Message // empty' <<<"$events")"
fi
[ -n "$event" ] || { echo "RDS reported no events for $ID since $since" >&2; exit 1; }
evidence_set "$OUT" event "$event"
