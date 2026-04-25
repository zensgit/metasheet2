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

function manualArtifactRefForCheck(id) {
  return `artifacts/${id}/evidence.txt`
}

function makePassingEvidenceForCheck(id, extras = {}) {
  if (manualClientIds.has(id) || manualAdminIds.has(id)) {
    return {
      source: manualClientIds.has(id) ? 'manual-client' : 'manual-admin',
      operator: 'qa',
      performedAt: '2026-04-22T15:00:00.000Z',
      summary: `${id} manual evidence ok`,
      artifacts: [manualArtifactRefForCheck(id)],
      ...(id === 'unauthorized-user-denied'
        ? {
            submitBlocked: true,
            recordInsertDelta: 0,
            blockedReason: 'Visible form error showed the user is not in the DingTalk allowlist.',
          }
        : {}),
      ...(id === 'no-email-user-create-bind'
        ? {
            adminEvidence: {
              emailWasBlank: true,
              createdLocalUserId: 'local_no_email_001',
              boundDingTalkExternalId: 'dt_no_email_001',
              accountLinkedAfterRefresh: true,
              temporaryPasswordRedacted: true,
            },
          }
        : {}),
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

function collectArtifactRefsFromValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => collectArtifactRefsFromValue(entry))
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') {
    for (const key of ['path', 'file', 'url', 'href']) {
      if (typeof value[key] === 'string') return [value[key]]
    }
  }
  return []
}

function collectArtifactRefs(evidence) {
  return [
    evidence?.artifacts,
    evidence?.artifactRefs,
    evidence?.screenshots,
    evidence?.files,
  ].flatMap((candidate) => collectArtifactRefsFromValue(candidate))
}

function writeManualArtifactFiles(evidenceFile, evidence, options = {}) {
  const evidenceDir = path.dirname(evidenceFile)
  for (const check of evidence.checks ?? []) {
    if (!manualClientIds.has(check.id) && !manualAdminIds.has(check.id)) continue
    if (check.status !== 'pass') continue

    for (const artifactRef of collectArtifactRefs(check.evidence)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(artifactRef)) continue
      if (path.isAbsolute(artifactRef) || artifactRef.includes('..')) continue

      const fullPath = path.join(evidenceDir, artifactRef)
      mkdirSync(path.dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, options.emptyRefs?.has(artifactRef) ? '' : `${check.id} manual evidence\n`, 'utf8')
    }
  }
}

function writeEvidence(file, overrides = {}, options = {}) {
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
  if (options.createArtifacts !== false) writeManualArtifactFiles(file, evidence, options)
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
    assert.equal(template.checks.find((check) => check.id === 'create-table-form').evidence.source, 'api-bootstrap')
    assert.equal(template.checks.find((check) => check.id === 'send-group-message-form-link').evidence.source, 'manual-client')
    assert.equal(template.checks.find((check) => check.id === 'authorized-user-submit').evidence.operator, '')
    assert.equal(template.checks.find((check) => check.id === 'authorized-user-submit').evidence.performedAt, '')
    assert.deepEqual(template.checks.find((check) => check.id === 'authorized-user-submit').evidence.artifacts, [])
    assert.equal(template.checks.find((check) => check.id === 'no-email-user-create-bind').evidence.source, 'manual-admin')
    assert.equal(template.checks.find((check) => check.id === 'no-email-user-create-bind').evidence.adminEvidence.temporaryPasswordRedacted, true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence writes a manual evidence kit', () => {
  const tmpDir = makeTmpDir()
  const kitDir = path.join(tmpDir, 'manual-kit')

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--init-kit', kitDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(path.join(kitDir, 'evidence.json')), true)
    assert.equal(existsSync(path.join(kitDir, 'manual-evidence-checklist.md')), true)
    assert.equal(existsSync(path.join(kitDir, 'artifacts/send-group-message-form-link')), true)
    assert.equal(existsSync(path.join(kitDir, 'artifacts/authorized-user-submit')), true)
    assert.equal(existsSync(path.join(kitDir, 'artifacts/unauthorized-user-denied')), true)
    assert.equal(existsSync(path.join(kitDir, 'artifacts/no-email-user-create-bind')), true)

    const template = JSON.parse(readFileSync(path.join(kitDir, 'evidence.json'), 'utf8'))
    assert.equal(template.checks.find((check) => check.id === 'send-group-message-form-link').evidence.source, 'manual-client')
    assert.equal(template.checks.find((check) => check.id === 'no-email-user-create-bind').evidence.source, 'manual-admin')
    const checklist = readFileSync(path.join(kitDir, 'manual-evidence-checklist.md'), 'utf8')
    assert.match(checklist, /manual-client/)
    assert.match(checklist, /manual-admin/)
    assert.match(checklist, /admin-create-bind-result\.png/)
    assert.match(checklist, /temporary password/)
    assert.match(checklist, /Do not paste DingTalk robot full webhook URLs/)
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
    assert.equal(summary.remoteSmokePhase, 'finalize_pending')
    assert.equal(summary.requiredChecksNotPassed.length, 0)
    assert.equal(summary.manualEvidenceIssues.length, 0)
    const summaryMd = readFileSync(path.join(outputDir, 'summary.md'), 'utf8')
    assert.match(summaryMd, /Remote smoke phase: \*\*finalize_pending\*\*/)

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

test('compile-dingtalk-p4-smoke-evidence strict mode rejects missing manual artifact files', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {}, { createArtifacts: false })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_ref_missing/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.remoteSmokePhase, 'manual_pending')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'artifact_ref_missing'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects wrong manual artifact folders', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'authorized-user-submit'
          ? { artifacts: ['artifacts/send-group-message-form-link/authorized-submit.txt'] }
          : {}),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_ref_wrong_folder/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'authorized-user-submit' && issue.code === 'artifact_ref_wrong_folder'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects absolute and traversal artifact refs', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')
  const absoluteArtifactPath = path.join(tmpDir, 'absolute-evidence.txt')

  try {
    writeFileSync(absoluteArtifactPath, 'absolute evidence\n', 'utf8')
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, {
          ...(id === 'send-group-message-form-link' ? { artifacts: [absoluteArtifactPath] } : {}),
          ...(id === 'authorized-user-submit' ? { artifacts: ['../outside-evidence.txt'] } : {}),
        }),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_ref_not_relative/)
    assert.match(result.stderr, /artifact_ref_path_traversal/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'artifact_ref_not_relative'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'artifact_ref_path_traversal'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects empty manual artifact files', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')
  const emptyArtifactRef = manualArtifactRefForCheck('authorized-user-submit')

  try {
    writeEvidence(evidencePath, {}, { emptyRefs: new Set([emptyArtifactRef]) })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_ref_empty/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'authorized-user-submit' && issue.code === 'artifact_ref_empty'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects secret-like manual artifact files', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')
  const artifactRef = manualArtifactRefForCheck('authorized-user-submit')
  const rawWebhook = 'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-token-0123456789'
  const rawSecret = 'SECabcdefghijklmnop12345678'

  try {
    writeEvidence(evidencePath)
    writeFileSync(path.join(tmpDir, artifactRef), `${rawWebhook}\n${rawSecret}\n`, 'utf8')

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_secret_detected/)
    assert.doesNotMatch(result.stderr, /robot-secret-token/)
    assert.doesNotMatch(result.stderr, /SECabcdefghijklmnop12345678/)
    const summaryText = readFileSync(path.join(outputDir, 'summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /robot-secret-token/)
    assert.doesNotMatch(summaryText, /SECabcdefghijklmnop12345678/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.manualEvidenceIssues.some((issue) => (
      issue.id === 'authorized-user-submit'
        && issue.code === 'artifact_secret_detected'
        && issue.artifactRef === artifactRef
    )), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects stale manual artifact files', async () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')
  const artifactRef = manualArtifactRefForCheck('authorized-user-submit')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'authorized-user-submit'
          ? {
              performedAt: '2026-04-22T15:00:00.000Z',
              artifacts: [artifactRef],
            }
          : {}),
      })),
    })
    const artifactPath = path.join(tmpDir, artifactRef)
    writeFileSync(artifactPath, 'authorized submit screenshot\n', 'utf8')
    const oldTime = new Date('2026-04-22T14:00:00.000Z')
    await import('node:fs/promises').then((fs) => fs.utimes(artifactPath, oldTime, oldTime))

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /artifact_ref_stale/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.manualEvidenceIssues.some((issue) => (
      issue.id === 'authorized-user-submit'
        && issue.code === 'artifact_ref_stale'
        && issue.artifactRef === artifactRef
    )), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects external artifacts unless explicitly allowed', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')
  const allowedOutputDir = path.join(tmpDir, 'compiled-allowed')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'authorized-user-submit'
          ? { artifacts: ['https://evidence.example.test/authorized-submit.png'] }
          : {}),
      })),
    })

    const blocked = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /artifact_ref_external_disallowed/)

    const allowed = spawnSync(process.execPath, [
      scriptPath,
      '--input',
      evidencePath,
      '--output-dir',
      allowedOutputDir,
      '--strict',
      '--allow-external-artifact-refs',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(allowed.status, 0, allowed.stderr)
    const summary = JSON.parse(readFileSync(path.join(allowedOutputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'pass')
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
    assert.equal(summary.remoteSmokePhase, 'manual_pending')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'authorized-user-submit'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.id === 'send-group-message-form-link'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode requires structured unauthorized denial evidence', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'unauthorized-user-denied'
          ? {
              submitBlocked: false,
              recordInsertDelta: 1,
              blockedReason: '',
            }
          : {}),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /submit_blocked_required/)
    assert.match(result.stderr, /record_insert_delta_zero_required/)
    assert.match(result.stderr, /blocked_reason_required/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'submit_blocked_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'record_insert_delta_zero_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'blocked_reason_required'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode rejects invalid unauthorized denial record counts', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'unauthorized-user-denied'
          ? {
              submitBlocked: true,
              beforeRecordCount: -1,
              afterRecordCount: -1,
              blockedReason: 'Visible error showed the user is not in the allowlist.',
            }
          : {}),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /record_count_non_negative_integer_required/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'record_count_non_negative_integer_required'), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence strict mode requires structured no-email admin evidence', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: 'pass',
        evidence: makePassingEvidenceForCheck(id, id === 'no-email-user-create-bind'
          ? {
              adminEvidence: {
                emailWasBlank: false,
                createdLocalUserId: '',
                boundDingTalkExternalId: '',
                accountLinkedAfterRefresh: false,
                temporaryPasswordRedacted: false,
              },
            }
          : {}),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /email_was_blank_required/)
    assert.match(result.stderr, /created_local_user_id_required/)
    assert.match(result.stderr, /bound_dingtalk_external_id_required/)
    assert.match(result.stderr, /account_linked_after_refresh_required/)
    assert.match(result.stderr, /temporary_password_redacted_required/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'email_was_blank_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'created_local_user_id_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'bound_dingtalk_external_id_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'account_linked_after_refresh_required'), true)
    assert.equal(summary.manualEvidenceIssues.some((issue) => issue.code === 'temporary_password_redacted_required'), true)
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
    assert.equal(summary.remoteSmokePhase, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('compile-dingtalk-p4-smoke-evidence reports bootstrap pending when API bootstrap checks are incomplete', () => {
  const tmpDir = makeTmpDir()
  const evidencePath = path.join(tmpDir, 'evidence.json')
  const outputDir = path.join(tmpDir, 'compiled')

  try {
    writeEvidence(evidencePath, {
      checks: requiredIds.map((id) => ({
        id,
        status: id === 'create-table-form' ? 'pending' : 'pass',
        evidence: makePassingEvidenceForCheck(id),
      })),
    })

    const result = spawnSync(process.execPath, [scriptPath, '--input', evidencePath, '--output-dir', outputDir, '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /create-table-form:pending/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.apiBootstrapStatus, 'fail')
    assert.equal(summary.remoteSmokePhase, 'bootstrap_pending')
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
