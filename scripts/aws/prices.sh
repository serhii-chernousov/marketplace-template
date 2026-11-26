#!/usr/bin/env bash
# Reads the hourly rates of every billed line from the AWS Price List API and
# writes them with each offer's effective and publication dates.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$ROOT/evidence/prices.txt"
LOC="EU (Frankfurt)"

# The Price List API is served only from a few regions; us-east-1 is one of them.
q() {
	local label="$1" svc="$2"
	shift 2
	local filters=()
	for f in "$@"; do filters+=("Type=TERM_MATCH,Field=${f%%=*},Value=${f#*=}"); done
	aws pricing get-products --region us-east-1 --service-code "$svc" \
		--filters "${filters[@]}" --max-items 20 --output json |
		jq -r --arg label "$label" '.PriceList[] | fromjson | . as $p
			| .terms.OnDemand[]? | .effectiveDate as $eff | .priceDimensions[]
			| select((.pricePerUnit.USD // "0") | tonumber > 0)
			| [$label, .pricePerUnit.USD, .unit, $p.product.attributes.usagetype,
				"effective=" + $eff[0:10], "published=" + ($p.publicationDate // "")[0:10]] | @tsv'
}

{
	echo "# aws pricing get-products, location=$LOC, queried $(date -u +%Y-%m-%dT%H:%MZ)"
	q alb-hour AWSELB location="$LOC" productFamily="Load Balancer-Application" usagetype=EUC1-LoadBalancerUsage
	q alb-lcu AWSELB location="$LOC" productFamily="Load Balancer-Application" usagetype=EUC1-LCUUsage
	q rds-t4g-micro-multi-az AmazonRDS location="$LOC" instanceType=db.t4g.micro databaseEngine=PostgreSQL deploymentOption=Multi-AZ
	q rds-gp3-multi-az AmazonRDS location="$LOC" productFamily="Database Storage" volumeType="General Purpose-GP3" databaseEngine=PostgreSQL deploymentOption=Multi-AZ
	q public-ipv4 AmazonVPC location="$LOC" usagetype=EUC1-PublicIPv4:InUseAddress
	q nat-hour AmazonEC2 location="$LOC" productFamily="NAT Gateway" usagetype=EUC1-NatGateway-Hours
	q nat-gb AmazonEC2 location="$LOC" productFamily="NAT Gateway" usagetype=EUC1-NatGateway-Bytes
	q lambda-request-arm AWSLambda location="$LOC" usagetype=EUC1-Request-ARM
	q lambda-gb-second-arm AWSLambda location="$LOC" usagetype=EUC1-Lambda-GB-Second-ARM
} >"$OUT"
cat "$OUT"
