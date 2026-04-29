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

function initKit(tmpDir) {
  const kitDir = path.join(tmpDir, 'kit')
  const result = runScript(['--init-kit', kitDir])
  assert.equal(result.status, 0, result.stderr)
  return {
    kitDir,
    input: path.join(kitDir, 'mobile-signoff.json'),
  }
}

test('dingtalk-public-form-mobile-signoff initializes an editable kit', () => {
  const tmpDir = makeTmpDir()
  try {
    const { kitDir } = initKit(tmpDir)

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

test('dingtalk-public-form-mobile-signoff records allowed submit evidence', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const result = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'server-observation',
      '--operator', 'qa',
      '--summary', 'Anonymous public form inserted one record.',
      '--record-insert-delta', '1',
    ])

    assert.equal(result.status, 0, result.stderr)
    const signoff = JSON.parse(readFileSync(input, 'utf8'))
    const entry = signoff.checks.find((check) => check.id === 'public-anonymous-submit')
    assert.equal(entry.status, 'pass')
    assert.equal(entry.evidence.source, 'server-observation')
    assert.equal(entry.evidence.recordInsertDelta, 1)
    assert.match(entry.evidence.performedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff records denied submit evidence', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const result = runScript([
      '--record', input,
      '--check-id', 'selected-unlisted-bound-rejected',
      '--status', 'pass',
      '--source', 'manual-client',
      '--operator', 'qa',
      '--summary', 'The unlisted bound user was blocked before insert.',
      '--submit-blocked',
      '--record-insert-delta', '0',
      '--blocked-reason', 'Not in selected user or group allowlist.',
    ])

    assert.equal(result.status, 0, result.stderr)
    const signoff = JSON.parse(readFileSync(input, 'utf8'))
    const entry = signoff.checks.find((check) => check.id === 'selected-unlisted-bound-rejected')
    assert.equal(entry.status, 'pass')
    assert.equal(entry.evidence.submitBlocked, true)
    assert.equal(entry.evidence.recordInsertDelta, 0)
    assert.equal(entry.evidence.blockedReason, 'Not in selected user or group allowlist.')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff dry-runs a record without writing', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const before = readFileSync(input, 'utf8')
    const result = runScript([
      '--record', input,
      '--check-id', 'password-change-bypass-observed',
      '--status', 'pass',
      '--source', 'manual-client',
      '--operator', 'qa',
      '--summary', 'The form rendered without the password-change page.',
      '--form-rendered',
      '--no-password-change-required-shown',
      '--dry-run',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"id": "password-change-bypass-observed"/)
    assert.equal(readFileSync(input, 'utf8'), before)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff rejects secret-like record updates', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const before = readFileSync(input, 'utf8')
    const result = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'operator-note',
      '--operator', 'qa',
      '--summary', `Do not store ${'SEC'}1234567890abcdef here.`,
      '--record-insert-delta', '1',
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /dingtalk_sec_secret/)
    assert.equal(readFileSync(input, 'utf8'), before)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff writes a remaining-check todo report', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const outputDir = path.join(tmpDir, 'todo')

    const publicRecord = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'server-observation',
      '--operator', 'qa',
      '--summary', 'Anonymous public form inserted one record.',
      '--record-insert-delta', '1',
    ])
    assert.equal(publicRecord.status, 0, publicRecord.stderr)

    const deniedRecord = runScript([
      '--record', input,
      '--check-id', 'selected-unlisted-bound-rejected',
      '--status', 'pass',
      '--source', 'manual-client',
      '--operator', 'qa',
      '--summary', 'The unlisted bound user was blocked before insert.',
      '--submit-blocked',
      '--record-insert-delta', '0',
      '--blocked-reason', 'Not in selected user or group allowlist.',
    ])
    assert.equal(deniedRecord.status, 0, deniedRecord.stderr)

    const result = runScript(['--todo', input, '--output-dir', outputDir])

    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(readFileSync(path.join(outputDir, 'todo.json'), 'utf8'))
    assert.equal(report.strictReady, false)
    assert.equal(report.remainingChecks.length, requiredCheckIds.length - 2)
    assert.equal(report.counts.pass, 2)
    const markdown = readFileSync(path.join(outputDir, 'todo.md'), 'utf8')
    assert.match(markdown, /Remaining checks: 7/)
    assert.match(markdown, /--check-id dingtalk-unbound-rejected/)
    assert.ok(existsSync(path.join(outputDir, 'mobile-signoff.redacted.json')))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff prints todo markdown to stdout', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const result = runScript(['--todo', input])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /DingTalk Public Form Mobile Signoff TODO/)
    assert.match(result.stdout, /--record .*mobile-signoff\.json/)
    assert.match(result.stdout, /--compile-when-ready/)
    assert.match(result.stdout, /Remaining checks: 9/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff flags secret-like todo inputs without leaking them', () => {
  const tmpDir = makeTmpDir()
  try {
    const evidence = makePassingEvidence()
    const secretValue = `https://example.test/form?public${'Token'}=secret-public-token-12345`
    evidence.checks[0].evidence.summary = `Opened ${secretValue}`
    const input = writeEvidence(tmpDir, evidence)
    const outputDir = path.join(tmpDir, 'todo')
    const result = runScript(['--todo', input, '--output-dir', outputDir])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /todo has 1 validation error/)
    assert.match(readFileSync(path.join(outputDir, 'todo.md'), 'utf8'), /public_form_token/)
    const redacted = readFileSync(path.join(outputDir, 'mobile-signoff.redacted.json'), 'utf8')
    assert.doesNotMatch(redacted, /secret-public-token-12345/)
    assert.match(redacted, /<redacted:public_form_token>/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff compile-when-ready reports remaining checks', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const outputDir = path.join(tmpDir, 'compiled')
    const result = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'server-observation',
      '--operator', 'qa',
      '--summary', 'Anonymous public form inserted one record.',
      '--record-insert-delta', '1',
      '--output-dir', outputDir,
      '--compile-when-ready',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /not ready for strict compile/)
    assert.match(result.stdout, /dingtalk-unbound-rejected/)
    assert.equal(existsSync(path.join(outputDir, 'summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff compile-when-ready writes strict output on final record', () => {
  const tmpDir = makeTmpDir()
  try {
    const evidence = makePassingEvidence()
    const finalCheck = evidence.checks.find((check) => check.id === 'password-change-bypass-observed')
    finalCheck.status = 'pending'
    finalCheck.evidence = {}
    const input = writeEvidence(tmpDir, evidence)
    const outputDir = path.join(tmpDir, 'compiled')
    const result = runScript([
      '--record', input,
      '--check-id', 'password-change-bypass-observed',
      '--status', 'pass',
      '--source', 'manual-client',
      '--operator', 'qa',
      '--summary', 'The form rendered without the password-change page.',
      '--form-rendered',
      '--no-password-change-required-shown',
      '--output-dir', outputDir,
      '--compile-when-ready',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /wrote summary/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.strict, true)
    assert.equal(summary.status, 'pass')
    assert.ok(readFileSync(path.join(outputDir, 'summary.md'), 'utf8').includes('Strict-ready: `yes`'))
    assert.ok(existsSync(path.join(outputDir, 'mobile-signoff.redacted.json')))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff rejects compile-when-ready dry-run', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const result = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'server-observation',
      '--operator', 'qa',
      '--summary', 'Anonymous public form inserted one record.',
      '--record-insert-delta', '1',
      '--compile-when-ready',
      '--dry-run',
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--compile-when-ready cannot be used with --dry-run/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-public-form-mobile-signoff rejects secret-like compile-when-ready records before output', () => {
  const tmpDir = makeTmpDir()
  try {
    const { input } = initKit(tmpDir)
    const outputDir = path.join(tmpDir, 'compiled')
    const result = runScript([
      '--record', input,
      '--check-id', 'public-anonymous-submit',
      '--status', 'pass',
      '--source', 'server-observation',
      '--operator', 'qa',
      '--summary', `Do not store ${'SEC'}1234567890abcdef here.`,
      '--record-insert-delta', '1',
      '--output-dir', outputDir,
      '--compile-when-ready',
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /dingtalk_sec_secret/)
    assert.equal(existsSync(path.join(outputDir, 'summary.json')), false)
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
