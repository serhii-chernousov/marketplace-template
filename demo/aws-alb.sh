#!/usr/bin/env bash
# Waits for the Lambda target to pass the ALB health check, then reads the
# HTTP status the internet-facing ALB returns.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/aws/lib.sh"
OUT="$ROOT/evidence/demos.txt"

R="$(stack_region demo)"
DNS="$(pulumi_aws demo stack output albDnsName)"
TG="$(pulumi_aws demo stack output targetGroupArn)"

state=unknown
for _ in $(seq 1 40); do
	state="$(aws elbv2 describe-target-health --region "$R" --target-group-arn "$TG" \
		--query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)"
	[ "$state" = healthy ] && break
	sleep 15
done

# A fresh ALB name takes a minute or two to resolve.
code=000
for _ in $(seq 1 40); do
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$DNS/" || true)"
	[ "$code" = 200 ] && break
	sleep 15
done

evidence_set "$OUT" alb-dns "$DNS"
evidence_set "$OUT" http-code "$code"
evidence_set "$OUT" target-state "$state"
