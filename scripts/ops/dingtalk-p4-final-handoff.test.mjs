import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-final-handoff.mjs')
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

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-final-handoff-'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeFinalSession(sessionDir, overrides = {}) {
  writeJson(path.join(sessionDir, 'workspace', 'evidence.json'), {
    checks: requiredCheckIds.map((id) => ({ id, status: 'pass' })),
  })
  writeJson(path.join(sessionDir, 'session-summary.json'), {
    tool: 'dingtalk-p4-smoke-session',
    sessionPhase: 'finalize',
    overallStatus: 'pass',
    finalStrictStatus: 'pass',
    steps: [
      { id: 'preflight', status: 'pass', exitCode: 0 },
      { id: 'api-runner', status: 'pass', exitCode: 0 },
      { id: 'compile', status: 'pass', exitCode: 0 },
      { id: 'strict-compile', status: 'pass', exitCode: 0 },
    ],
    pendingChecks: [],
    ...overrides.sessionSummary,
  })
  writeJson(path.join(sessionDir, 'compiled', 'summary.json'), {
    tool: 'compile-dingtalk-p4-smoke-evidence',
    overallStatus: 'pass',
    apiBootstrapStatus: 'pass',
    remoteClientStatus: 'pass',
    totals: {
      totalChecks: requiredCheckIds.length,
      requiredChecks: requiredCheckIds.length,
      passedChecks: requiredCheckIds.length,
      failedChecks: 0,
      skippedChecks: 0,
      pendingChecks: 0,
      missingRequiredChecks: 0,
      unknownChecks: 0,
    },
    requiredChecks: requiredCheckIds.map((id) => ({ id, status: 'pass' })),
    missingRequiredChecks: [],
    requiredChecksNotPassed: [],
    failedChecks: [],
    unknownChecks: [],
    manualEvidenceIssues: [],
    ...overrides.compiledSummary,
  })
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('dingtalk-p4-final-handoff exports, validates, and summarizes a final session', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const outputDir = path.join(tmpDir, 'packet')

  try {
    writeFinalSession(sessionDir)

    const result = runScript(['--session-dir', sessionDir, '--output-dir', outputDir])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), true)
    assert.equal(existsSync(path.join(outputDir, 'publish-check.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'handoff-summary.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'handoff-summary.md')), true)

    const publishCheck = JSON.parse(readFileSync(path.join(outputDir, 'publish-check.json'), 'utf8'))
    assert.equal(publishCheck.status, 'pass')
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'handoff-summary.json'), 'utf8'))
    assert.equal(summary.status, 'pass')
    assert.deepEqual(summary.steps.map((step) => step.id), ['export-packet', 'validate-packet'])
    assert.equal(summary.steps.every((step) => step.status === 'pass'), true)
    assert.equal(summary.publishCheck.status, 'pass')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff fails and writes summary when export gate fails', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const outputDir = path.join(tmpDir, 'packet')

  try {
    writeFinalSession(sessionDir, {
      sessionSummary: {
        overallStatus: 'fail',
        finalStrictStatus: 'fail',
        steps: [
          { id: 'preflight', status: 'pass', exitCode: 0 },
          { id: 'api-runner', status: 'pass', exitCode: 0 },
          { id: 'compile', status: 'pass', exitCode: 0 },
          { id: 'strict-compile', status: 'fail', exitCode: 1 },
        ],
      },
    })

    const result = runScript(['--session-dir', sessionDir, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.equal(existsSync(path.join(outputDir, 'handoff-summary.json')), true)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'handoff-summary.json'), 'utf8'))
    assert.equal(summary.status, 'fail')
    assert.deepEqual(summary.steps.map((step) => step.id), ['export-packet'])
    assert.equal(summary.steps[0].status, 'fail')
    assert.equal(summary.failures.some((failure) => failure.includes('export-packet failed')), true)
    assert.equal(existsSync(path.join(outputDir, 'publish-check.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff fails validation without leaking secret previews into summary', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const outputDir = path.join(tmpDir, 'packet')
  const rawWebhook = 'https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef'
  const rawSecret = 'SECabcdefghijklmnop12345678'

  try {
    writeFinalSession(sessionDir)
    const artifactDir = path.join(sessionDir, 'workspace', 'artifacts', 'send-group-message-form-link')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(path.join(artifactDir, 'leaked.txt'), `${rawWebhook}\n${rawSecret}\n`, 'utf8')

    const result = runScript(['--session-dir', sessionDir, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'handoff-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /0123456789abcdef0123456789abcdef/)
    assert.doesNotMatch(summaryText, /SECabcdefghijklmnop12345678/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.status, 'fail')
    assert.deepEqual(summary.steps.map((step) => step.id), ['export-packet', 'validate-packet'])
    assert.equal(summary.steps[1].status, 'fail')
    assert.equal(summary.publishCheck.status, 'fail')
    assert.equal(summary.publishCheck.secretFindings.some((finding) => finding.preview === '<redacted>'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff clears stale publish check before failed rerun', () => {
  const tmpDir = makeTmpDir()
  const validSessionDir = path.join(tmpDir, '142-session-valid')
  const invalidSessionDir = path.join(tmpDir, '142-session-invalid')
  const outputDir = path.join(tmpDir, 'packet')

  try {
    writeFinalSession(validSessionDir)
    const firstResult = runScript(['--session-dir', validSessionDir, '--output-dir', outputDir])
    assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout)
    assert.equal(existsSync(path.join(outputDir, 'publish-check.json')), true)

    writeFinalSession(invalidSessionDir, {
      sessionSummary: {
        overallStatus: 'fail',
        finalStrictStatus: 'fail',
        steps: [
          { id: 'preflight', status: 'pass', exitCode: 0 },
          { id: 'api-runner', status: 'pass', exitCode: 0 },
          { id: 'compile', status: 'pass', exitCode: 0 },
          { id: 'strict-compile', status: 'fail', exitCode: 1 },
        ],
      },
    })
    const secondResult = runScript(['--session-dir', invalidSessionDir, '--output-dir', outputDir])

    assert.equal(secondResult.status, 1)
    assert.equal(existsSync(path.join(outputDir, 'publish-check.json')), false)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'handoff-summary.json'), 'utf8'))
    assert.equal(summary.status, 'fail')
    assert.equal(summary.publishCheck, null)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff requires session-dir', () => {
  const result = runScript([])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--session-dir is required/)
})

test('dingtalk-p4-final-handoff rejects missing session directory and writes configured summary', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')

  try {
    const result = runScript(['--session-dir', path.join(tmpDir, 'missing'), '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--session-dir must point to an existing directory/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'handoff-summary.json'), 'utf8'))
    assert.equal(summary.status, 'fail')
    assert.equal(summary.failures.some((failure) => failure.includes('--session-dir must point')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff rejects overlapping output and session paths', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const outputDir = path.join(sessionDir, 'packet')

  try {
    writeFinalSession(sessionDir)

    const result = runScript(['--session-dir', sessionDir, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--output-dir must not be the session directory or overlap with it/)
    assert.equal(existsSync(path.join(outputDir, 'handoff-summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-handoff rejects unknown arguments', () => {
  const result = runScript(['--unknown'])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown argument: --unknown/)
})
