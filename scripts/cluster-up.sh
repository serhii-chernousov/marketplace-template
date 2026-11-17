#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-tag.sh

CLUSTER=hw28
DEPENDENCY_IMAGES=(
	postgres:16.10-alpine
	redis:7.4.5-alpine
	rabbitmq:3.13.7-management-alpine
	pgsty/minio:RELEASE.2026-08-04T00-00-00Z
)

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
	kind create cluster --config k8s/kind-config.yaml --wait 90s
fi

docker image inspect "$IMG" >/dev/null 2>&1 || {
	echo "image $IMG not built; run npm run image:build first" >&2
	exit 1
}

case "$(docker exec "$CLUSTER-control-plane" uname -m)" in
	aarch64 | arm64) PLATFORM=linux/arm64 ;;
	*) PLATFORM=linux/amd64 ;;
esac

load() {
	# With Docker's containerd image store, multi-arch images break kind load; import one platform via ctr instead.
	kind load docker-image "$1" --name "$CLUSTER" >/dev/null 2>&1 ||
		docker save --platform "$PLATFORM" "$1" |
		docker exec -i "$CLUSTER-control-plane" ctr -n k8s.io images import - >/dev/null
}

load "$IMG"
for image in "${DEPENDENCY_IMAGES[@]}"; do
	docker image inspect "$image" >/dev/null 2>&1 || docker pull -q --platform "$PLATFORM" "$image" >/dev/null
	load "$image"
done
echo "cluster=$CLUSTER image=$IMG"
