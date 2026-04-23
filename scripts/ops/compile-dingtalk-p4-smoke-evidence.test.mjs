import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'compile-dingtalk-p4-smoke-evidence.mjs')

const requiredIds = [
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

function makePassingEvidenceForCheck(id, extras = {}) {
  if (manualClientIds.has(id) || manualAdminIds.has(id)) {
    return {
      source: manualClientIds.has(id) ? 'manual-client' : 'manual-admin',
      operator: 'qa',
      performedAt: '2026-04-22T15:00:00.000Z',
      summary: `${id} manual evidence ok`,
      artifacts: [`screenshots/${id}.png`],
      ...extras,
    }
  }
  return {
    source: 'api-bootstrap',
    notes: `${id} ok`,
    ...extras,
  }
}

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-smoke-evidence-'))
}

function writeEvidence(file, overrides = {}) {
  const evidence = {
    runId: 'remote-20260422',
    executedAt: '2026-04-22T15:00:00.000Z',
    environment: {
      apiBase: 'http://142.171.239.56:8900',
      webBase: 'http://142.171.239.56:8081',
      branch: 'codex/dingtalk-docs-smoke-runbook-20260422',
      commit: '83eed2a50',
      operator: 'qa',
    },
    checks: requiredIds.map((id) => ({
      id,
      status: 'pass',
      evidence: makePassingEvidenceForCheck(id),
    })),
    artifacts: [],
    ...overrides,
  }
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

test('compile-dingtalk-p4-smoke-evidence writes an editable template', () => {
  const tmpDir = makeTmpDir()
  const templatePath = path.join(tmpDir, 'evidence.json')

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--init-template', templatePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    const template = JSON.parse(readFileSync(templatePath, 'utf8'))
    assert.equal(template.checks.length, requiredIds.length)
    assert.deepEqual(template.checks.map((check) => check.id), requiredIds)
    assert.equal(template.checks.every((check) => check.status === 'pending'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence compiles passing evidence and redacts secrets', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, {
          notes: `${id} used https://oapi.dingtalk.com/robot/send?access_token=robot-secret&timestamp=1690000000000&sign=robot-sign and SECabcdefgh12345678`,
          publicUrl: 'http://example.test/form?publicToken=pub_secret',
          authorization: 'Bearer abc.def.ghi',
          token: 'raw-token',
        }),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(path.join(outputDir, 'summary.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'summary.md')), true)
    assert.equal(existsSync(path.join(outputDir, 'evidence.redacted.json')), true)

    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.apiBootstrapStatus, 'pass')
    assert.equal(summary.remoteClientStatus, 'pass')
    assert.equal(summary.requiredChecksNotPassed.length, 0)
    assert.equal(summary.manualEvidenceIssues.length, 0)

    const redacted = readFileSync(path.join(outputDir, 'evidence.redacted.json'), 'utf8')
    assert.doesNotMatch(redacted, /robot-secret/)
    assert.doesNotMatch(redacted, /1690000000000/)
    assert.doesNotMatch(redacted, /robot-sign/)
    assert.doesNotMatch(redacted, /SECabcdefgh12345678/)
    assert.doesNotMatch(redacted, /pub_secret/)
    assert.doesNotMatch(redacted, /raw-token/)
    assert.match(redacted, /access_token=<redacted>/)
    assert.match(redacted, /timestamp=<redacted>/)
    assert.match(redacted, /sign=<redacted>/)
    assert.match(redacted, /SEC<redacted>/)
    assert.match(redacted, /publicToken=<redacted>/)
    assert.match(redacted, /"<redacted>"/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects pass checks without manual evidence metadata', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: {
          source: 'api-bootstrap',
          notes: `${id} marked pass without real manual evidence`,
        },
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /manual_source_required/)
    assert.match(result.stderr, /authorized-user-submit/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.apiBootstrapStatus, 'pass')
    assert.equal(summary.remoteClientStatus, 'fail')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'authorized-user-submit'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'send-group-message-form-link'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode fails when required checks are not passed', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: [
        ...requiredIds.slice(0, -1).map((id) => ({ id, status: 'pass', evidence: makePassingEvidenceForCheck(id) })),
        { id: requiredIds.at(-1), status: 'fail', evidence: { notes: 'no-email path failed' } },
      ],
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /no-email-user-create-bind:fail/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence rejects duplicate check ids', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')

  try {
    writeEvidence(evidencePath, {
      checks: [
        { id: 'create-table-form', status: 'pass' },
        { id: 'create-table-form', status: 'pass' },
      ],
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /duplicate check ids: create-table-form/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
