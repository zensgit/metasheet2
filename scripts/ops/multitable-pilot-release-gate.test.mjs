import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

const repoRoot = '/Users/huazhou/Downloads/Github/metasheet2-multitable-next'

test('multitable pilot release gate writes canonical gate report', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  const fakePnpmPath = path.join(binDir, 'pnpm')
  fs.writeFileSync(fakePnpmPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const smokeReportPath = path.join(tmpRoot, 'smoke', 'report.json')
  const logPath = path.join(tmpRoot, 'gates', 'release-gate.log')
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true })
  fs.writeFileSync(smokeReportPath, JSON.stringify({ ok: true }, null, 2))

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REPORT_JSON: reportPath,
      LOG_PATH: logPath,
      PILOT_SMOKE_REPORT: smokeReportPath,
      SKIP_MULTITABLE_PILOT_SMOKE: 'true',
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.ok, true)
  assert.ok(Array.isArray(report.checks))

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(
    checksByName.get('web.vitest.multitable')?.command.includes('tests/multitable-people-import.spec.ts'),
    true,
  )
  assert.equal(
    checksByName.get('release-gate.multitable.live-smoke')?.command,
    'pnpm verify:multitable-pilot (skipped here; executed earlier by multitable-pilot-ready-local)',
  )
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.log, smokeReportPath)
  assert.equal(checksByName.get('web.build')?.log, logPath)
})
