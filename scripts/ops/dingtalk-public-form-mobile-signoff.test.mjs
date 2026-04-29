import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-public-form-mobile-signoff.mjs')
const allowSubmitChecks = new Set([
  'public-anonymous-submit',
  'dingtalk-bound-submit',
  'selected-bound-submit',
  'granted-bound-with-grant-submit',
])
const denySubmitChecks = new Set([
  'dingtalk-unbound-rejected',
  'selected-unbound-rejected',
  'selected-unlisted-bound-rejected',
  'granted-bound-without-grant-rejected',
])
const renderChecks = new Set([
  'password-change-bypass-observed',
])
const requiredCheckIds = [
  ...allowSubmitChecks,
  ...denySubmitChecks,
  ...renderChecks,
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-public-form-mobile-signoff-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function makePassingEvidence() {
  return {
    tool: 'dingtalk-public-form-mobile-signoff',
    runId: 'mobile-signoff-test',
    environment: '142',
    commit: 'abcdef1',
    checks: requiredCheckIds.map((id) => {
      if (allowSubmitChecks.has(id)) {
        return {
          id,
          status: 'pass',
          evidence: {
            source: 'server-observation',
            operator: 'qa',
            performedAt: '2026-04-29T00:00:00.000Z',
            summary: `${id} inserted exactly one record.`,
            recordInsertDelta: 1,
          },
        }
      }
      if (denySubmitChecks.has(id)) {
        return {
          id,
          status: 'pass',
          evidence: {
            source: 'manual-client',
            operator: 'qa',
            performedAt: '2026-04-29T00:00:00.000Z',
            summary: `${id} was blocked before insert.`,
            submitBlocked: true,
            recordInsertDelta: 0,
            blockedReason: 'Visible form error matched the expected guard.',
          },
        }
      }
      return {
        id,
        status: 'pass',
        evidence: {
          source: 'manual-client',
          operator: 'qa',
          performedAt: '2026-04-29T00:00:00.000Z',
          summary: 'The form rendered and did not show the password-change page.',
          formRendered: true,
          passwordChangeRequiredShown: false,
        },
      }
    }),
  }
}

function writeEvidence(tmpDir, evidence = makePassingEvidence()) {
  const input = path.join(tmpDir, 'mobile-signoff.json')
  writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return input
}

test('dingtalk-public-form-mobile-signoff initializes an editable kit', () => {
  const tmpDir = makeTmpDir()
  try {
    const kitDir = path.join(tmpDir, 'kit')
    const result = runScript(['--init-kit', kitDir])

    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(kitDir, 'mobile-signoff.json')))
    assert.ok(existsSync(path.join(kitDir, 'mobile-signoff-checklist.md')))
    assert.ok(existsSync(path.join(kitDir, 'artifacts', 'public-anonymous-submit')))
    const template = JSON.parse(readFileSync(path.join(kitDir, 'mobile-signoff.json'), 'utf8'))
    assert.equal(template.tool, 'dingtalk-public-form-mobile-signoff')
    assert.equal(template.checks.length, requiredCheckIds.length)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff accepts screenshot-free strict evidence', () => {
  const tmpDir = makeTmpDir()
  try {
    const input = writeEvidence(tmpDir)
    const outputDir = path.join(tmpDir, 'compiled')
    const result = runScript(['--input', input, '--output-dir', outputDir, '--strict'])

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'pass')
    assert.equal(summary.requiredChecks.length, requiredCheckIds.length)
    assert.ok(readFileSync(path.join(outputDir, 'summary.md'), 'utf8').includes('Strict-ready: `yes`'))
    assert.ok(existsSync(path.join(outputDir, 'mobile-signoff.redacted.json')))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff rejects denied checks without zero-insert proof', () => {
  const tmpDir = makeTmpDir()
  try {
    const evidence = makePassingEvidence()
    const denied = evidence.checks.find((check) => check.id === 'selected-unlisted-bound-rejected')
    delete denied.evidence.recordInsertDelta
    const input = writeEvidence(tmpDir, evidence)
    const result = runScript(['--input', input, '--output-dir', path.join(tmpDir, 'compiled'), '--strict'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /selected-unlisted-bound-rejected: denied submit requires recordInsertDelta=0/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff rejects secret-like evidence text', () => {
  const tmpDir = makeTmpDir()
  try {
    const evidence = makePassingEvidence()
    evidence.checks[0].evidence.summary = `Opened https://example.test/form?public${'Token'}=secret-public-token-12345`
    const input = writeEvidence(tmpDir, evidence)
    const result = runScript(['--input', input, '--output-dir', path.join(tmpDir, 'compiled'), '--strict'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /public_form_token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
