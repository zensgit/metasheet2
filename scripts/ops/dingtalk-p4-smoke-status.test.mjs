import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-status.mjs')
const requiredCheckIds = [
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'delivery-history-group-person',
  'no-email-user-create-bind',
]
const manualIds = new Set([
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'no-email-user-create-bind',
])

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-smoke-status-'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeEvidenceChecks(overrides = {}) {
  return requiredCheckIds.map((id) => ({
    id,
    status: overrides[id]?.status ?? 'pass',
    evidence: {
      source: manualIds.has(id) ? 'manual-client' : 'api-bootstrap',
      summary: `${id} ok`,
      ...overrides[id]?.evidence,
    },
  }))
}

function writeSession(sessionDir, options = {}) {
  const checkOverrides = options.checkOverrides ?? {}
  const checks = makeEvidenceChecks(checkOverrides)
  writeJson(path.join(sessionDir, 'workspace', 'evidence.json'), {
    runId: 'remote-142',
    checks,
  })
  const requiredChecks = checks.map((check) => ({
    id: check.id,
    status: check.status,
    evidence: check.evidence,
  }))
  const notPassed = requiredChecks
    .filter((check) => check.status !== 'pass')
    .map((check) => ({ id: check.id, status: check.status }))

  writeJson(path.join(sessionDir, 'compiled', 'summary.json'), {
    tool: 'compile-dingtalk-p4-smoke-evidence',
    overallStatus: notPassed.length === 0 && !options.manualEvidenceIssues?.length ? 'pass' : 'fail',
    apiBootstrapStatus: 'pass',
    remoteClientStatus: notPassed.length === 0 && !options.manualEvidenceIssues?.length ? 'pass' : 'fail',
    totals: {
      totalChecks: requiredCheckIds.length,
      requiredChecks: requiredCheckIds.length,
      passedChecks: requiredChecks.filter((check) => check.status === 'pass').length,
      failedChecks: requiredChecks.filter((check) => check.status === 'fail').length,
      skippedChecks: requiredChecks.filter((check) => check.status === 'skipped').length,
      pendingChecks: requiredChecks.filter((check) => check.status === 'pending').length,
      missingRequiredChecks: 0,
      unknownChecks: 0,
    },
    requiredChecks,
    missingRequiredChecks: [],
    requiredChecksNotPassed: notPassed,
    failedChecks: requiredChecks.filter((check) => check.status === 'fail').map((check) => check.id),
    unknownChecks: [],
    manualEvidenceIssues: options.manualEvidenceIssues ?? [],
  })

  writeJson(path.join(sessionDir, 'session-summary.json'), {
    tool: 'dingtalk-p4-smoke-session',
    runId: 'session-142',
    sessionPhase: options.sessionPhase ?? 'finalize',
    overallStatus: options.sessionOverallStatus ?? 'pass',
    finalStrictStatus: options.finalStrictStatus ?? 'pass',
    steps: options.steps ?? [
      { id: 'preflight', status: 'pass', exitCode: 0 },
      { id: 'api-runner', status: 'pass', exitCode: 0 },
      { id: 'compile', status: 'pass', exitCode: 0 },
      { id: 'strict-compile', status: options.finalStrictStatus === 'fail' ? 'fail' : 'pass', exitCode: options.finalStrictStatus === 'fail' ? 1 : 0 },
    ],
    pendingChecks: notPassed,
  })
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('dingtalk-p4-smoke-status reports manual pending gaps for bootstrap sessions', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeSession(sessionDir, {
      sessionPhase: 'bootstrap',
      sessionOverallStatus: 'manual_pending',
      finalStrictStatus: 'not_run',
      steps: [
        { id: 'preflight', status: 'pass', exitCode: 0 },
        { id: 'api-runner', status: 'pass', exitCode: 0 },
        { id: 'compile', status: 'pass', exitCode: 0 },
      ],
      checkOverrides: {
        'authorized-user-submit': {
          status: 'pending',
          evidence: {
            summary: 'open https://oapi.dingtalk.com/robot/send?access_token=secret-token-should-hide',
          },
        },
      },
    })

    const result = runScript(['--session-dir', sessionDir])

    assert.equal(result.status, 0, result.stderr)
    const summaryText = readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-token-should-hide/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.totals.gaps > 0, true)
    assert.equal(summary.requiredChecks.find((check) => check.id === 'authorized-user-submit').status, 'pending')
    assert.equal(summary.nextCommands.some((command) => command.includes('dingtalk-p4-evidence-record.mjs')), true)
    assert.equal(summary.nextCommands.some((command) => command.includes('--finalize')), true)
    assert.equal(existsSync(path.join(sessionDir, 'smoke-status.md')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status reports handoff pending after final strict pass', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeSession(sessionDir)

    const result = runScript(['--session-dir', sessionDir])

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'handoff_pending')
    assert.equal(summary.totals.gaps, 0)
    assert.equal(summary.nextCommands.some((command) => command.includes('dingtalk-p4-final-handoff.mjs')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status reports release ready with passing handoff and publish check', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const packetDir = path.join(tmpDir, 'packet')
  const handoffSummary = path.join(packetDir, 'handoff-summary.json')

  try {
    writeSession(sessionDir)
    writeJson(handoffSummary, {
      tool: 'dingtalk-p4-final-handoff',
      status: 'pass',
      publishCheck: {
        status: 'pass',
        secretFindings: [],
      },
      failures: [],
    })

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--handoff-summary',
      handoffSummary,
      '--require-release-ready',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = JSON.parse(readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'release_ready')
    assert.equal(summary.handoff.status, 'pass')
    assert.equal(summary.handoff.publishStatus, 'pass')
    assert.equal(summary.nextCommands.some((command) => command.includes('review the final packet')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status require-release-ready fails before handoff is ready', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeSession(sessionDir)

    const result = runScript(['--session-dir', sessionDir, '--require-release-ready'])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'handoff_pending')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status reports operational failures before gap states', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeJson(path.join(sessionDir, 'session-summary.json'), {
      tool: 'dingtalk-p4-smoke-session',
      sessionPhase: 'bootstrap',
      overallStatus: 'fail',
      finalStrictStatus: 'not_run',
      steps: [
        { id: 'preflight', status: 'fail', exitCode: 1 },
      ],
      pendingChecks: [],
    })

    const result = runScript(['--session-dir', sessionDir])

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.nextCommands.some((command) => command.includes('inspect failed steps')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status treats strict manual evidence issues as manual pending', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeSession(sessionDir, {
      sessionOverallStatus: 'fail',
      finalStrictStatus: 'fail',
      manualEvidenceIssues: [
        {
          id: 'authorized-user-submit',
          code: 'artifact_ref_missing',
          message: 'authorized-user-submit artifact file does not exist: Bearer very-secret-admin-token-should-hide',
        },
      ],
    })

    const result = runScript(['--session-dir', sessionDir])

    assert.equal(result.status, 0, result.stderr)
    const summaryText = readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8')
    assert.doesNotMatch(summaryText, /very-secret-admin-token-should-hide/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.requiredChecks.find((check) => check.id === 'authorized-user-submit').manualEvidenceIssueCount, 1)
    assert.equal(summary.nextCommands.some((command) => command.includes('--finalize')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-status rejects missing inputs', () => {
  const result = runScript([])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /provide --session-dir or at least one input file/)
})
