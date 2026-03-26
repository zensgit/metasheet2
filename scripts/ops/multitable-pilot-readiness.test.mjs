import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

const repoRoot = '/Users/huazhou/Downloads/Github/metasheet2-multitable-next'
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
  'api.multitable.legacy-submit',
]

function writeFixtureReport(tmpRoot) {
  const smokeReportPath = path.join(tmpRoot, 'smoke.json')
  const profileReportPath = path.join(tmpRoot, 'profile.json')
  const readinessMdPath = path.join(tmpRoot, 'readiness.md')
  const readinessJsonPath = path.join(tmpRoot, 'readiness.json')

  fs.writeFileSync(smokeReportPath, JSON.stringify({
    ok: true,
    checks: requiredSmokeChecks.map((name) => ({ name, ok: true })),
  }, null, 2))
  fs.writeFileSync(profileReportPath, JSON.stringify({
    ok: true,
    rowCount: 2000,
    metrics: {
      'ui.grid.open': { durationMs: 180 },
      'ui.grid.search-hit': { durationMs: 80 },
      'api.grid.initial-load': { durationMs: 12 },
      'api.grid.search-hit': { durationMs: 9 },
    },
  }, null, 2))

  return {
    smokeReportPath,
    profileReportPath,
    readinessMdPath,
    readinessJsonPath,
  }
}

test('multitable pilot readiness fails when gate report is missing by default', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-readiness-missing-gate-'))
  const fixture = writeFixtureReport(tmpRoot)

  assert.throws(() => {
    execFileSync('node', ['scripts/ops/multitable-pilot-readiness.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SMOKE_REPORT_JSON: fixture.smokeReportPath,
        PROFILE_REPORT_JSON: fixture.profileReportPath,
        READINESS_MD: fixture.readinessMdPath,
        READINESS_JSON: fixture.readinessJsonPath,
      },
      stdio: 'pipe',
    })
  })

  const readiness = JSON.parse(fs.readFileSync(fixture.readinessJsonPath, 'utf8'))
  assert.equal(readiness.ok, false)
  assert.equal(readiness.gates.required, true)
  assert.equal(readiness.gates.missingReport, true)
})

test('multitable pilot readiness fails when gate report records a failed step', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-readiness-failed-gate-'))
  const fixture = writeFixtureReport(tmpRoot)
  const gateReportPath = path.join(tmpRoot, 'gate-report.json')

  fs.writeFileSync(gateReportPath, JSON.stringify({
    ok: false,
    exitCode: 1,
    failedStep: 'core-backend.build',
    checks: [
      { name: 'web.build', ok: true, status: 'passed', command: 'pnpm --filter @metasheet/web build' },
      { name: 'core-backend.build', ok: false, status: 'failed', command: 'pnpm --filter @metasheet/core-backend build' },
    ],
  }, null, 2))

  assert.throws(() => {
    execFileSync('node', ['scripts/ops/multitable-pilot-readiness.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SMOKE_REPORT_JSON: fixture.smokeReportPath,
        PROFILE_REPORT_JSON: fixture.profileReportPath,
        GATE_REPORT_JSON: gateReportPath,
        READINESS_MD: fixture.readinessMdPath,
        READINESS_JSON: fixture.readinessJsonPath,
      },
      stdio: 'pipe',
    })
  })

  const readiness = JSON.parse(fs.readFileSync(fixture.readinessJsonPath, 'utf8'))
  assert.equal(readiness.ok, false)
  assert.equal(readiness.gates.required, true)
  assert.equal(readiness.gates.missingReport, false)
  assert.equal(readiness.gates.failedStep, 'core-backend.build')
  assert.deepEqual(readiness.gates.missingChecks, ['core-backend.build'])
})

test('multitable pilot readiness can opt out of gate binding for ad hoc checks', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-readiness-optional-gate-'))
  const fixture = writeFixtureReport(tmpRoot)

  execFileSync('node', ['scripts/ops/multitable-pilot-readiness.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMOKE_REPORT_JSON: fixture.smokeReportPath,
      PROFILE_REPORT_JSON: fixture.profileReportPath,
      READINESS_MD: fixture.readinessMdPath,
      READINESS_JSON: fixture.readinessJsonPath,
      REQUIRE_GATE_REPORT: 'false',
    },
    stdio: 'pipe',
  })

  const readiness = JSON.parse(fs.readFileSync(fixture.readinessJsonPath, 'utf8'))
  assert.equal(readiness.ok, true)
  assert.equal(readiness.gates.required, false)
  assert.equal(readiness.gates.missingReport, true)
})
