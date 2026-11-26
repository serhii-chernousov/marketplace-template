#!/usr/bin/env bash
# Breaking-change check of the OpenAPI spec against what consumers already live on.
# BASE_SPEC defaults to the spec on origin/main; REV_SPEC to the working tree.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

OASDIFF_IMAGE=tufin/oasdiff:v1.41.0@sha256:cb7cd2acde680a724c9d08c27bc687c83628c02c5869ead033b857935fb4e9f4
REV_SPEC="${REV_SPEC:-openapi/openapi.yaml}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${BASE_SPEC:-}" ]; then
	cp "$BASE_SPEC" "$WORK/base.yaml"
else
	BASE_REF="${BASE_REF:-origin/main}"
	git show "$BASE_REF:openapi/openapi.yaml" >"$WORK/base.yaml"
fi
cp "$REV_SPEC" "$WORK/revision.yaml"

docker run --rm -v "$WORK:/specs:ro" "$OASDIFF_IMAGE" \
	breaking /specs/base.yaml /specs/revision.yaml --fail-on ERR
