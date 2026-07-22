import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildSidecar } from './build-stock-preparation-rca-window-sidecar.mjs'

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

test('builder emits the exact no-Git C-stage sidecar contract with complete checksums', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-window-build-'))
  try {
    const { packageName, packageDir } = buildSidecar({ outputDir, sourceSha: SOURCE_SHA })
    assert.equal(packageName, 'stock-preparation-rca-c-window-sidecar-1234567890')
    const names = fs.readdirSync(packageDir).sort()
    assert.deepEqual(names, [
      'BUILD_PROVENANCE.json',
      'SHA256SUMS',
      'stock-preparation-mvp-postdeploy-smoke.mjs',
      'stock-preparation-prep-line-extended-smoke.mjs',
      'stock-preparation-rca-window-README.txt',
      'stock-preparation-rca-window-pm2-sample.mjs',
      'stock-preparation-rca-window.ps1',
    ])

    const provenance = JSON.parse(fs.readFileSync(path.join(packageDir, 'BUILD_PROVENANCE.json'), 'utf8'))
    assert.equal(provenance.sourceGitCommit, SOURCE_SHA)
    assert.equal(provenance.frozenRuntimeGitCommit, 'd87e086fd1218b4cfb150177d43f2c52904b1d6d')
    assert.equal(provenance.externalWrite, false)

    const checksumEntries = fs.readFileSync(path.join(packageDir, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.equal(checksumEntries.length, names.length - 1)
    for (const line of checksumEntries) {
      const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/)
      assert.ok(match, `invalid checksum line: ${line}`)
      assert.equal(match[1], digest(path.join(packageDir, match[2])))
    }
    const readme = fs.readFileSync(path.join(packageDir, 'stock-preparation-rca-window-README.txt'), 'utf8')
    assert.match(readme, /powershell\.exe -NoProfile -ExecutionPolicy Bypass/)
    assert.match(readme, /STOCK_PREPARATION_RCA_WINDOW/)
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('builder fails closed when the source SHA is not a full lowercase commit id', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-window-build-'))
  try {
    assert.throws(() => buildSidecar({ outputDir, sourceSha: 'short' }))
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('workflow checks out and verifies the exact SHA recorded in provenance', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/stock-preparation-rca-window-sidecar.yml'),
    'utf8',
  )
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /ref: \$\{\{ env\.SOURCE_SHA \}\}/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
})
