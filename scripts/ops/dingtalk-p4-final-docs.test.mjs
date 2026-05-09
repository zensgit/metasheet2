import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-final-docs.mjs')
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
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-final-docs-'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base
  const next = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = deepMerge(base[key], value)
    } else {
      next[key] = value
    }
  }
  return next
}

function releaseReadyChecks() {
  return requiredCheckIds.map((id, index) => ({
    id,
    docSection: `Smoke ${index + 1}`,
    topLevelLabel: id,
    status: 'pass',
    source: id.includes('user') || id.includes('link') ? 'manual-client' : 'api-bootstrap',
    evidenceSnapshot: {
      id,
      source: id.includes('user') || id.includes('link') ? 'manual-client' : 'api-bootstrap',
    },
    manualEvidenceIssueCount: 0,
  }))
}

function writeReleaseReadySession(rootDir, overrides = {}) {
  const sessionDir = path.join(rootDir, '142-session')
  const packetDir = path.join(rootDir, 'packet')
  const checks = releaseReadyChecks()
  const sessionSummary = deepMerge({
    tool: 'dingtalk-p4-smoke-session',
    runId: 'session-142',
    sessionPhase: 'finalize',
    overallStatus: 'pass',
    remoteSmokePhase: 'finalize_pending',
    finalStrictStatus: 'pass',
    pendingChecks: [],
    steps: [
      { id: 'preflight', status: 'pass', exitCode: 0 },
      { id: 'api-runner', status: 'pass', exitCode: 0 },
      { id: 'compile', status: 'pass', exitCode: 0 },
      { id: 'strict-compile', status: 'pass', exitCode: 0 },
    ],
  }, overrides.sessionSummary)
  const compiledSummary = deepMerge({
    tool: 'compile-dingtalk-p4-smoke-evidence',
    overallStatus: 'pass',
    apiBootstrapStatus: 'pass',
    remoteClientStatus: 'pass',
    remoteSmokePhase: 'finalize_pending',
    requiredChecks: checks,
    requiredChecksNotPassed: [],
    manualEvidenceIssues: [],
    failedChecks: [],
    missingRequiredChecks: [],
  }, overrides.compiledSummary)
  const statusSummary = deepMerge({
    tool: 'dingtalk-p4-smoke-status',
    overallStatus: 'release_ready',
    remoteSmokePhase: 'finalize_pending',
    totals: {
      requiredChecks: requiredCheckIds.length,
      passedChecks: requiredCheckIds.length,
      gaps: 0,
    },
    requiredChecks: checks,
    handoff: {
      status: 'pass',
      publishStatus: 'pass',
      secretFindingCount: 0,
      failures: [],
    },
  }, overrides.statusSummary)
  const handoffSummary = deepMerge({
    tool: 'dingtalk-p4-final-handoff',
    status: 'pass',
    sessionDir,
    outputDir: packetDir,
    publishCheck: {
      status: 'pass',
      secretFindings: [],
      failures: [],
    },
    failures: [],
  }, overrides.handoffSummary)

  writeJson(path.join(sessionDir, 'session-summary.json'), sessionSummary)
  writeJson(path.join(sessionDir, 'compiled', 'summary.json'), compiledSummary)
  writeJson(path.join(sessionDir, 'smoke-status.json'), statusSummary)
  writeJson(path.join(packetDir, 'handoff-summary.json'), handoffSummary)

  return {
    sessionDir,
    packetDir,
    handoffSummary: path.join(packetDir, 'handoff-summary.json'),
  }
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function relativePath(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/')
}

test('dingtalk-p4-final-docs generates release-ready development and verification notes', () => {
  const tmpDir = makeTmpDir()

  try {
    const paths = writeReleaseReadySession(tmpDir)
    const outputDir = path.join(tmpDir, 'docs')
    const result = runScript([
      '--session-dir', paths.sessionDir,
      '--handoff-summary', paths.handoffSummary,
      '--output-dir', outputDir,
      '--date', '20260423',
      '--require-release-ready',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const developmentMd = path.join(outputDir, 'dingtalk-final-remote-smoke-development-20260423.md')
    const verificationMd = path.join(outputDir, 'dingtalk-final-remote-smoke-verification-20260423.md')
    assert.equal(existsSync(developmentMd), true)
    assert.equal(existsSync(verificationMd), true)

    const developmentText = readFileSync(developmentMd, 'utf8')
    const verificationText = readFileSync(verificationMd, 'utf8')
    assert.match(developmentText, /DingTalk Final Remote Smoke Development/)
    assert.match(developmentText, /Smoke status: \*\*release_ready\*\*/)
    assert.match(developmentText, /Remote smoke phase: \*\*finalize_pending\*\*/)
    assert.match(developmentText, /\| Doc \| Step \| Check \| Status \| Source \| Evidence Snapshot \| Manual Issues \|/)
    assert.match(developmentText, /Compiled status: \*\*pass\*\*/)
    assert.match(verificationText, /DingTalk Final Remote Smoke Verification/)
    assert.match(verificationText, /dingtalk-p4-final-docs\.mjs/)
    assert.equal(verificationText.includes(`--output-dir ${relativePath(outputDir)}`), true)
    assert.match(verificationText, /--date 20260423/)
    assert.match(verificationText, /Required checks passed: 8\/8/)
    assert.match(verificationText, /Remote smoke phase: \*\*finalize_pending\*\*/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-docs rejects non-release-ready sessions when required', () => {
  const tmpDir = makeTmpDir()

  try {
    const paths = writeReleaseReadySession(tmpDir, {
      statusSummary: {
        overallStatus: 'handoff_pending',
      },
    })
    const outputDir = path.join(tmpDir, 'docs')
    const result = runScript([
      '--session-dir', paths.sessionDir,
      '--handoff-summary', paths.handoffSummary,
      '--output-dir', outputDir,
      '--date', '20260423',
      '--require-release-ready',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /release-ready final docs rejected/)
    assert.match(result.stderr, /smoke status is not release_ready/)
    assert.equal(existsSync(path.join(outputDir, 'dingtalk-final-remote-smoke-development-20260423.md')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-docs redacts secret-like failure details before writing markdown', () => {
  const tmpDir = makeTmpDir()
  const rawWebhook = 'https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef'
  const rawBearer = 'Bearer abcdefghijklmnopqrstuvwxyz1234567890'
  const rawSecret = 'SECabcdefghijklmnop12345678'
  const rawPublicToken = 'publicToken=abc1234567890xyz'
  const rawClientSecret = 'DINGTALK_CLIENT_SECRET = abcdefghijklmnopqrstuvwxyz123456'

  try {
    const paths = writeReleaseReadySession(tmpDir, {
      statusSummary: {
        handoff: {
          failures: [`status failure includes ${rawPublicToken} ${rawClientSecret}`],
        },
      },
      handoffSummary: {
        failures: [`handoff failure includes ${rawWebhook} ${rawBearer} ${rawSecret} ${rawClientSecret}`],
      },
    })
    const outputDir = path.join(tmpDir, 'docs')
    const result = runScript([
      '--session-dir', paths.sessionDir,
      '--handoff-summary', paths.handoffSummary,
      '--output-dir', outputDir,
      '--date', '20260423',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const verificationText = readFileSync(path.join(outputDir, 'dingtalk-final-remote-smoke-verification-20260423.md'), 'utf8')
    assert.doesNotMatch(verificationText, /0123456789abcdef0123456789abcdef/)
    assert.doesNotMatch(verificationText, /abcdefghijklmnopqrstuvwxyz1234567890/)
    assert.doesNotMatch(verificationText, /SECabcdefghijklmnop12345678/)
    assert.doesNotMatch(verificationText, /abc1234567890xyz/)
    assert.doesNotMatch(verificationText, /abcdefghijklmnopqrstuvwxyz123456/)
    assert.match(verificationText, /access_token=<redacted>/)
    assert.match(verificationText, /Bearer <redacted>/)
    assert.match(verificationText, /SEC<redacted>/)
    assert.match(verificationText, /publicToken=<redacted>/)
    assert.match(verificationText, /DINGTALK_CLIENT_SECRET = <redacted>/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
