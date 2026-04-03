#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

exec env \
  EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-platform}" \
  EXPECT_PLM_ENABLED="${EXPECT_PLM_ENABLED:-}" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-healthcheck.sh" "$@"
