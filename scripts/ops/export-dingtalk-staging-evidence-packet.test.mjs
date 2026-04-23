import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'export-dingtalk-staging-evidence-packet.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-staging-evidence-packet-'))
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
    assert.equal(existsSync(path.join(outputDir, 'scripts/ops/deploy-dingtalk-staging.sh')), true)
    assert.equal(existsSync(path.join(outputDir, 'docker/app.staging.env.example')), true)

    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.packet, 'dingtalk-staging-evidence-packet')
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

    const readme = readFileSync(path.join(outputDir, 'README.md'), 'utf8')
    assert.match(readme, /DingTalk Staging Evidence Packet/)
    assert.match(readme, /docs\/dingtalk-remote-smoke-checklist-20260422\.md/)
    assert.match(readme, /dingtalk-p4-remote-smoke\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-preflight\.mjs/)
    assert.match(readme, /dingtalk-p4-smoke-session\.mjs/)
    assert.match(readme, /compile-dingtalk-p4-smoke-evidence\.mjs/)
    assert.match(readme, /No runtime evidence directory was included/)
    assert.match(readme, /Does not store secrets/)
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
