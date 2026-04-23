import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-evidence-record.mjs')
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
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-evidence-record-'))
}

function writeEvidence(sessionDir) {
  const workspaceDir = path.join(sessionDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
  const evidencePath = path.join(workspaceDir, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify({
    runId: 'remote-142',
    checks: requiredCheckIds.map((id) => ({
      id,
      status: 'pending',
      evidence: {
        source: id.includes('form') ? 'api-bootstrap' : '',
        notes: '',
      },
    })),
  }, null, 2)}\n`, 'utf8')
  return evidencePath
}

function writeArtifact(sessionDir, checkId, name = 'evidence.txt', content = 'manual proof\n') {
  const artifactRef = `artifacts/${checkId}/${name}`
  const artifactPath = path.join(sessionDir, 'workspace', artifactRef)
  mkdirSync(path.dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, content, 'utf8')
  return artifactRef
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('dingtalk-p4-evidence-record records passing manual client evidence', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    const evidencePath = writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'authorized-user-submit')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--performed-at',
      '2026-04-23T10:00:00.000Z',
      '--summary',
      'Allowed DingTalk-bound user opened and submitted.',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Updated authorized-user-submit/)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const check = evidence.checks.find((entry) => entry.id === 'authorized-user-submit')
    assert.equal(check.status, 'pass')
    assert.equal(check.evidence.source, 'manual-client')
    assert.equal(check.evidence.operator, 'qa')
    assert.deepEqual(check.evidence.artifacts, [artifactRef])
    assert.equal(evidence.updatedBy, 'dingtalk-p4-evidence-record')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record records structured unauthorized denial evidence', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    const evidencePath = writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'unauthorized-user-denied')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'unauthorized-user-denied',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--performed-at',
      '2026-04-23T10:00:00.000Z',
      '--summary',
      'Unauthorized DingTalk-bound user was blocked.',
      '--artifact',
      artifactRef,
      '--submit-blocked',
      '--record-insert-delta',
      '0',
      '--blocked-reason',
      'Visible error showed the user is not in the allowlist.',
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const check = evidence.checks.find((entry) => entry.id === 'unauthorized-user-denied')
    assert.equal(check.status, 'pass')
    assert.equal(check.evidence.submitBlocked, true)
    assert.equal(check.evidence.recordInsertDelta, 0)
    assert.equal(check.evidence.blockedReason, 'Visible error showed the user is not in the allowlist.')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record supports dry-run without writing evidence', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    const evidencePath = writeEvidence(sessionDir)
    const before = readFileSync(evidencePath, 'utf8')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'delivery-history-group-person',
      '--status',
      'fail',
      '--source',
      'api-bootstrap',
      '--summary',
      'Person delivery history API returned no rows.',
      '--dry-run',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"id": "delivery-history-group-person"/)
    assert.equal(readFileSync(evidencePath, 'utf8'), before)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record preserves existing evidence metadata', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    const evidencePath = writeEvidence(sessionDir)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const check = evidence.checks.find((entry) => entry.id === 'authorized-user-submit')
    check.evidence = {
      source: 'manual-client',
      instructions: 'Keep this operator guidance.',
      apiBootstrap: {
        tableId: 'table_1',
      },
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    const artifactRef = writeArtifact(sessionDir, 'authorized-user-submit')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 0, result.stderr)
    const updated = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const updatedCheck = updated.checks.find((entry) => entry.id === 'authorized-user-submit')
    assert.equal(updatedCheck.evidence.instructions, 'Keep this operator guidance.')
    assert.deepEqual(updatedCheck.evidence.apiBootstrap, { tableId: 'table_1' })
    assert.equal(updatedCheck.evidence.operator, 'qa')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects incomplete unauthorized denial evidence', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'unauthorized-user-denied')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'unauthorized-user-denied',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Unauthorized DingTalk-bound user was blocked.',
      '--artifact',
      artifactRef,
      '--record-insert-delta',
      '1',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires --submit-blocked/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record accepts equal before and after record counts for unauthorized denial', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    const evidencePath = writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'unauthorized-user-denied')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'unauthorized-user-denied',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Unauthorized DingTalk-bound user was blocked.',
      '--artifact',
      artifactRef,
      '--submit-blocked',
      '--before-record-count',
      '7',
      '--after-record-count',
      '7',
      '--blocked-reason',
      'Visible grant-required error.',
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const check = evidence.checks.find((entry) => entry.id === 'unauthorized-user-denied')
    assert.equal(check.evidence.beforeRecordCount, 7)
    assert.equal(check.evidence.afterRecordCount, 7)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects wrong manual pass source', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'authorized-user-submit')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'api-bootstrap',
      '--operator',
      'qa',
      '--summary',
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires --source manual-client/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects manual pass evidence without artifacts', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'no-email-user-create-bind',
      '--status',
      'pass',
      '--source',
      'manual-admin',
      '--operator',
      'qa-admin',
      '--summary',
      'No-email user was created and bound.',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires at least one --artifact/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects artifact refs outside the check folder', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const wrongRef = writeArtifact(sessionDir, 'authorized-user-submit').replace('authorized-user-submit', 'send-group-message-form-link')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Allowed user submit proof.',
      '--artifact',
      wrongRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /must live under artifacts\/authorized-user-submit\//)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects secret-like summary input', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'authorized-user-submit')

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Bearer secret-admin-token-01234567890123456789',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--summary contains secret-like value: bearer_token/)
    assert.doesNotMatch(result.stderr, /secret-admin-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects secret-like text artifacts', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(
      sessionDir,
      'authorized-user-submit',
      'leak.txt',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-token-0123456789\n',
    )

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pass',
      '--source',
      'manual-client',
      '--operator',
      'qa',
      '--summary',
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact .* contains secret-like value: dingtalk_robot_webhook/)
    assert.doesNotMatch(result.stderr, /robot-secret-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects unknown checks', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)

    const result = runScript([
      '--session-dir',
      sessionDir,
      '--check-id',
      'not-a-check',
      '--status',
      'pending',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /unknown DingTalk P4 check id/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects missing evidence file', () => {
  const tmpDir = makeTmpDir()
  const missingEvidence = path.join(tmpDir, 'missing.json')

  try {
    const result = runScript([
      '--evidence',
      missingEvidence,
      '--check-id',
      'authorized-user-submit',
      '--status',
      'pending',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /evidence file does not exist/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects invalid status', () => {
  const result = runScript([
    '--evidence',
    'evidence.json',
    '--check-id',
    'authorized-user-submit',
    '--status',
    'done',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--status must be one of/)
})
