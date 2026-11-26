#!/usr/bin/env bash
# Usage: scripts/pulumi-aws.sh <base|demo> <pulumi args...>
# State lives in Pulumi Cloud so the teardown workflow can reach it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
	base | demo) PROGRAM="$1" ;;
	*)
		echo "usage: $0 <base|demo> <pulumi args...>" >&2
		exit 2
		;;
esac
shift

: "${PULUMI_ACCESS_TOKEN:?missing PULUMI_ACCESS_TOKEN (run through scripts/with-secrets.sh)}"
: "${PULUMI_ORG:?missing PULUMI_ORG (run through scripts/with-secrets.sh)}"
export PULUMI_BACKEND_URL=https://api.pulumi.com
export PULUMI_SKIP_UPDATE_CHECK=true
STACK="$PULUMI_ORG/hw31-$PROGRAM/$PROGRAM"

cd "$ROOT/infra/$PROGRAM"
[ -d node_modules ] || npm ci --no-audit --no-fund >&2
pulumi stack select "$STACK" --create --non-interactive >&2
exec pulumi "$@" --stack "$STACK" --non-interactive
