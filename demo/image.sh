#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-tag.sh

TOKEN="$(cat .npm_token 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
	echo "empty .npm_token: nothing to search for, refusing to report zero leaks" >&2
	exit 1
fi
docker image inspect "$IMG" >/dev/null 2>&1 || {
	echo "image $IMG not found; run npm run image:build" >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

stages=$(grep -ciE '^[[:space:]]*FROM[[:space:]]' docker/Dockerfile)

shells=0
for sh in sh /bin/sh bash /bin/bash ash /busybox/sh; do
	if docker run --rm --entrypoint "$sh" "$IMG" -c 'exit 0' >/dev/null 2>&1; then
		shells=$((shells + 1))
	fi
done

uid=$(docker run --rm --entrypoint /nodejs/bin/node "$IMG" \
	-e 'process.stdout.write(String(process.getuid()))' 2>/dev/null || true)
if [ -z "$uid" ]; then
	user=$(docker image inspect -f '{{.Config.User}}' "$IMG")
	uid="${user%%:*}"
fi

in_history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMG" | grep -cF -- "$TOKEN" || true)
in_config=$(docker image inspect "$IMG" | grep -cF -- "$TOKEN" || true)

docker save "$IMG" -o "$WORK/image.tar"
mkdir "$WORK/image"
tar -xf "$WORK/image.tar" -C "$WORK/image"
in_layers=0
while IFS= read -r layer; do
	if tar -xOf "$WORK/image/$layer" 2>/dev/null | grep -qaF -- "$TOKEN"; then
		in_layers=$((in_layers + 1))
	fi
done < <(node -e '
	const m = require(process.argv[1]);
	for (const l of m[0].Layers) console.log(l);
' "$WORK/image/manifest.json")

echo "image=$IMG"
echo "stages=$stages"
echo "shell-inside=$shells"
echo "runtime-uid=$uid"
echo "token-in-history=$in_history"
echo "token-in-config=$in_config"
echo "token-in-layers=$in_layers"
