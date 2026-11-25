#!/usr/bin/env bash
# Creates one NAT Gateway, removes it straight away, and compares the minutes
# it lived with the hours AWS bills for it (a partial hour is a full hour).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/aws/lib.sh"
OUT="$ROOT/evidence/demos.txt"

R="$(stack_region demo)"

nat_off() {
	pulumi_aws demo config set hw31:withNat false
	pulumi_aws demo up --yes --skip-preview >&2
}
trap 'nat_off' EXIT

pulumi_aws demo config set hw31:withNat true
pulumi_aws demo up --yes --skip-preview >&2
NAT="$(pulumi_aws demo stack output natGatewayId)"

trap - EXIT
nat_off

state=""
for _ in $(seq 1 60); do
	read -r state created deleted <<<"$(aws ec2 describe-nat-gateways --region "$R" \
		--nat-gateway-ids "$NAT" \
		--query 'NatGateways[0].[State,CreateTime,DeleteTime]' --output text)"
	[ "$state" = deleted ] && break
	sleep 10
done
[ "$state" = deleted ] || { echo "NAT $NAT is still '$state'" >&2; exit 1; }

minutes="$(minutes_between "$created" "$deleted")"
evidence_set "$OUT" nat-id "$NAT"
evidence_set "$OUT" nat-minutes "$minutes"
evidence_set "$OUT" nat-billed-hours "$(((minutes + 59) / 60))"
