import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readWorkflow(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('remote workflow summaries cap awk snippets without pipefail-sensitive head pipelines', () => {
  const targets = [
    '.github/workflows/docker-build.yml',
    '.github/workflows/attendance-remote-docker-gc-prod.yml',
    '.github/workflows/attendance-remote-env-reconcile-prod.yml',
    '.github/workflows/attendance-remote-upload-cleanup-prod.yml',
  ]

  for (const target of targets) {
    const raw = readWorkflow(target)
    assert.ok(!raw.includes('| head -n 120'), `${target} must not pipe awk snippets into head -n 120`)
  }

  const dockerBuild = readWorkflow('.github/workflows/docker-build.yml')
  assert.ok(!dockerBuild.includes('| head -n "$max_lines"'))
  assert.ok(dockerBuild.includes('printing && count < 120 { print; count++ }'))
  assert.ok(dockerBuild.includes('printing && count < max_lines { print; count++ }'))

  const envReconcile = readWorkflow('.github/workflows/attendance-remote-env-reconcile-prod.yml')
  assert.ok(envReconcile.includes('printing && total < 120 { print; total++; next }'))
  assert.ok(envReconcile.includes('after && total < 120 {'))

  const uploadCleanup = readWorkflow('.github/workflows/attendance-remote-upload-cleanup-prod.yml')
  assert.ok(uploadCleanup.includes('printing && total < 120 { print; total++; next }'))
  assert.ok(uploadCleanup.includes('after && total < 120 {'))
})
