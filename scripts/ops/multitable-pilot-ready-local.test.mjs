import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const requiredSmokeChecks = [
  'ui.route.grid-entry',
  'ui.route.form-entry',
  'ui.import.failed-retry',
  'ui.import.mapping-reconcile',
  'ui.import.people-repair-reconcile',
  'ui.import.people-manual-fix',
  'api.import.people-manual-fix-hydration',
  'ui.person.assign',
  'ui.form.upload-comments',
  'api.form.attachment-delete-clear',
  'ui.grid.search-hydration',
  'ui.conflict.retry',
  'ui.field-manager.prop-reconcile',
  'ui.field-manager.type-reconcile',
  'ui.field-manager.target-removal',
  'ui.view-manager.prop-reconcile',
  'ui.view-manager.field-schema-reconcile',
  'ui.view-manager.target-removal',
  'ui.gallery.config-replay',
  'ui.calendar.config-replay',
  'ui.timeline.config-replay',
  'ui.kanban.config-replay',
  'ui.kanban.empty-card-fields-replay',
  'ui.kanban.clear-group-replay',
  'api.multitable.view-submit',
]

const embedHostProtocolChecks = [
  'ui.embed-host.ready',
  'ui.embed-host.state-query.initial',
  'ui.embed-host.navigate.generated-request-id',
  'ui.embed-host.navigate.applied',
  'ui.embed-host.navigate.explicit-request-id',
  'ui.embed-host.state-query.final',
]

const embedHostNavigationProtectionChecks = [
  'ui.embed-host.form-ready',
  'ui.embed-host.form-draft',
  'ui.embed-host.navigate.blocked-dialog',
  'ui.embed-host.navigate.blocked',
  'ui.embed-host.navigate.confirm-dialog',
  'ui.embed-host.navigate.confirmed',
  'api.embed-host.discard-unsaved-form-draft',
]

const embedHostDeferredReplayChecks = [
  'ui.embed-host.navigate.deferred',
  'ui.embed-host.navigate.superseded',
  'ui.embed-host.state-query.deferred',
  'ui.embed-host.navigate.replayed',
  'api.embed-host.persisted-busy-form-save',
]

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 })
}

test('multitable pilot ready local accepts local baseline profile defaults and writes readiness', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-ready-local-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  const smokeFixturePath = path.join(tmpRoot, 'fixtures', 'smoke-report.json')
  const runnerFixturePath = path.join(tmpRoot, 'fixtures', 'local-report.json')
  const runnerMdFixturePath = path.join(tmpRoot, 'fixtures', 'local-report.md')
  const profileFixturePath = path.join(tmpRoot, 'fixtures', 'profile-report.json')
  const profileSummaryFixturePath = path.join(tmpRoot, 'fixtures', 'profile-summary.md')
  const gateEnvLogPath = path.join(tmpRoot, 'gate-env.log')
  fs.mkdirSync(path.dirname(smokeFixturePath), { recursive: true })

  fs.writeFileSync(smokeFixturePath, JSON.stringify({
    ok: true,
    checks: [
      ...requiredSmokeChecks,
      ...embedHostProtocolChecks,
      ...embedHostNavigationProtectionChecks,
      ...embedHostDeferredReplayChecks,
    ].map((name) => ({ name, ok: true })),
  }, null, 2))
  fs.writeFileSync(runnerFixturePath, JSON.stringify({
    ok: true,
    runMode: 'local',
    serviceModes: {
      backend: 'reused',
      web: 'reused',
    },
    runnerReport: {
      path: '/tmp/raw-smoke-report.json',
    },
    embedHostAcceptance: {
      available: true,
      ok: true,
    },
  }, null, 2))
  fs.writeFileSync(runnerMdFixturePath, '# local report\n')
  fs.writeFileSync(profileFixturePath, JSON.stringify({
    ok: true,
    rowCount: 2000,
    metrics: {
      'ui.grid.open': { durationMs: 480 },
      'ui.grid.search-hit': { durationMs: 290 },
      'api.grid.initial-load': { durationMs: 70 },
      'api.grid.search-hit': { durationMs: 68 },
    },
  }, null, 2))
  fs.writeFileSync(profileSummaryFixturePath, '# profile\n')

  writeExecutable(
    path.join(binDir, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'case "${cmd}" in',
      '  verify:multitable-pilot:local)',
      '    mkdir -p "${OUTPUT_ROOT}"',
      '    cp "${FAKE_SMOKE_REPORT}" "${OUTPUT_ROOT}/report.json"',
      '    cp "${FAKE_RUNNER_REPORT}" "${OUTPUT_ROOT}/${RUNNER_REPORT_BASENAME}.json"',
      '    cp "${FAKE_RUNNER_REPORT_MD}" "${OUTPUT_ROOT}/${RUNNER_REPORT_BASENAME}.md"',
      '    ;;',
      '  profile:multitable-grid:local)',
      '    mkdir -p "${OUTPUT_ROOT}"',
      '    cp "${FAKE_PROFILE_REPORT}" "${OUTPUT_ROOT}/report.json"',
      '    cp "${FAKE_PROFILE_SUMMARY}" "${OUTPUT_ROOT}/summary.md"',
      '    ;;',
      '  verify:multitable-grid-profile:summary)',
      `    exec node ${repoRoot}/scripts/ops/multitable-grid-profile-summary.mjs`,
      '    ;;',
      '  *)',
      '    echo "unexpected pnpm command: ${cmd}" >&2',
      '    exit 1',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  )

  writeExecutable(
    path.join(binDir, 'bash'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "scripts/ops/multitable-pilot-release-gate.sh" ]]; then',
      '  printf "RUN_MODE=%s\\nREPORT_MD=%s\\nLOG_PATH=%s\\n" "${RUN_MODE:-}" "${REPORT_MD:-}" "${LOG_PATH:-}" > "${FAKE_GATE_ENV_LOG}"',
      '  mkdir -p "$(dirname "${REPORT_JSON}")"',
      "  printf '%s\\n' '{\"ok\":true,\"checks\":[]}' > \"${REPORT_JSON}\"",
      "  printf '%s\\n' '# gate' > \"${REPORT_MD}\"",
      "  printf '%s\\n' 'gate log' > \"${LOG_PATH}\"",
      '  exit 0',
      'fi',
      'exec /bin/bash "$@"',
      '',
    ].join('\n'),
  )

  const outputRoot = path.join(tmpRoot, 'ready-local')
  execFileSync('bash', ['scripts/ops/multitable-pilot-ready-local.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      OUTPUT_ROOT: outputRoot,
      FAKE_SMOKE_REPORT: smokeFixturePath,
      FAKE_RUNNER_REPORT: runnerFixturePath,
      FAKE_RUNNER_REPORT_MD: runnerMdFixturePath,
      FAKE_PROFILE_REPORT: profileFixturePath,
      FAKE_PROFILE_SUMMARY: profileSummaryFixturePath,
      FAKE_GATE_ENV_LOG: gateEnvLogPath,
      RUNNER_REPORT_BASENAME: 'local-report',
      PROFILE_RETRY_ON_FAIL: 'false',
      PROFILE_USE_PREVIEW: 'false',
    },
    stdio: 'pipe',
  })

  const readiness = JSON.parse(fs.readFileSync(path.join(outputRoot, 'readiness.json'), 'utf8'))
  const readinessMd = fs.readFileSync(path.join(outputRoot, 'readiness.md'), 'utf8')
  const profileSummary = fs.readFileSync(path.join(outputRoot, 'profile', 'summary.md'), 'utf8')

  assert.equal(readiness.ok, true)
  assert.equal(readiness.pilotRunner.runMode, 'local')
  assert.equal(readiness.localRunner.runMode, 'local')
  assert.match(readiness.localRunner.report, /local-report\.json$/)
  assert.match(readinessMd, /## Pilot Runner/)
  assert.match(readinessMd, /Run mode: `local`/)
  assert.match(fs.readFileSync(gateEnvLogPath, 'utf8'), /RUN_MODE=local/)
  assert.match(fs.readFileSync(gateEnvLogPath, 'utf8'), /REPORT_MD=.*gates\/report\.md/)
  assert.match(fs.readFileSync(gateEnvLogPath, 'utf8'), /LOG_PATH=.*gates\/release-gate\.log/)
  assert.match(profileSummary, /`ui\.grid\.open` \| 480\.00 ms \| 500\.00 ms \| PASS/)
  assert.match(profileSummary, /`api\.grid\.initial-load` \| 70\.00 ms \| 75\.00 ms \| PASS/)
  assert.match(profileSummary, /`api\.grid\.search-hit` \| 68\.00 ms \| 75\.00 ms \| PASS/)

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
