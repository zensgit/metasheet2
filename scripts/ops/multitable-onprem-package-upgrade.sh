#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

function die() {
  echo "[multitable-onprem-package-upgrade] ERROR: $*" >&2
  exit 1
}

if [[ "${BUILD_BACKEND:-0}" != "1" && ! -f "${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js" ]]; then
  die "Missing packages/core-backend/dist/src/db/migrate.js before upgrade. Restore the packaged dist or rerun with BUILD_BACKEND=1."
fi

if [[ "${BUILD_WEB:-0}" != "1" && ! -f "${ROOT_DIR}/apps/web/dist/index.html" ]]; then
  die "Missing apps/web/dist/index.html before upgrade. Restore the packaged dist or rerun with BUILD_WEB=1."
fi

exec env \
  REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-0}" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-package-upgrade.sh" "$@"
