#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
SKIP_MULTITABLE_PILOT_SMOKE="${SKIP_MULTITABLE_PILOT_SMOKE:-false}"

pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build

pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-view-manager.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-import.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-grid-attachment-editor.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  tests/multitable-workbench.spec.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  tests/integration/views.multitable-adapter.api.test.ts \
  --reporter=dot

if [[ "$SKIP_MULTITABLE_PILOT_SMOKE" != "true" ]]; then
  API_BASE="$API_BASE" WEB_BASE="$WEB_BASE" HEADLESS="${HEADLESS:-true}" TIMEOUT_MS="${TIMEOUT_MS:-40000}" pnpm verify:multitable-pilot
fi
