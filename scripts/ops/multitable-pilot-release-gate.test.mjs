import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

const repoRoot = '/Users/huazhou/Downloads/Github/metasheet2-multitable-next'

function createFakePnpm(binDir) {
  const fakePnpmPath = path.join(binDir, 'pnpm')
  fs.writeFileSync(
    fakePnpmPath,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "${FAKE_PNPM_LOG}"',
      'if [[ -n "${FAKE_PNPM_FAIL_MATCH:-}" && "$*" == *"${FAKE_PNPM_FAIL_MATCH}"* ]]; then',
      '  exit 42',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

test('multitable pilot release gate writes canonical gate report and keeps executed commands in sync', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const smokeReportPath = path.join(tmpRoot, 'smoke', 'report.json')
  const logPath = path.join(tmpRoot, 'gates', 'release-gate.log')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true })
  fs.writeFileSync(smokeReportPath, JSON.stringify({ ok: true }, null, 2))

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PNPM_LOG: fakePnpmLogPath,
      REPORT_JSON: reportPath,
      LOG_PATH: logPath,
      PILOT_SMOKE_REPORT: smokeReportPath,
      SKIP_MULTITABLE_PILOT_SMOKE: 'true',
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.ok, true)
  assert.equal(report.failedStep, null)
  assert.ok(Array.isArray(report.checks))

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.command, 'pnpm verify:multitable-pilot')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'skipped')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.note, 'executed earlier by multitable-pilot-ready-local')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.log, smokeReportPath)
  assert.equal(checksByName.get('openapi.multitable.parity')?.command, 'pnpm verify:multitable-openapi:parity')
  assert.equal(
    checksByName.get('web.vitest.multitable.contracts')?.command,
    'pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-client.spec.ts --reporter=dot',
  )

  const executedCommands = fs.readFileSync(fakePnpmLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((argv) => `pnpm ${argv}`)
  const reportCommands = report.checks
    .filter((check) => check.status !== 'skipped')
    .map((check) => check.command)
  assert.deepEqual(reportCommands, executedCommands)
})

test('multitable pilot release gate writes a failed report when a step exits non-zero', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-fail-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')

  assert.throws(() => {
    execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_PNPM_LOG: fakePnpmLogPath,
        FAKE_PNPM_FAIL_MATCH: '--filter @metasheet/core-backend build',
        REPORT_JSON: reportPath,
        LOG_PATH: path.join(tmpRoot, 'gates', 'release-gate.log'),
        SKIP_MULTITABLE_PILOT_SMOKE: 'true',
      },
      stdio: 'pipe',
    })
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.ok, false)
  assert.equal(report.exitCode, 42)
  assert.equal(report.failedStep, 'core-backend.build')

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('web.build')?.status, 'passed')
  assert.equal(checksByName.get('core-backend.build')?.status, 'failed')
  assert.equal(checksByName.get('web.vitest.multitable')?.status, 'not_run')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'skipped')
})
