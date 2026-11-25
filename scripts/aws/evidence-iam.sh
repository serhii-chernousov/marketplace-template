#!/usr/bin/env bash
# Dumps the CI role (trust + permission policy, decoded) and asks the IAM
# policy simulator for one action the role has and one it must not have.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TXT="$ROOT/evidence/iam.txt"
ALLOWED_ACTION=rds:DescribeDBInstances
DENIED_ACTION=iam:CreateAccessKey

ROLE="$(pulumi_aws base stack output ciRoleName)"
POLICY="$(pulumi_aws base stack output ciPolicyName)"
ARN="$(pulumi_aws base stack output ciRoleArn)"

# Older CLI builds return policy documents URL-encoded; the evidence must be plain JSON.
role="$(aws iam get-role --role-name "$ROLE" --output json)"
policy="$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY" --output json)"
node -e '
const [role, policy] = process.argv.slice(1).map(JSON.parse)
const doc = (v) => (typeof v === "string" ? JSON.parse(decodeURIComponent(v)) : v)
role.Role.AssumeRolePolicyDocument = doc(role.Role.AssumeRolePolicyDocument)
policy.PolicyDocument = doc(policy.PolicyDocument)
console.log(JSON.stringify({ Role: role.Role, PermissionPolicy: policy }, null, 2))
' "$role" "$policy" >"$ROOT/evidence/iam.json"
echo "wrote evidence/iam.json"

simulate() {
	aws iam simulate-principal-policy --policy-source-arn "$ARN" \
		--action-names "$1" --output json
}

allowed_raw="$(simulate "$ALLOWED_ACTION")"
denied_raw="$(simulate "$DENIED_ACTION")"
{
	echo "\$ aws iam simulate-principal-policy --policy-source-arn $ARN --action-names $ALLOWED_ACTION"
	echo "$allowed_raw"
	echo
	echo "\$ aws iam simulate-principal-policy --policy-source-arn $ARN --action-names $DENIED_ACTION"
	echo "$denied_raw"
} >"$ROOT/evidence/iam-simulate.log.txt"

evidence_set "$TXT" sim-allowed-action "$ALLOWED_ACTION"
evidence_set "$TXT" sim-allowed "$(jq -r '.EvaluationResults[0].EvalDecision' <<<"$allowed_raw")"
evidence_set "$TXT" sim-denied-action "$DENIED_ACTION"
evidence_set "$TXT" sim-denied "$(jq -r '.EvaluationResults[0].EvalDecision' <<<"$denied_raw")"
