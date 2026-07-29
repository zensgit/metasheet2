import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildSidecar } from './build-stock-preparation-bounded-candidate-probe-sidecar.mjs'

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

test('builder emits the one-shot values-free discovery contract with complete checksums', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-discovery-build-'))
  try {
    const { packageName, packageDir } = buildSidecar({ outputDir, sourceSha: SOURCE_SHA })
    assert.equal(packageName, 'stock-preparation-bounded-discovery-1234567890')
    const names = fs.readdirSync(packageDir).sort()
    assert.deepEqual(names, [
      'BUILD_PROVENANCE.json',
      'SHA256SUMS',
      'stock-preparation-bounded-candidate-probe-README.txt',
      'stock-preparation-bounded-candidate-probe.ps1',
      'stock-preparation-rca-window-pm2-sample.mjs',
    ])

    const provenance = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'BUILD_PROVENANCE.json'), 'utf8'),
    )
    assert.equal(
      provenance.contract,
      'stock-preparation-bounded-candidate-discovery-sidecar-v4',
    )
    assert.equal(provenance.sourceGitCommit, SOURCE_SHA)
    assert.equal(provenance.targetShell, 'Windows PowerShell 5.1')
    assert.equal(provenance.requestedRunCount, 1)
    assert.equal(provenance.deployment, false)
    assert.equal(provenance.configMutation, false)
    assert.equal(provenance.flagOn, false)
    assert.equal(provenance.externalWrite, false)
    assert.equal(provenance.valuesFreePublicOutput, true)
    assert.equal(provenance.sourceCountDiagnostics, 'closed-parameter-isolation-v4')
    assert.equal(
      provenance.frozenHelperSha256['stock-preparation-rca-window-pm2-sample.mjs'],
      '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec',
    )

    const checksumEntries = fs
      .readFileSync(path.join(packageDir, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(checksumEntries.length, names.length - 1)
    for (const line of checksumEntries) {
      const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/)
      assert.ok(match, `invalid checksum line: ${line}`)
      assert.equal(match[1], digest(path.join(packageDir, match[2])))
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('builder fails closed when the source SHA is not a full lowercase commit id', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-discovery-build-'))
  try {
    assert.throws(() => buildSidecar({ outputDir, sourceSha: 'short' }), /SOURCE_SHA_INVALID/)
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('delivery workflow binds test and artifact bytes to the exact source SHA', () => {
  const workflow = fs.readFileSync(
    path.join(
      repoRoot,
      '.github/workflows/stock-preparation-bounded-candidate-probe-sidecar.yml',
    ),
    'utf8',
  )
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /ref: \$\{\{ env\.SOURCE_SHA \}\}/)
  assert.match(
    workflow,
    /- name: Require manual delivery builds from main\n\s+if: github\.event_name == 'workflow_dispatch'\n\s+run: test "\$GITHUB_REF" = 'refs\/heads\/main'/,
  )
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
  assert.match(
    workflow,
    /stock-preparation-bounded-candidate-probe\.ps51\.tests\.ps1/,
  )
  assert.match(workflow, /sha256sum "\$package_name\.zip" > "\$package_name\.zip\.sha256"/)
  assert.match(
    workflow,
    /name: stock-preparation-bounded-discovery-\$\{\{ env\.SOURCE_SHA \}\}/,
  )
})

test('probe stdout is emitted only through the closed result formatter', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/ops/stock-preparation-bounded-candidate-probe.ps1'),
    'utf8',
  )
  assert.equal((script.match(/\[Console\]::Out\.WriteLine/g) ?? []).length, 1)
  assert.match(script, /Format-DiscoveryResultBlock -Result \$result/)
  assert.doesNotMatch(script, /Write-(Host|Output|Warning|Verbose|Error)/)
  assert.match(
    script,
    /SELECT TOP \(@p1\) CAST\(1 AS BIGINT\) AS \[probe_marker\]/,
  )
  assert.match(script, /SELECT COUNT_BIG\(1\) FROM \(SELECT TOP \(@p1\)/)
  assert.match(script, /FROM \$source WHERE \$field = @p0/)
  assert.match(script, /value = \(\[long\]\$Config\.limit \+ 1L\)/)
  assert.match(script, /AddWithValue\(\$parameter\.name, \$parameter\.value\)/)
  assert.match(script, /function Invoke-ProbeScalarCommand/)
  assert.match(script, /sourceBoundLimitControlAttempted/)
  assert.match(script, /sourceParameterFailureRole/)
  assert.match(script, /SOURCE_BOUND_LIMIT_CONTROL_FAILED/)
  assert.match(script, /SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID/)
  assert.match(script, /PREDICATE_OR_SOURCE/)
  assert.doesNotMatch(script, /SOURCE_COUNT_FAILED/)
  for (const reason of [
    'SOURCE_CREDENTIAL_UNAVAILABLE',
    'SOURCE_CONNECTION_FAILED',
    'SOURCE_BOUND_LIMIT_CONTROL_FAILED',
    'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID',
    'SOURCE_COUNT_STATEMENT_FAILED',
    'SOURCE_COUNT_RESULT_INVALID',
  ]) {
    assert.match(script, new RegExp(reason))
  }
})
