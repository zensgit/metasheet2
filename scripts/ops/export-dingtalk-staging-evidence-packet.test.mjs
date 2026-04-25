import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'export-dingtalk-staging-evidence-packet.mjs')
const dingtalkP4RequiredCheckIds = [
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
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-staging-evidence-packet-'))
}

function writeDingTalkP4Session(dir, overrides = {}) {
  mkdirSync(path.join(dir, 'compiled'), { recursive: true })
  writeFileSync(path.join(dir, 'session-summary.json'), `${JSON.stringify({
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
  }, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(dir, 'compiled', 'summary.json'), `${JSON.stringify({
    tool: 'compile-dingtalk-p4-smoke-evidence',
    overallStatus: 'pass',
    apiBootstrapStatus: 'pass',
    remoteClientStatus: 'pass',
    remoteSmokePhase: 'finalize_pending',
    totals: {
      totalChecks: dingtalkP4RequiredCheckIds.length,
      requiredChecks: dingtalkP4RequiredCheckIds.length,
      passedChecks: dingtalkP4RequiredCheckIds.length,
      failedChecks: 0,
      skippedChecks: 0,
      pendingChecks: 0,
      missingRequiredChecks: 0,
      unknownChecks: 0,
    },
    requiredChecks: dingtalkP4RequiredCheckIds.map((id) => ({ id, status: 'pass' })),
    missingRequiredChecks: [],
    requiredChecksNotPassed: [],
    failedChecks: [],
    unknownChecks: [],
    manualEvidenceIssues: [],
    ...overrides.compiledSummary,
  }, null, 2)}\n`, 'utf8')
}

test('export-dingtalk-staging-evidence-packet copies required handoff files and writes manifest', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--output-dir', outputDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Copied docs\/development\/dingtalk-staging-canary-deploy-20260408\.md/)
    assert.equal(
      existsSync(
        path.join(outputDir, 'docs/development/dingtalk-staging-execution-checklist-20260408.md'),
      ),
      true,
    )
    assert.equal(existsSync(path.join(outputDir, 'docs/dingtalk-user-workflow-guide-20260422.md')), true)
    assert.equal(
      existsSync(path.join(outputDir, 'docs/dingtalk-remote-smoke-checklist-20260422.md')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-remote-smoke.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-smoke-preflight.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-smoke-session.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-evidence-record.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-smoke-status.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-final-handoff.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-final-docs.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/dingtalk-p4-final-closeout.mjs')),
      true,
    )
    assert.equal(
      existsSync(path.join(outputDir, 'scripts/ops/validate-dingtalk-staging-evidence-packet.mjs')),
      true,
    )
    assert.equal(existsSync(path.join(outputDir, 'scripts/ops/deploy-dingtalk-staging.sh')), true)
    assert.equal(existsSync(path.join(outputDir, 'docker/app.staging.env.example')), true)

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.packet, 'dingtalk-staging-evidence-packet')
    assert.equal(manifest.requireDingTalkP4Pass, false)
    assert.equal(manifest.includedEvidence.length, 0)
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/validate-env-file.sh'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'docs/dingtalk-remote-smoke-checklist-20260422.md'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-remote-smoke.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-smoke-preflight.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-smoke-session.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-evidence-record.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-smoke-status.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-final-handoff.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-final-docs.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/dingtalk-p4-final-closeout.mjs'),
      true,
    )
    assert.equal(
      manifest.files.some((file) => file.path === 'scripts/ops/validate-dingtalk-staging-evidence-packet.mjs'),
      true,
    )

    const readme = readFileSync(path.join(outputDir, 'README.md'), 'utf8')
    assert.match(readme, /DingTalk Staging Evidence Packet/)
    assert.match(readme, /docs\/dingtalk-remote-smoke-checklist-20260422\.md/)
    assert.match(readme, /dingtalk-p4-remote-smoke\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-preflight\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-session\.mjs/)
    assert.match(readme, /dingtalk-p4-evidence-record\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-status\.mjs/)
    assert.match(readme, /dingtalk-p4-final-handoff\.mjs/)
    assert.match(readme, /dingtalk-p4-final-docs\.mjs/)
    assert.match(readme, /dingtalk-p4-final-closeout\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-status\.mjs --session-dir <session-dir> --handoff-summary <packet-dir>\/handoff-summary\.json --require-release-ready/)
    assert.match(readme, /validate-dingtalk-staging-evidence-packet\.mjs/)
    assert.match(readme, /compile-dingtalk-p4-smoke-evidence\.mjs/)
    assert.match(readme, /No runtime evidence directory was included/)
    assert.match(readme, /DingTalk P4 final-pass gate was not enabled/)
    assert.match(readme, /does not generate secrets/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet copies optional runtime evidence directories', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const evidenceDir = path.join(tmpDir, 'smoke-output')

  try {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ ok: true }), 'utf8')

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', evidenceDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.includedEvidence.length, 1)
    assert.equal(manifest.includedEvidence[0].destination, 'evidence/01-smoke-output')
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-smoke-output/summary.json')), true)

    const readme = readFileSync(path.join(outputDir, 'README.md'), 'utf8')
    assert.match(readme, /evidence\/01-smoke-output/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet clears stale evidence directories when reusing packet output', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const firstEvidenceDir = path.join(tmpDir, 'old-smoke-output')
  const secondEvidenceDir = path.join(tmpDir, 'new-smoke-output')

  try {
    mkdirSync(firstEvidenceDir, { recursive: true })
    writeFileSync(path.join(firstEvidenceDir, 'summary.json'), JSON.stringify({ ok: 'old' }), 'utf8')
    const firstResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', firstEvidenceDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(firstResult.status, 0, firstResult.stderr)
    mkdirSync(path.join(outputDir, 'evidence/99-stale-session'), { recursive: true })
    writeFileSync(path.join(outputDir, 'evidence/99-stale-session/stale.txt'), 'stale\n', 'utf8')

    mkdirSync(secondEvidenceDir, { recursive: true })
    writeFileSync(path.join(secondEvidenceDir, 'summary.json'), JSON.stringify({ ok: 'new' }), 'utf8')
    const secondResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', secondEvidenceDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(secondResult.status, 0, secondResult.stderr)
    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.includedEvidence.length, 1)
    assert.equal(manifest.includedEvidence[0].destination, 'evidence/01-new-smoke-output')
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-old-smoke-output/summary.json')), false)
    assert.equal(existsSync(path.join(outputDir, 'evidence/99-stale-session/stale.txt')), false)
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-new-smoke-output/summary.json')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet accepts finalized DingTalk P4 pass evidence when required', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const evidenceDir = path.join(tmpDir, '142-session')

  try {
    writeDingTalkP4Session(evidenceDir)

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', evidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.requireDingTalkP4Pass, true)
    assert.equal(manifest.includedEvidence.length, 1)
    assert.equal(manifest.includedEvidence[0].dingtalkP4FinalStatus.status, 'pass')
    assert.equal(manifest.includedEvidence[0].dingtalkP4FinalStatus.finalStrictStatus, 'pass')
    assert.equal(manifest.includedEvidence[0].dingtalkP4FinalStatus.apiBootstrapStatus, 'pass')
    assert.equal(manifest.includedEvidence[0].dingtalkP4FinalStatus.remoteSmokePhase, 'finalize_pending')
    assert.equal(manifest.includedEvidence[0].dingtalkP4FinalStatus.requiredChecks, 8)
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-142-session/session-summary.json')), true)

    const readme = readFileSync(path.join(outputDir, 'README.md'), 'utf8')
    assert.match(readme, /DingTalk P4 final-pass gate was enabled/)
    assert.match(readme, /--require-dingtalk-p4-pass/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects non-final DingTalk P4 evidence when required', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const evidenceDir = path.join(tmpDir, '142-session')

  try {
    writeDingTalkP4Session(evidenceDir, {
      sessionSummary: {
        sessionPhase: 'bootstrap',
        overallStatus: 'manual_pending',
        finalStrictStatus: 'not_run',
      },
      compiledSummary: {
        overallStatus: 'fail',
        remoteClientStatus: 'fail',
      },
    })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', evidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /included DingTalk P4 session is not final pass/)
    assert.match(result.stderr, /sessionPhase is not finalize/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects incomplete DingTalk P4 final schema', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const evidenceDir = path.join(tmpDir, '142-session')

  try {
    writeDingTalkP4Session(evidenceDir, {
      compiledSummary: {
        tool: undefined,
        apiBootstrapStatus: 'fail',
        requiredChecksNotPassed: undefined,
        manualEvidenceIssues: [{ id: 'authorized-user-submit', code: 'artifact_refs_required' }],
      },
    })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', evidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /compiled\/summary\.json tool is not compile-dingtalk-p4-smoke-evidence/)
    assert.match(result.stderr, /compiled\/summary\.json apiBootstrapStatus is not pass/)
    assert.match(result.stderr, /compiled\/summary\.json requiredChecksNotPassed is not an array/)
    assert.match(result.stderr, /compiled\/summary\.json manualEvidenceIssues is not empty/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects failed strict compile step', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const evidenceDir = path.join(tmpDir, '142-session')

  try {
    writeDingTalkP4Session(evidenceDir, {
      sessionSummary: {
        steps: [
          { id: 'preflight', status: 'pass', exitCode: 0 },
          { id: 'api-runner', status: 'pass', exitCode: 0 },
          { id: 'compile', status: 'pass', exitCode: 0 },
          { id: 'strict-compile', status: 'fail', exitCode: 1 },
        ],
        pendingChecks: [{ id: 'authorized-user-submit', status: 'pending', manual: true }],
      },
    })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', evidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /strict-compile step is not pass/)
    assert.match(result.stderr, /session-summary\.json pendingChecks is not empty/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet prevalidates all required P4 evidence before writing packet', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const validEvidenceDir = path.join(tmpDir, '142-session-a')
  const invalidEvidenceDir = path.join(tmpDir, '142-session-b')

  try {
    writeDingTalkP4Session(validEvidenceDir)
    writeDingTalkP4Session(invalidEvidenceDir, {
      compiledSummary: {
        requiredChecks: dingtalkP4RequiredCheckIds.map((id) => ({
          id,
          status: id === 'authorized-user-submit' ? 'pending' : 'pass',
        })),
      },
    })

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--output-dir',
        outputDir,
        '--include-output',
        validEvidenceDir,
        '--include-output',
        invalidEvidenceDir,
        '--require-dingtalk-p4-pass',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /required check authorized-user-submit is not pass/)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), false)
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-142-session-a/session-summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet clears stale packet markers before gated validation failure', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const validEvidenceDir = path.join(tmpDir, '142-session-valid')
  const invalidEvidenceDir = path.join(tmpDir, '142-session-invalid')

  try {
    writeDingTalkP4Session(validEvidenceDir)
    const initialResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', validEvidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(initialResult.status, 0, initialResult.stderr)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), true)

    writeDingTalkP4Session(invalidEvidenceDir, {
      sessionSummary: {
        sessionPhase: 'bootstrap',
        overallStatus: 'manual_pending',
        finalStrictStatus: 'not_run',
      },
    })
    const failedResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', invalidEvidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(failedResult.status, 1)
    assert.match(failedResult.stderr, /included DingTalk P4 session is not final pass/)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), false)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), false)
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-142-session-valid/session-summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet clears ungated packet markers before gated validation failure', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'packet')
  const legacyEvidenceDir = path.join(tmpDir, 'legacy-smoke-output')
  const invalidEvidenceDir = path.join(tmpDir, '142-session-invalid')

  try {
    mkdirSync(legacyEvidenceDir, { recursive: true })
    writeFileSync(path.join(legacyEvidenceDir, 'summary.json'), JSON.stringify({ ok: true }), 'utf8')
    const initialResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', legacyEvidenceDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(initialResult.status, 0, initialResult.stderr)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), true)

    writeDingTalkP4Session(invalidEvidenceDir, {
      sessionSummary: {
        sessionPhase: 'bootstrap',
        overallStatus: 'manual_pending',
        finalStrictStatus: 'not_run',
      },
    })
    const failedResult = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir, '--include-output', invalidEvidenceDir, '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(failedResult.status, 1)
    assert.match(failedResult.stderr, /included DingTalk P4 session is not final pass/)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), false)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), false)
    assert.equal(existsSync(path.join(outputDir, 'evidence/01-legacy-smoke-output/summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet requires included evidence for final gate', () => {
  const tmpDir = makeTmpDir()

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', path.join(tmpDir, 'packet'), '--require-dingtalk-p4-pass'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--require-dingtalk-p4-pass requires at least one --include-output/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects non-packet output directories before cleanup', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'repo-like-dir')
  const readmePath = path.join(outputDir, 'README.md')

  try {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(readmePath, '# Not a generated packet\n', 'utf8')

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output-dir', outputDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /not a DingTalk staging evidence packet/)
    assert.equal(readFileSync(readmePath, 'utf8'), '# Not a generated packet\n')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects missing optional evidence directory', () => {
  const tmpDir = makeTmpDir()

  try {
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--output-dir',
        path.join(tmpDir, 'packet'),
        '--include-output',
        path.join(tmpDir, 'missing-output'),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--include-output must point to an existing directory/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('export-dingtalk-staging-evidence-packet rejects unknown arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--unknown'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown argument: --unknown/)
})
