#!/usr/bin/env bash
# Usage: scripts/pulumi.sh <app|platform> <pulumi args...>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
	app) DIR="$ROOT/infra" ;;
	platform) DIR="$ROOT/infra/platform" ;;
	*)
		echo "usage: $0 <app|platform> <pulumi args...>" >&2
		exit 2
		;;
esac
shift

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true
mkdir -p "${PULUMI_BACKEND_URL#file://}"
STACK="${PULUMI_STACK:-dev}"

cd "$DIR"
if ! pulumi stack select "$STACK" >/dev/null 2>&1; then
	pulumi stack init "$STACK" --secrets-provider passphrase >/dev/null
fi
exec pulumi "$@" --stack "$STACK" --non-interactive
