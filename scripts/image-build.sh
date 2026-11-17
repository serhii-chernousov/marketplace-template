#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-tag.sh

if [ ! -s .npm_token ]; then
	echo "missing .npm_token (build-time registry token; e.g. printf 'dummy-npm-token' > .npm_token)" >&2
	exit 1
fi

docker build --provenance=false -f docker/Dockerfile --secret id=npm_token,src=.npm_token -t "$IMG" .
echo "image=$IMG"
