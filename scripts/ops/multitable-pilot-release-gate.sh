#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
SKIP_MULTITABLE_PILOT_SMOKE="${SKIP_MULTITABLE_PILOT_SMOKE:-false}"
REPORT_JSON="${REPORT_JSON:-}"
LOG_PATH="${LOG_PATH:-}"
PILOT_SMOKE_REPORT="${PILOT_SMOKE_REPORT:-}"

function write_release_gate_report() {
  if [[ -z "$REPORT_JSON" ]]; then
    return 0
  fi

  REPORT_JSON_PATH="$REPORT_JSON" \
  RELEASE_GATE_LOG_PATH="$LOG_PATH" \
  RELEASE_GATE_SKIP_SMOKE="$SKIP_MULTITABLE_PILOT_SMOKE" \
  RELEASE_GATE_SMOKE_REPORT="$PILOT_SMOKE_REPORT" \
  node <<'NODE'
const fs = require('fs')
const path = require('path')

const reportPath = process.env.REPORT_JSON_PATH
const logPath = process.env.RELEASE_GATE_LOG_PATH || null
const skipSmoke = process.env.RELEASE_GATE_SKIP_SMOKE === 'true'
const pilotSmokeReport = process.env.RELEASE_GATE_SMOKE_REPORT || null

const report = {
  ok: true,
  checks: [
    {
      name: 'web.build',
      ok: true,
      command: 'pnpm --filter @metasheet/web build',
      log: logPath,
    },
    {
      name: 'core-backend.build',
      ok: true,
      command: 'pnpm --filter @metasheet/core-backend build',
      log: logPath,
    },
    {
      name: 'web.vitest.multitable',
      ok: true,
      command: 'pnpm --filter @metasheet/web exec vitest run tests/multitable-field-manager.spec.ts tests/multitable-view-manager.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-import.spec.ts tests/multitable-people-import.spec.ts tests/multitable-grid-attachment-editor.spec.ts tests/multitable-link-picker.spec.ts tests/multitable-gallery-view.spec.ts tests/multitable-calendar-view.spec.ts tests/multitable-kanban-view.spec.ts tests/multitable-timeline-view.spec.ts tests/multitable-workbench.spec.ts --reporter=dot',
      log: logPath,
    },
    {
      name: 'core-backend.integration.multitable',
      ok: true,
      command: 'pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/views.multitable-adapter.api.test.ts --reporter=dot',
      log: logPath,
    },
    {
      name: 'release-gate.multitable.live-smoke',
      ok: true,
      command: skipSmoke
        ? 'pnpm verify:multitable-pilot (skipped here; executed earlier by multitable-pilot-ready-local)'
        : 'pnpm verify:multitable-pilot',
      log: pilotSmokeReport || logPath,
    },
  ],
  generatedAt: new Date().toISOString(),
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
NODE
}

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

write_release_gate_report
