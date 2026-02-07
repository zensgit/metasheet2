#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[attendance-smoke-api] ERROR: node is required to run this smoke script" >&2
  exit 1
fi

exec node "${ROOT_DIR}/scripts/ops/attendance-smoke-api.mjs"

