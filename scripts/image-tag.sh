#!/usr/bin/env bash
# Sourced by build/load/deploy scripts so all of them agree on one immutable tag:
# the commit, plus a content hash while image inputs have uncommitted changes.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_REPO="${IMAGE_REPO:-marketplace-api}"
if [ -z "${IMAGE_TAG:-}" ]; then
	IMAGE_TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
	IMAGE_INPUTS=(docker src openapi package.json package-lock.json tsconfig.json nest-cli.json)
	if [ -n "$(git -C "$ROOT" status --porcelain -- "${IMAGE_INPUTS[@]}" 2>/dev/null)" ]; then
		dirty_hash=$(
			cd "$ROOT" && {
				git diff HEAD -- "${IMAGE_INPUTS[@]}"
				git ls-files --others --exclude-standard -z -- "${IMAGE_INPUTS[@]}" | xargs -0 cat 2>/dev/null
			} | shasum | cut -c1-8
		)
		IMAGE_TAG="$IMAGE_TAG-dirty-$dirty_hash"
	fi
fi
IMG="${IMG:-$IMAGE_REPO:$IMAGE_TAG}"
export IMAGE_REPO IMAGE_TAG IMG
