#!/usr/bin/env bash
# One deploy, in the order a pipeline runs it. Any failed step stops the
# rest, so the previously deployed version keeps serving.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-tag.sh

echo "== platform (no-op unless data services changed)"
bash scripts/pulumi.sh platform up --yes --skip-preview

echo "== app: secret -> migrate job -> api rollout -> worker rollout ($IMG)"
bash scripts/pulumi.sh app config set image "$IMG"
bash scripts/pulumi.sh app up --yes --skip-preview

echo "== smoke"
# /health, not /readyz: right after a rollout a draining old pod still answers
# /readyz with 503 on purpose, while the Service as a whole keeps serving.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:30080/health || true)
echo "smoke-health=$code"
[ "$code" = "200" ]
