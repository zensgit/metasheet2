import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
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

function createFakePnpm(binDir) {
  const fakePnpmPath = path.join(binDir, 'pnpm')
  fs.writeFileSync(
    fakePnpmPath,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "${FAKE_PNPM_LOG}"',
      'if [[ -n "${FAKE_PNPM_SMOKE_REPORT_TEMPLATE:-}" && "$*" == *"verify:multitable-pilot"* ]]; then',
      '  mkdir -p "${OUTPUT_ROOT}"',
      '  cp "${FAKE_PNPM_SMOKE_REPORT_TEMPLATE}" "${OUTPUT_ROOT}/report.json"',
      '  printf \'# smoke report\\n\' > "${SMOKE_REPORT_MD:-${REPORT_MD:-${OUTPUT_ROOT}/report.md}}"',
      'fi',
      'if [[ -n "${FAKE_PNPM_FAIL_MATCH:-}" && "$*" == *"${FAKE_PNPM_FAIL_MATCH}"* ]]; then',
      '  exit 42',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

function createSmokeReport(overrides = {}) {
  const checks = [
    ...embedHostProtocolChecks,
    ...embedHostNavigationChecks,
    ...embedHostDeferredChecks,
  ].map((name) => ({ name, ok: true }))
  return {
    ok: true,
    checks,
    ...overrides,
  }
}

test('multitable pilot release gate writes canonical gate report and keeps executed commands in sync', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const smokeReportPath = path.join(tmpRoot, 'smoke', 'report.json')
  const smokeReportMdPath = path.join(tmpRoot, 'smoke', 'report.md')
  const reportMdPath = path.join(tmpRoot, 'gates', 'report.md')
  const logPath = path.join(tmpRoot, 'gates', 'release-gate.log')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true })
  fs.writeFileSync(smokeReportPath, JSON.stringify(createSmokeReport(), null, 2))
  fs.writeFileSync(smokeReportMdPath, '# smoke report\n')

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PNPM_LOG: fakePnpmLogPath,
      REPORT_JSON: reportPath,
      LOG_PATH: logPath,
      PILOT_SMOKE_REPORT: smokeReportPath,
      PILOT_SMOKE_REPORT_MD: smokeReportMdPath,
      SKIP_MULTITABLE_PILOT_SMOKE: 'true',
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const reportMd = fs.readFileSync(reportMdPath, 'utf8')
  assert.equal(report.ok, true)
  assert.equal(report.failedStep, null)
  assert.ok(Array.isArray(report.checks))
  assert.match(report.outputRoot, /gates$/)
  assert.match(report.reportPath, /gates\/report\.json$/)
  assert.match(report.reportMdPath, /gates\/report\.md$/)
  assert.match(report.logPath, /gates\/release-gate\.log$/)
  assert.match(report.operatorCommandsPath, /gates\/operator-commands\.sh$/)
  assert.equal(fs.existsSync(report.logPath), true)
  assert.equal(fs.existsSync(report.operatorCommandsPath), true)
  assert.equal(report.liveSmoke.available, true)
  assert.equal(report.liveSmoke.ok, true)
  assert.match(report.liveSmoke.outputRoot, /smoke$/)
  assert.match(report.liveSmoke.reportMd, /smoke\/report\.md$/)
  assert.equal(report.embedHostAcceptance.ok, true)
  assert.equal(report.embedHostProtocol.available, true)
  assert.equal(report.embedHostNavigationProtection.ok, true)
  assert.equal(report.embedHostDeferredReplay.ok, true)
  assert.deepEqual(
    report.operatorCommands.map((item) => item.name),
    ['showArtifacts', 'rerunGate', 'rerunLiveSmoke', 'showLogTail'],
  )
  assert.equal(report.operatorChecklist.length, 4)
  assert.match(reportMd, /## Live Smoke Artifact/)
  assert.match(reportMd, /Output root: `.*gates`/)
  assert.match(reportMd, /Log path: `.*release-gate\.log`/)
  assert.match(reportMd, /Operator helper: `.*operator-commands\.sh`/)
  assert.match(reportMd, /Output root: `.*smoke`/)
  assert.match(reportMd, /Markdown: `.*smoke\/report\.md`/)
  assert.match(reportMd, /## Embed Host Acceptance/)
  assert.match(reportMd, /### Embed Host Busy Deferred Replay/)
  assert.match(reportMd, /## Operator Checklist/)
  assert.match(reportMd, /1\. Review the canonical gate report before promotion or replay/)
  assert.match(reportMd, /3\. Use the helper instead of rebuilding replay commands by hand/)
  assert.match(reportMd, /## Operator Commands/)
  assert.match(reportMd, /Show artifacts: `.*operator-commands\.sh show-artifacts`/)
  assert.match(reportMd, /Rerun gate: `.*operator-commands\.sh rerun-gate`/)
  assert.match(reportMd, /Rerun live smoke: `.*operator-commands\.sh rerun-live-smoke`/)
  assert.match(reportMd, /Tail log: `.*operator-commands\.sh show-log-tail`/)

  const helper = fs.readFileSync(report.operatorCommandsPath, 'utf8')
  assert.match(helper, /show-artifacts/)
  assert.match(helper, /rerun-gate/)
  assert.match(helper, /rerun-live-smoke/)
  assert.match(helper, /show-log-tail/)
  assert.match(helper, /LIVE_SMOKE_COMMAND="pnpm verify:multitable-pilot"/)
  const gateLog = fs.readFileSync(report.logPath, 'utf8')
  assert.match(gateLog, /\[gate\] run_mode=local/)
  assert.match(gateLog, /\[step\] name=web\.build status=running/)
  assert.match(gateLog, /\[step\] name=web\.build status=passed/)
  assert.match(gateLog, /\[step\] name=release-gate\.multitable\.live-smoke status=skipped/)

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.command, 'pnpm verify:multitable-pilot')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'skipped')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.note, 'executed earlier by multitable-pilot-ready-local')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.log, smokeReportPath)
  assert.equal(checksByName.get('openapi.multitable.parity')?.command, 'pnpm verify:multitable-openapi:parity')
  assert.equal(
    checksByName.get('web.vitest.multitable.contracts')?.command,
    'pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-embed-host.spec.ts tests/multitable-client.spec.ts tests/view-manager-multitable-contract.spec.ts --reporter=dot',
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

test('multitable pilot release gate writes deterministic local smoke artifacts when run directly', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-direct-local-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const outputRoot = path.join(tmpRoot, 'gate-output')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')
  const smokeTemplatePath = path.join(tmpRoot, 'smoke-template.json')
  fs.writeFileSync(smokeTemplatePath, JSON.stringify(createSmokeReport(), null, 2))

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PNPM_LOG: fakePnpmLogPath,
      FAKE_PNPM_SMOKE_REPORT_TEMPLATE: smokeTemplatePath,
      OUTPUT_ROOT: outputRoot,
    },
    stdio: 'pipe',
  })

  const reportPath = path.join(outputRoot, 'report.json')
  const reportMdPath = path.join(outputRoot, 'report.md')
  const smokeReportPath = path.join(outputRoot, 'smoke', 'report.json')
  const smokeReportMdPath = path.join(outputRoot, 'smoke', 'report.md')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const reportMd = fs.readFileSync(reportMdPath, 'utf8')

  assert.equal(report.ok, true)
  assert.match(report.outputRoot, /gate-output$/)
  assert.match(report.reportPath, /gate-output\/report\.json$/)
  assert.match(report.reportMdPath, /gate-output\/report\.md$/)
  assert.match(report.logPath, /gate-output\/release-gate\.log$/)
  assert.match(report.operatorCommandsPath, /gate-output\/operator-commands\.sh$/)
  assert.deepEqual(
    report.operatorCommands.map((item) => item.name),
    ['showArtifacts', 'rerunGate', 'rerunLiveSmoke', 'showLogTail'],
  )
  assert.match(report.liveSmoke.outputRoot, /gate-output\/smoke$/)
  assert.match(report.liveSmoke.report, /gate-output\/smoke\/report\.json$/)
  assert.match(report.liveSmoke.reportMd, /gate-output\/smoke\/report\.md$/)
  assert.equal(fs.existsSync(report.logPath), true)
  assert.equal(fs.existsSync(smokeReportPath), true)
  assert.equal(fs.existsSync(smokeReportMdPath), true)
  assert.equal(fs.existsSync(report.operatorCommandsPath), true)
  assert.match(reportMd, /JSON report: `.*gate-output\/report\.json`/)
  assert.match(reportMd, /Report: `.*gate-output\/smoke\/report\.json`/)
  assert.match(reportMd, /Markdown: `.*gate-output\/smoke\/report\.md`/)
  assert.match(reportMd, /Helper: `.*gate-output\/operator-commands\.sh`/)
  assert.match(reportMd, /Show artifacts: `.*gate-output\/operator-commands\.sh show-artifacts`/)
  assert.match(reportMd, /Rerun gate: `.*gate-output\/operator-commands\.sh rerun-gate`/)
  assert.match(reportMd, /Rerun live smoke: `.*gate-output\/operator-commands\.sh rerun-live-smoke`/)
  assert.match(reportMd, /Tail log: `.*gate-output\/operator-commands\.sh show-log-tail`/)

  const helper = fs.readFileSync(report.operatorCommandsPath, 'utf8')
  assert.match(helper, /OUTPUT_ROOT=".*gate-output"/)
  assert.match(helper, /PILOT_SMOKE_OUTPUT_ROOT=".*gate-output\/smoke"/)
  const gateLog = fs.readFileSync(report.logPath, 'utf8')
  assert.match(gateLog, /\[gate\] run_mode=local/)
  assert.match(gateLog, /\[step\] name=release-gate\.multitable\.live-smoke status=passed/)

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'passed')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.command, 'pnpm verify:multitable-pilot')
})

test('multitable pilot release gate writes deterministic staging smoke artifacts when run directly', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-direct-staging-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const outputRoot = path.join(tmpRoot, 'gate-output')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')
  const smokeTemplatePath = path.join(tmpRoot, 'smoke-template.json')
  fs.writeFileSync(smokeTemplatePath, JSON.stringify(createSmokeReport(), null, 2))

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PNPM_LOG: fakePnpmLogPath,
      FAKE_PNPM_SMOKE_REPORT_TEMPLATE: smokeTemplatePath,
      OUTPUT_ROOT: outputRoot,
      RUN_MODE: 'staging',
    },
    stdio: 'pipe',
  })

  const reportPath = path.join(outputRoot, 'report.json')
  const smokeReportPath = path.join(outputRoot, 'smoke', 'report.json')
  const smokeReportMdPath = path.join(outputRoot, 'smoke', 'report.md')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

  assert.equal(report.runMode, 'staging')
  assert.match(report.outputRoot, /gate-output$/)
  assert.match(report.logPath, /gate-output\/release-gate\.log$/)
  assert.match(report.operatorCommandsPath, /gate-output\/operator-commands\.sh$/)
  assert.deepEqual(
    report.operatorCommands.map((item) => item.name),
    ['showArtifacts', 'rerunGate', 'rerunLiveSmoke', 'showLogTail'],
  )
  assert.match(report.liveSmoke.outputRoot, /gate-output\/smoke$/)
  assert.match(report.liveSmoke.report, /gate-output\/smoke\/report\.json$/)
  assert.match(report.liveSmoke.reportMd, /gate-output\/smoke\/report\.md$/)
  assert.equal(fs.existsSync(report.logPath), true)
  assert.equal(fs.existsSync(smokeReportPath), true)
  assert.equal(fs.existsSync(smokeReportMdPath), true)
  assert.equal(fs.existsSync(report.operatorCommandsPath), true)

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'passed')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.command, 'pnpm verify:multitable-pilot:staging')
  const reportMd = fs.readFileSync(path.join(outputRoot, 'report.md'), 'utf8')
  assert.match(reportMd, /Helper: `.*gate-output\/operator-commands\.sh`/)
  assert.match(reportMd, /Rerun gate: `.*gate-output\/operator-commands\.sh rerun-gate`/)
  assert.match(reportMd, /Rerun live smoke: `.*gate-output\/operator-commands\.sh rerun-live-smoke`/)

  const helper = fs.readFileSync(report.operatorCommandsPath, 'utf8')
  assert.match(helper, /RUN_MODE="staging"/)
  assert.match(helper, /LIVE_SMOKE_COMMAND="pnpm verify:multitable-pilot:staging"/)
  const gateLog = fs.readFileSync(report.logPath, 'utf8')
  assert.match(gateLog, /\[gate\] run_mode=staging/)
  assert.match(gateLog, /\[step\] name=release-gate\.multitable\.live-smoke status=passed/)
})

test('multitable pilot release gate switches skipped smoke metadata to staging mode when RUN_MODE=staging', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-staging-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const smokeReportPath = path.join(tmpRoot, 'smoke', 'report.json')
  const smokeReportMdPath = path.join(tmpRoot, 'smoke', 'report.md')
  const reportMdPath = path.join(tmpRoot, 'gates', 'report.md')
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true })
  fs.writeFileSync(smokeReportPath, JSON.stringify(createSmokeReport(), null, 2))
  fs.writeFileSync(smokeReportMdPath, '# smoke report\n')

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REPORT_JSON: reportPath,
      PILOT_SMOKE_REPORT: smokeReportPath,
      PILOT_SMOKE_REPORT_MD: smokeReportMdPath,
      SKIP_MULTITABLE_PILOT_SMOKE: 'true',
      RUN_MODE: 'staging',
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const reportMd = fs.readFileSync(reportMdPath, 'utf8')
  const checksByName = new Map(report.checks.map((check) => [check.name, check]))

  assert.equal(report.runMode, 'staging')
  assert.match(report.liveSmoke.reportMd, /smoke\/report\.md$/)
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.command, 'pnpm verify:multitable-pilot:staging')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.note, 'executed earlier by multitable-pilot-ready-staging')
  assert.match(reportMd, /Run mode: `staging`/)
})

test('multitable pilot release gate writes a failed report when a step exits non-zero', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-fail-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const reportMdPath = path.join(tmpRoot, 'gates', 'report.md')
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
  const reportMd = fs.readFileSync(reportMdPath, 'utf8')
  assert.equal(report.ok, false)
  assert.equal(report.exitCode, 42)
  assert.equal(report.failedStep, 'core-backend.build')
  assert.match(report.operatorCommandsPath, /gates\/operator-commands\.sh$/)
  assert.match(report.logPath, /gates\/release-gate\.log$/)
  assert.equal(fs.existsSync(report.logPath), true)
  assert.equal(fs.existsSync(report.operatorCommandsPath), true)
  assert.match(reportMd, /Failed step: `core-backend\.build`/)

  const checksByName = new Map(report.checks.map((check) => [check.name, check]))
  assert.equal(checksByName.get('web.build')?.status, 'passed')
  assert.equal(checksByName.get('core-backend.build')?.status, 'failed')
  assert.equal(checksByName.get('web.vitest.multitable')?.status, 'not_run')
  assert.equal(checksByName.get('release-gate.multitable.live-smoke')?.status, 'skipped')
  const gateLog = fs.readFileSync(report.logPath, 'utf8')
  assert.match(gateLog, /\[step\] name=web\.build status=passed/)
  assert.match(gateLog, /\[step\] name=core-backend\.build status=failed exit=42/)
})

test('multitable pilot release gate fails the canonical report when skipped smoke lacks required embed-host evidence', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-gate-embed-fail-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakePnpm(binDir)

  const reportPath = path.join(tmpRoot, 'gates', 'report.json')
  const reportMdPath = path.join(tmpRoot, 'gates', 'report.md')
  const smokeReportPath = path.join(tmpRoot, 'smoke', 'report.json')
  const smokeReportMdPath = path.join(tmpRoot, 'smoke', 'report.md')
  const fakePnpmLogPath = path.join(tmpRoot, 'fake-pnpm.log')
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true })
  const smokeReport = createSmokeReport({
    checks: createSmokeReport().checks.filter((check) => check.name !== 'api.embed-host.persisted-busy-form-save'),
  })
  fs.writeFileSync(smokeReportPath, JSON.stringify(smokeReport, null, 2))
  fs.writeFileSync(smokeReportMdPath, '# smoke report\n')

  execFileSync('bash', ['scripts/ops/multitable-pilot-release-gate.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PNPM_LOG: fakePnpmLogPath,
      REPORT_JSON: reportPath,
      PILOT_SMOKE_REPORT: smokeReportPath,
      PILOT_SMOKE_REPORT_MD: smokeReportMdPath,
      SKIP_MULTITABLE_PILOT_SMOKE: 'true',
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const reportMd = fs.readFileSync(reportMdPath, 'utf8')
  assert.equal(report.ok, false)
  assert.equal(report.failedStep, null)
  assert.deepEqual(report.failingEvidence, ['embedHostDeferredReplay'])
  assert.equal(report.embedHostDeferredReplay.available, true)
  assert.deepEqual(report.embedHostDeferredReplay.missingChecks, ['api.embed-host.persisted-busy-form-save'])
  assert.match(reportMd, /Failing evidence: `embedHostDeferredReplay`/)
})
