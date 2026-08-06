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

    // REVIEW P2-2 + a real incident: the rule "editing a frozen helper requires cutting a new
    // pinned release" lived ONLY in a comment, and nothing checked that FROZEN_RUNTIME_SHA names
    // a real released runtime. I proved the gap by falling in it — I bumped this constant to a
    // DOCS commit (`fbb54db3c`, a section-order fix) with no tag, no release and no on-prem
    // acceptance, and every suite stayed green. The tell was available offline the whole time:
    // `stock-preparation-rca-window.ps1` ships in this SAME archive and names the runtime in
    // prose, so the two disagreed. That disagreement is now a test.
    const windowScript = fs.readFileSync(
      path.join(repoRoot, 'scripts/ops/stock-preparation-rca-window.ps1'), 'utf8')
    const shortSha = provenance.frozenRuntimeGitCommit.slice(0, 9)
    assert.ok(
      windowScript.includes(shortSha),
      `in-package incoherence: BUILD_PROVENANCE.json says frozenRuntimeGitCommit=${shortSha}, `
      + 'but stock-preparation-rca-window.ps1 — shipped in the SAME archive — names a different '
      + 'runtime. Bumping the pin without cutting a real release is what this catches.',
    )
    // POSITIVE CONTROL: the check must be able to FAIL, or it asserts nothing.
    assert.equal(windowScript.includes('deadbeef0'), false,
      'the coherence check must not pass for an arbitrary sha')
    assert.equal(provenance.externalWrite, false)
    assert.equal(
      provenance.frozenHelperSha256['stock-preparation-rca-window-pm2-sample.mjs'],
      '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec',
    )

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
  assert.match(
    workflow,
    /- name: Require manual delivery builds from main\n\s+if: github\.event_name == 'workflow_dispatch'\n\s+run: test "\$GITHUB_REF" = 'refs\/heads\/main'/,
  )
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
  assert.match(workflow, /sha256sum "\$package_name\.zip" > "\$package_name\.zip\.sha256"/)
  assert.match(workflow, /name: stock-preparation-rca-c-window-sidecar-\$\{\{ env\.SOURCE_SHA \}\}/)
})
