#!/usr/bin/env bash
# Runs each gate twice: on the real input (must exit 0) and on a deliberately
# broken one (must exit non-zero). Prints the exit codes, nothing is hardcoded.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCAN_IMG="${SCAN_IMG:-ghcr.io/serhii-chernousov/marketplace-api@sha256:7a1eae37ea3002d83028ff688051836ff6c974d0971d8ceb86d45eb73e44eb09}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run() {
	local key=$1
	shift
	"$@" >"$WORK/$key.log" 2>&1
	echo "$key=$?"
}

sed 's#^  /orders/{id}:#  /orders/{orderId}/v0:#' openapi/openapi.yaml >"$WORK/openapi-broken.yaml"

run types-ok npm run --silent gate:types
run types-broken npx tsc -p gates/fixtures/types-broken

run contract-ok env BASE_SPEC=openapi/openapi.yaml bash scripts/gates/contract.sh
run contract-broken env BASE_SPEC=openapi/openapi.yaml REV_SPEC="$WORK/openapi-broken.yaml" bash scripts/gates/contract.sh

run arch-ok npm run --silent gate:arch
run arch-broken npx depcruise gates/fixtures/arch-broken/src --config .dependency-cruiser.cjs

run image-ok env IMG="$SCAN_IMG" SCAN_MAX=99999 npm run --silent scan
run image-broken env IMG="$SCAN_IMG" SCAN_MAX=-1 npm run --silent scan
