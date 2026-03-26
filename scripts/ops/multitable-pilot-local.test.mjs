import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

const repoRoot = '/Users/huazhou/Downloads/Github/metasheet2-multitable-next'

const embedHostProtocolChecks = [
  'ui.embed-host.ready',
  'ui.embed-host.state-query.initial',
  'ui.embed-host.navigate.generated-request-id',
  'ui.embed-host.navigate.applied',
  'ui.embed-host.navigate.explicit-request-id',
  'ui.embed-host.state-query.final',
]

const embedHostNavigationChecks = [
  'ui.embed-host.form-ready',
  'ui.embed-host.form-draft',
  'ui.embed-host.navigate.blocked-dialog',
  'ui.embed-host.navigate.blocked',
  'ui.embed-host.navigate.confirm-dialog',
  'ui.embed-host.navigate.confirmed',
  'api.embed-host.discard-unsaved-form-draft',
]

const embedHostDeferredChecks = [
  'ui.embed-host.navigate.deferred',
  'ui.embed-host.navigate.superseded',
  'ui.embed-host.state-query.deferred',
  'ui.embed-host.navigate.replayed',
  'api.embed-host.persisted-busy-form-save',
]

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 })
}

function createFakeBin(binDir) {
  writeExecutable(
    path.join(binDir, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'exit 0',
      '',
    ].join('\n'),
  )

  writeExecutable(
    path.join(binDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'exit 0',
      '',
    ].join('\n'),
  )
}

function createRunnerScript(filePath, { writeReport = true } = {}) {
  const report = {
    ok: true,
    checks: [
      ...embedHostProtocolChecks,
      ...embedHostNavigationChecks,
      ...embedHostDeferredChecks,
    ].map((name) => ({ name, ok: true })),
  }
  writeExecutable(
    filePath,
    [
      'import fs from "node:fs"',
      'import path from "node:path"',
      writeReport
        ? `fs.mkdirSync(path.dirname(process.env.REPORT_JSON), { recursive: true }); fs.writeFileSync(process.env.REPORT_JSON, ${JSON.stringify(JSON.stringify(report, null, 2) + '\n')});`
        : 'process.stdout.write("runner finished without report\\n")',
      '',
    ].join('\n'),
  )
}

test('multitable pilot local writes local report with embed-host summary when runner report exists', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-pilot-local-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakeBin(binDir)

  const runnerScript = path.join(tmpRoot, 'runner.mjs')
  createRunnerScript(runnerScript, { writeReport: true })

  const outputRoot = path.join(tmpRoot, 'output')
  execFileSync('bash', ['scripts/ops/multitable-pilot-local.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ENSURE_PLAYWRIGHT: 'false',
      OUTPUT_ROOT: outputRoot,
      RUNNER_SCRIPT: runnerScript,
      API_BASE: 'http://127.0.0.1:7778',
      WEB_BASE: 'http://127.0.0.1:8899',
    },
    stdio: 'pipe',
  })

  const localReportJsonPath = path.join(outputRoot, 'local-report.json')
  const localReportMdPath = path.join(outputRoot, 'local-report.md')
  const localReport = JSON.parse(fs.readFileSync(localReportJsonPath, 'utf8'))
  const localReportMd = fs.readFileSync(localReportMdPath, 'utf8')

  assert.equal(localReport.ok, true)
  assert.equal(localReport.runnerReport.ok, true)
  assert.equal(localReport.serviceModes.backend, 'reused')
  assert.equal(localReport.serviceModes.web, 'reused')
  assert.equal(localReport.embedHostAcceptance.ok, true)
  assert.equal(localReport.embedHostDeferredReplay.ok, true)
  assert.match(localReportMd, /## Embed Host Acceptance/)
  assert.match(localReportMd, /### Embed Host Busy Deferred Replay/)
})

test('multitable pilot local fails when runner exits without writing report.json', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-pilot-local-missing-report-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakeBin(binDir)

  const runnerScript = path.join(tmpRoot, 'runner.mjs')
  createRunnerScript(runnerScript, { writeReport: false })

  const outputRoot = path.join(tmpRoot, 'output')
  assert.throws(() => {
    execFileSync('bash', ['scripts/ops/multitable-pilot-local.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ENSURE_PLAYWRIGHT: 'false',
        OUTPUT_ROOT: outputRoot,
        RUNNER_SCRIPT: runnerScript,
        API_BASE: 'http://127.0.0.1:7778',
        WEB_BASE: 'http://127.0.0.1:8899',
      },
      stdio: 'pipe',
    })
  })

  assert.equal(fs.existsSync(path.join(outputRoot, 'local-report.json')), false)
  assert.equal(fs.existsSync(path.join(outputRoot, 'local-report.md')), false)
})

test('multitable pilot local refuses to auto-start services when AUTO_START_SERVICES=false', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-pilot-local-no-autostart-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakeBin(binDir)

  writeExecutable(
    path.join(binDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'exit 22',
      '',
    ].join('\n'),
  )

  const runnerScript = path.join(tmpRoot, 'runner.mjs')
  createRunnerScript(runnerScript, { writeReport: true })

  assert.throws(() => {
    execFileSync('bash', ['scripts/ops/multitable-pilot-local.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ENSURE_PLAYWRIGHT: 'false',
        OUTPUT_ROOT: path.join(tmpRoot, 'output'),
        RUNNER_SCRIPT: runnerScript,
        API_BASE: 'http://127.0.0.1:7778',
        WEB_BASE: 'http://127.0.0.1:8899',
        AUTO_START_SERVICES: 'false',
      },
      stdio: 'pipe',
    })
  })
})
