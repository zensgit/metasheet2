#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

exec env \
  REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-0}" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-package-upgrade.sh" "$@"
