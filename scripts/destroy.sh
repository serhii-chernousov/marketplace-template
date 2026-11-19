#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/pulumi.sh app destroy --yes --skip-preview
bash scripts/pulumi.sh platform destroy --yes --skip-preview
