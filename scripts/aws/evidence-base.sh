#!/usr/bin/env bash
# Reads the live base stack from AWS (not from Pulumi state) and writes
# evidence/base.txt plus the raw state export evidence/base-state.json.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$ROOT/evidence/base.txt"
PROJECT_TAG=nodejs-pro-hw31

R="$(stack_region base)"
VPC="$(pulumi_aws base stack output vpcId)"

subnets() {
	aws ec2 describe-subnets --region "$R" \
		--filters Name=vpc-id,Values="$VPC" Name=tag:Tier,Values="$1" \
		--query "$2" --output json
}

default_routes_for_subnet() {
	local tables
	tables="$(aws ec2 describe-route-tables --region "$R" \
		--filters Name=association.subnet-id,Values="$1" --output json)"
	# A subnet without an explicit association silently uses the VPC main table.
	if [ "$(jq '.RouteTables | length' <<<"$tables")" -eq 0 ]; then
		tables="$(aws ec2 describe-route-tables --region "$R" \
			--filters Name=vpc-id,Values="$VPC" Name=association.main,Values=true --output json)"
	fi
	jq '[.RouteTables[].Routes[] | select(.DestinationCidrBlock == "0.0.0.0/0")] | length' <<<"$tables"
}

public_count="$(subnets public 'length(Subnets)')"
private_count="$(subnets private 'length(Subnets)')"
azs="$(aws ec2 describe-subnets --region "$R" --filters Name=vpc-id,Values="$VPC" \
	--query 'Subnets[].AvailabilityZone' --output json | jq 'unique | length')"

private_routes=0
for id in $(subnets private 'Subnets[].SubnetId' | jq -r '.[]'); do
	private_routes=$((private_routes + $(default_routes_for_subnet "$id")))
done

security_groups="$(aws ec2 describe-security-groups --region "$R" \
	--filters Name=vpc-id,Values="$VPC" \
	--query "length(SecurityGroups[?GroupName!='default'])" --output text)"

tagged() {
	aws resourcegroupstaggingapi get-resources --region "$1" \
		--tag-filters Key=Project,Values="$PROJECT_TAG" Key=Stack,Values=base \
		--query 'length(ResourceTagMappingList)' --output text
}

evidence_set "$OUT" region "$R"
evidence_set "$OUT" vpc-id "$VPC"
evidence_set "$OUT" public-subnets "$public_count"
evidence_set "$OUT" private-subnets "$private_count"
evidence_set "$OUT" subnet-azs "$azs"
evidence_set "$OUT" private-default-route "$private_routes"
evidence_set "$OUT" security-groups "$security_groups"
evidence_set "$OUT" tagged-resources "$(tagged "$R")"
evidence_set "$OUT" tagged-resources-us-east-1 "$(tagged us-east-1)"

pulumi_aws base stack export >"$ROOT/evidence/base-state.json"
echo "wrote evidence/base-state.json"
