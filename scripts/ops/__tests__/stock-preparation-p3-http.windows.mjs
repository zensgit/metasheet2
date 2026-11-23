import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ops = fileURLToPath(new URL('../stock-preparation-p3/', import.meta.url))
const helper = String.raw`
function Initialize-Http([string]$TokenFile) {}
function Clear-Http {}
function Test-ProjectNo($v) { return ($v -ceq 'P3-FIXTURE') }
function Get-Word($v) { return [string]$v }
function Get-ErrCode($json) { return 'none' }
function Invoke-Http([string]$Method, [string]$Path, [object]$Body = $null, [switch]$Integration) {
  if (-not $Integration) { throw 'integration expected' }
  $base='/api/integration/table-actions/plm.stock-preparation.pull-bom.v1'
  $counts=[ordered]@{ add=1; update=2; skip=3; inactive=4; manual_confirm=5; unknown='NEVER-PRINT' }
  if ($env:P3_TEST_MODE -eq 'bad_counts') { $counts.skip='NEVER-PRINT' }
  $data=[pscustomobject]@{ status='ready'; canApply=$true; counts=[pscustomobject]$counts }
  if ($Method -eq 'POST' -and $Body.parameters.projectNo -ne 'P3-FIXTURE') { throw 'missing project' }
  if ($Method -eq 'POST' -and $Path -ceq "$base/dry-run") {
    return @{ Status=200; Json=@{ data=$data }; NoAnswer=$null }
  }
  if ($Method -eq 'POST' -and $Path -ceq "$base/dry-run-jobs") {
    if ($script:started) { throw 'enqueue repeated' }
    $script:started=$true
    return @{ Status=202; Json=@{ data=@{ jobId='NEVER-PRINT-a' } }; NoAnswer=$null }
  }
  if ($Method -eq 'GET' -and $Path -ceq "$base/dry-run-jobs?projectNo=P3-FIXTURE" -and $script:started) {
    $job=if ($env:P3_TEST_MODE -eq 'wrong_job') { 'NEVER-PRINT-b' } else { 'NEVER-PRINT-a' }
    $state=if ($env:P3_TEST_MODE -eq 'failed_job') { 'failed' } else { 'succeeded' }
    return @{ Status=200; Json=@{ data=@{ jobId=$job; status=$state; result=$data } }; NoAnswer=$null }
  }
  throw 'unexpected route'
}
`

const sync = 'h31-pull-dry-run.ps1'
const job = 'h32-pull-dry-run-job.ps1'
const expected = 'PULLDRY_COUNTS project=1 add=1 update=2 skip=3 inactive=4 manual_confirm=5'

test('H01 maps both approved rollback builds and rejects an ambiguous P3 identity', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3-health-'))
  try {
    const file = path.join(fixture, 'h01-health.ps1')
    copyFileSync(path.join(ops, 'h01-health.ps1'), file)
    writeFileSync(path.join(fixture, '_http.ps1'), String.raw`
function Initialize-Http([switch]$NoToken) {
  if (-not $NoToken) { throw 'health must be anonymous' }
}
function Invoke-Http([string]$Method, [string]$Path, [switch]$Anonymous) {
  if ($Method -ne 'GET' -or $Path -ne '/api/health' -or -not $Anonymous) { throw 'wrong health request' }
  return @{ Status=200; Json=[pscustomobject]@{ build=[pscustomobject]@{ commit=$env:P3_TEST_BUILD } }; NoAnswer=$null }
}
`)
    const p3 = '1'.repeat(40)
    const r85 = '220bd80ab62fc7e6b3b40b7d4263a712d9a09405'
    const r84 = 'beed2a1e1cd239975d695ce6ce4d7264e38c3a1e'
    for (const [commit, label] of [[p3, 'P3'], [r85, 'R85'], [r84, 'R84'], ['2'.repeat(40), 'other'], ['', 'absent']]) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-P3Commit', p3], {
        env: { ...process.env, P3_TEST_BUILD: commit }, encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.match(result.stdout, new RegExp(`HEALTH status=200 build=${label}\\r?\\n`))
      if (commit) assert.ok(!result.stdout.includes(commit))
    }
    const ambiguous = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-P3Commit', r84], { encoding: 'utf8' })
    assert.equal(ambiguous.status, 2)
    assert.match(ambiguous.stdout, /reason=ambiguous_build/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('P3 preview probes produce the same closed plan projection', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3-http-'))
  try {
    for (const file of [sync, job, '_pull-plan-counts.ps1']) copyFileSync(path.join(ops, file), path.join(fixture, file))
    writeFileSync(path.join(fixture, '_http.ps1'), helper)
    for (const [file, scenario, status, line] of [
      [sync, 'happy', 0, expected],
      [job, 'happy', 0, expected],
      [sync, 'bad_counts', 3, 'reason=invalid_counts'],
      [job, 'bad_counts', 3, 'reason=invalid_counts'],
      [job, 'wrong_job', 3, 'reason=poll_unconfirmed'],
      [job, 'failed_job', 3, 'reason=job_not_succeeded'],
    ]) {
      const run = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, file),
        '-TokenFile', 'fixture', '-ProjectNo', 'P3-FIXTURE', '-Ordinal', '1',
      ], { env: { ...process.env, P3_TEST_MODE: scenario }, encoding: 'utf8' })
      assert.equal(run.status, status, `${file} ${scenario}: ${run.stdout}${run.stderr}`)
      assert.ok(run.stdout.includes(line), run.stdout)
      assert.doesNotMatch(run.stdout, /NEVER-PRINT|P3-FIXTURE/)
      if (status) assert.doesNotMatch(run.stdout, /PULLDRY_COUNTS|^add=/m)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
