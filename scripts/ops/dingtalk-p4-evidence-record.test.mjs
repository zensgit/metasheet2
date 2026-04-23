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

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  })
}

function setCheckPassEvidence(sessionDir, evidence, checkId) {
  const check = evidence.checks.find((entry) => entry.id === checkId)
  check.status = 'pass'
  if (checkId === 'no-email-user-create-bind') {
    const primaryArtifact = writeArtifact(sessionDir, checkId, 'admin-create-bind-result.png')
    const secondaryArtifact = writeArtifact(sessionDir, checkId, 'account-linked-after-refresh.png')
    check.evidence = {
      source: 'manual-admin',
      operator: 'qa-admin',
      performedAt: '2026-04-23T10:00:00.000Z',
      summary: 'Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted.',
      artifacts: [primaryArtifact, secondaryArtifact],
      adminEvidence: {
        emailWasBlank: true,
        createdLocalUserId: 'local_no_email_001',
        boundDingTalkExternalId: 'dt_no_email_001',
        accountLinkedAfterRefresh: true,
        temporaryPasswordRedacted: true,
      },
    }
    return
  }

  const artifactRef = writeArtifact(sessionDir, checkId)
  check.evidence = {
    source: checkId === 'create-table-form' || checkId === 'bind-two-dingtalk-groups' || checkId === 'set-form-dingtalk-granted' || checkId === 'delivery-history-group-person'
      ? 'api-bootstrap'
      : 'manual-client',
    operator: 'qa',
    performedAt: '2026-04-23T10:00:00.000Z',
    summary: `${checkId} pass evidence`,
    artifacts: [artifactRef],
  }
  if (checkId === 'unauthorized-user-denied') {
    check.evidence.submitBlocked = true
    check.evidence.recordInsertDelta = 0
    check.evidence.blockedReason = 'Visible error showed the user is not in the allowlist.'
  }
}

function writeMostlyPassingEvidence(sessionDir, pendingCheckId) {
  const evidencePath = writeEvidence(sessionDir)
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  for (const checkId of requiredCheckIds) {
    if (checkId === pendingCheckId) continue
    setCheckPassEvidence(sessionDir, evidence, checkId)
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidencePath
}

function writeFinalizeStub(scriptFile, markerFile) {
  writeFileSync(scriptFile, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const sessionDir = args[args.indexOf('--finalize') + 1]
if (!sessionDir) {
  console.error('missing --finalize')
  process.exit(2)
}
fs.mkdirSync(path.dirname(${JSON.stringify(markerFile)}), { recursive: true })
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ args }, null, 2) + '\\n')
fs.writeFileSync(path.join(sessionDir, 'session-summary.json'), JSON.stringify({
  tool: 'dingtalk-p4-smoke-session',
  runId: 'session-142',
  sessionPhase: 'finalize',
  overallStatus: 'pass',
  finalStrictStatus: 'pass',
  nextCommands: ['node scripts/ops/dingtalk-p4-final-handoff.mjs --session-dir ${'${sessionDir}'}'],
}, null, 2) + '\\n')
console.log('fake finalize ran')
`, 'utf8')
}

function writeFinalCloseoutStub(scriptFile, markerFile) {
  writeFileSync(scriptFile, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
fs.mkdirSync(path.dirname(${JSON.stringify(markerFile)}), { recursive: true })
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ args }, null, 2) + '\\n')
console.log('fake closeout ran')
`, 'utf8')
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

test('dingtalk-p4-evidence-record refreshes smoke status outputs automatically for session-dir writes', () => {
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
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Refreshed .*smoke-status\.json/)
    assert.equal(existsSync(path.join(sessionDir, 'smoke-status.json')), true)
    assert.equal(existsSync(path.join(sessionDir, 'smoke-status.md')), true)
    assert.equal(existsSync(path.join(sessionDir, 'smoke-todo.md')), true)
    const summary = JSON.parse(readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.requiredChecks.find((check) => check.id === 'authorized-user-submit').status, 'pass')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record can skip smoke status refresh explicitly', () => {
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
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
      '--no-refresh-status',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(path.join(sessionDir, 'smoke-status.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record does not auto-finalize while smoke status is still manual_pending', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')
  const finalizeStub = path.join(tmpDir, 'fake-finalize.mjs')
  const markerFile = path.join(tmpDir, 'finalize.marker')

  try {
    writeEvidence(sessionDir)
    writeFinalizeStub(finalizeStub, markerFile)
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
      '--finalize-when-ready',
    ], {
      env: {
        DINGTALK_P4_EVIDENCE_RECORD_FINALIZE_SCRIPT: finalizeStub,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Auto finalize not attempted; current smoke status is manual_pending/)
    assert.equal(existsSync(markerFile), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record auto-finalizes once refreshed smoke status reaches finalize_pending', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')
  const finalizeStub = path.join(tmpDir, 'fake-finalize.mjs')
  const markerFile = path.join(tmpDir, 'finalize.marker')

  try {
    writeMostlyPassingEvidence(sessionDir, 'no-email-user-create-bind')
    writeFinalizeStub(finalizeStub, markerFile)
    const artifactRefA = writeArtifact(sessionDir, 'no-email-user-create-bind', 'admin-create-bind-result.png')
    const artifactRefB = writeArtifact(sessionDir, 'no-email-user-create-bind', 'account-linked-after-refresh.png')

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
      'Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted.',
      '--artifact',
      artifactRefA,
      '--artifact',
      artifactRefB,
      '--admin-email-was-blank',
      '--admin-created-local-user-id',
      'local_no_email_001',
      '--admin-bound-dingtalk-external-id',
      'dt_no_email_001',
      '--admin-account-linked-after-refresh',
      '--finalize-when-ready',
      '--allow-external-artifact-refs',
    ], {
      env: {
        DINGTALK_P4_EVIDENCE_RECORD_FINALIZE_SCRIPT: finalizeStub,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(markerFile), true)
    assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')).args, [
      '--finalize',
      sessionDir,
      '--allow-external-artifact-refs',
    ])
    assert.match(result.stdout, /Finalized session in .*session-summary\.json/)
    assert.match(result.stdout, /Next handoff command: node scripts\/ops\/dingtalk-p4-final-handoff\.mjs --session-dir/)
    const sessionSummary = JSON.parse(readFileSync(path.join(sessionDir, 'session-summary.json'), 'utf8'))
    assert.equal(sessionSummary.sessionPhase, 'finalize')
    assert.equal(sessionSummary.overallStatus, 'pass')
    assert.equal(sessionSummary.finalStrictStatus, 'pass')
    const evidence = JSON.parse(readFileSync(path.join(sessionDir, 'workspace/evidence.json'), 'utf8'))
    const noEmail = evidence.checks.find((check) => check.id === 'no-email-user-create-bind')
    assert.deepEqual(noEmail.evidence.adminEvidence, {
      emailWasBlank: true,
      createdLocalUserId: 'local_no_email_001',
      boundDingTalkExternalId: 'dt_no_email_001',
      accountLinkedAfterRefresh: true,
      temporaryPasswordRedacted: true,
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record auto-runs final closeout once refreshed smoke status reaches finalize_pending', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')
  const packetDir = path.join(tmpDir, 'packet')
  const docsDir = path.join(tmpDir, 'docs')
  const closeoutStub = path.join(tmpDir, 'fake-closeout.mjs')
  const markerFile = path.join(tmpDir, 'closeout.marker.json')

  try {
    writeMostlyPassingEvidence(sessionDir, 'no-email-user-create-bind')
    writeFinalCloseoutStub(closeoutStub, markerFile)
    const artifactRefA = writeArtifact(sessionDir, 'no-email-user-create-bind', 'admin-create-bind-result.png')
    const artifactRefB = writeArtifact(sessionDir, 'no-email-user-create-bind', 'account-linked-after-refresh.png')

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
      'Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted.',
      '--artifact',
      artifactRefA,
      '--artifact',
      artifactRefB,
      '--admin-email-was-blank',
      '--admin-created-local-user-id',
      'local_no_email_001',
      '--admin-bound-dingtalk-external-id',
      'dt_no_email_001',
      '--admin-account-linked-after-refresh',
      '--closeout-when-ready',
      '--closeout-packet-output-dir',
      packetDir,
      '--closeout-docs-output-dir',
      docsDir,
      '--closeout-date',
      '20260423',
      '--closeout-skip-docs',
      '--allow-external-artifact-refs',
    ], {
      env: {
        DINGTALK_P4_EVIDENCE_RECORD_FINAL_CLOSEOUT_SCRIPT: closeoutStub,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Final closeout completed: node scripts\/ops\/dingtalk-p4-final-closeout\.mjs/)
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
    assert.deepEqual(marker.args, [
      '--session-dir',
      sessionDir,
      '--packet-output-dir',
      packetDir,
      '--docs-output-dir',
      docsDir,
      '--date',
      '20260423',
      '--skip-docs',
      '--allow-external-artifact-refs',
    ])
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects conflicting auto closeout and finalize flags', () => {
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
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
      '--finalize-when-ready',
      '--closeout-when-ready',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--closeout-when-ready cannot be combined with --finalize-when-ready/)
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

test('dingtalk-p4-evidence-record rejects negative and fractional unauthorized denial record counts', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'unauthorized-user-denied')
    const baseArgs = [
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
      '--blocked-reason',
      'Visible grant-required error.',
    ]

    const negative = runScript([...baseArgs, '--before-record-count', '-1', '--after-record-count', '-1'])
    assert.equal(negative.status, 1)
    assert.match(negative.stderr, /--before-record-count must be a non-negative integer/)

    const fractional = runScript([...baseArgs, '--record-insert-delta', '0.5'])
    assert.equal(fractional.status, 1)
    assert.match(fractional.stderr, /--record-insert-delta must be a non-negative integer/)
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

test('dingtalk-p4-evidence-record rejects no-email admin pass evidence without structured admin fields', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(sessionDir, 'no-email-user-create-bind', 'admin-create-bind-result.png')

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
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires --admin-email-was-blank/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-evidence-record rejects admin evidence flags for non-admin checks', () => {
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
      'Allowed user submit proof.',
      '--artifact',
      artifactRef,
      '--admin-created-local-user-id',
      'local_no_email_001',
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /admin evidence flags can only be used with no-email-user-create-bind/)
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

test('dingtalk-p4-evidence-record rejects client_secret summary input', () => {
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
      'client_secret=abcdefghijklmnopqrstuvwxyz123456',
      '--artifact',
      artifactRef,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--summary contains secret-like value: client_secret/)
    assert.doesNotMatch(result.stderr, /abcdefghijklmnopqrstuvwxyz123456/)
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

test('dingtalk-p4-evidence-record rejects client_secret text artifacts', () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, 'session')

  try {
    writeEvidence(sessionDir)
    const artifactRef = writeArtifact(
      sessionDir,
      'authorized-user-submit',
      'leak.txt',
      'DINGTALK_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz123456\n',
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
    assert.match(result.stderr, /artifact .* contains secret-like value: client_secret/)
    assert.doesNotMatch(result.stderr, /abcdefghijklmnopqrstuvwxyz123456/)
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
