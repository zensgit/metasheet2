import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-final-closeout.mjs')
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
const manualClientIds = new Set([
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
])
const manualAdminIds = new Set(['no-email-user-create-bind'])

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-final-closeout-'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function artifactRef(sessionDir, checkId, file = 'evidence.txt') {
  const ref = `artifacts/${checkId}/${file}`
  const fullPath = path.join(sessionDir, 'workspace', ref)
  mkdirSync(path.dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, `${checkId} proof\n`, 'utf8')
  return ref
}

function evidenceForCheck(sessionDir, id) {
  const evidence = {
    source: manualClientIds.has(id)
      ? 'manual-client'
      : manualAdminIds.has(id)
        ? 'manual-admin'
        : 'api-bootstrap',
    operator: 'qa',
    performedAt: '2026-04-23T10:00:00.000Z',
    summary: `${id} verified`,
  }

  if (manualClientIds.has(id) || manualAdminIds.has(id)) {
    evidence.artifacts = [artifactRef(sessionDir, id)]
  }
  if (id === 'unauthorized-user-denied') {
    evidence.submitBlocked = true
    evidence.recordInsertDelta = 0
    evidence.blockedReason = 'Visible error showed the user is not in the allowlist.'
  }
  return evidence
}

function writeReadyForFinalizeSession(sessionDir, overrides = {}) {
  const checks = requiredCheckIds.map((id) => ({
    id,
    status: 'pass',
    evidence: evidenceForCheck(sessionDir, id),
  }))
  writeJson(path.join(sessionDir, 'workspace', 'evidence.json'), {
    runId: 'remote-142',
    checks,
  })
  writeJson(path.join(sessionDir, 'session-summary.json'), {
    tool: 'dingtalk-p4-smoke-session',
    runId: 'session-142',
    sessionPhase: 'bootstrap',
    overallStatus: 'manual_pending',
    finalStrictStatus: 'not_run',
    steps: [
      { id: 'preflight', status: 'pass', exitCode: 0 },
      { id: 'api-runner', status: 'pass', exitCode: 0 },
      { id: 'compile', status: 'pass', exitCode: 0 },
    ],
    pendingChecks: [],
    ...overrides.sessionSummary,
  })
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, /secret-admin-token/)
  assert.doesNotMatch(text, /robot-secret/)
  assert.doesNotMatch(text, /SECabcdefghijklmnop/)
}

test('dingtalk-p4-final-closeout finalizes, hands off, gates release-ready, and writes final docs', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const packetDir = path.join(tmpDir, 'packet')
  const docsDir = path.join(tmpDir, 'docs')

  try {
    writeReadyForFinalizeSession(sessionDir)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--packet-output-dir',
      packetDir,
      '--docs-output-dir',
      docsDir,
      '--date',
      '20260423',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summaryPath = path.join(packetDir, 'closeout-summary.json')
    assert.equal(existsSync(summaryPath), true)
    assert.equal(existsSync(path.join(packetDir, 'closeout-summary.md')), true)
    assert.equal(existsSync(path.join(packetDir, 'handoff-summary.json')), true)
    assert.equal(existsSync(path.join(packetDir, 'publish-check.json')), true)
    assert.equal(existsSync(path.join(docsDir, 'dingtalk-final-remote-smoke-development-20260423.md')), true)
    assert.equal(existsSync(path.join(docsDir, 'dingtalk-final-remote-smoke-verification-20260423.md')), true)

    const summaryText = readFileSync(summaryPath, 'utf8')
    assertNoSecrets(summaryText)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.status, 'pass')
    assert.deepEqual(summary.steps.map((step) => step.id), [
      'finalize-session',
      'final-handoff',
      'release-ready-status',
      'final-docs',
    ])
    assert.equal(summary.final.sessionPhase, 'finalize')
    assert.equal(summary.final.finalStrictStatus, 'pass')
    assert.equal(summary.final.smokeStatus, 'release_ready')
    assert.equal(summary.final.handoffStatus, 'pass')
    assert.equal(summary.final.publishStatus, 'pass')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-closeout can stop after release-ready status when docs are skipped', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const packetDir = path.join(tmpDir, 'packet')
  const docsDir = path.join(tmpDir, 'docs')

  try {
    writeReadyForFinalizeSession(sessionDir)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--packet-output-dir',
      packetDir,
      '--docs-output-dir',
      docsDir,
      '--date',
      '20260423',
      '--skip-docs',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = JSON.parse(readFileSync(path.join(packetDir, 'closeout-summary.json'), 'utf8'))
    assert.equal(summary.status, 'pass')
    assert.deepEqual(summary.steps.map((step) => step.id), [
      'finalize-session',
      'final-handoff',
      'release-ready-status',
    ])
    assert.equal(existsSync(path.join(docsDir, 'dingtalk-final-remote-smoke-development-20260423.md')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-closeout fails early and writes a summary when finalize fails', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const packetDir = path.join(tmpDir, 'packet')

  try {
    writeReadyForFinalizeSession(sessionDir)
    const evidence = JSON.parse(readFileSync(path.join(sessionDir, 'workspace', 'evidence.json'), 'utf8'))
    evidence.checks.find((check) => check.id === 'authorized-user-submit').evidence.artifacts = []
    writeJson(path.join(sessionDir, 'workspace', 'evidence.json'), evidence)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--packet-output-dir',
      packetDir,
      '--date',
      '20260423',
    ])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(packetDir, 'closeout-summary.json'), 'utf8'))
    assert.equal(summary.status, 'fail')
    assert.deepEqual(summary.steps.map((step) => step.id), ['finalize-session'])
    assert.equal(summary.steps[0].status, 'fail')
    assert.equal(existsSync(path.join(packetDir, 'handoff-summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-closeout rejects overlapping packet output directory', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')

  try {
    writeReadyForFinalizeSession(sessionDir)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--packet-output-dir',
      path.join(sessionDir, 'packet'),
      '--date',
      '20260423',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--packet-output-dir must not be the session directory/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
