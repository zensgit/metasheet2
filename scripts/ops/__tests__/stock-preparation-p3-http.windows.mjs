import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const healthServer = `
const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((req, res) => {
  if (req.url !== '/api/health') { res.writeHead(404).end(); return }
  const body = JSON.stringify({ build: { commit: fs.readFileSync(process.argv[2], 'utf8') } })
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
})
server.listen(0, '127.0.0.1', () => process.send(server.address().port))
`

const peerLookupFixture = String.raw`
$script:firstTuple = $null
$script:attempts = 0
function Get-NetTCPConnection {
  [CmdletBinding()]
  param([int]$LocalPort, [int]$RemotePort, [string]$State)
  $tuple = "$LocalPort/$RemotePort/$State"
  if ($script:firstTuple -and $tuple -cne $script:firstTuple) { throw 'lookup changed sockets' }
  $script:firstTuple = $tuple
  $script:attempts++
  if ($env:P3_TEST_PEER_MODE -eq 'missing' -or $script:attempts -eq 1) {
    Write-Error -Message 'synthetic delayed peer' -Category ObjectNotFound
    return
  }
  $record = [pscustomobject]@{ LocalAddress='127.0.0.1'; RemoteAddress='127.0.0.1'; OwningProcess=[int]$env:P3_TEST_PEER_PID }
  if ($env:P3_TEST_PEER_MODE -eq 'ambiguous') { return $record, $record }
  if ($env:P3_TEST_PEER_MODE -eq 'ownerless') { $record.OwningProcess = 0 }
  return $record
}
. $env:P3_TEST_H01 @args
exit $LASTEXITCODE
`

test('H01 retries the same socket and refuses stale, missing, ambiguous and mismatched owners', { skip: process.platform !== 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3-health-bind-'))
  const servers = []
  try {
    const http = path.join(fixture, 'http')
    const ps = path.join(fixture, 'ps')
    const bin = path.join(fixture, 'node_modules/.bin')
    const pm2 = path.join(fixture, 'pm2')
    const backend = path.join(fixture, 'packages/core-backend/dist/src/index.js')
    for (const directory of [http, ps, bin, pm2, path.dirname(backend)]) mkdirSync(directory, { recursive: true })
    writeFileSync(backend, '// fixture')
    copyFileSync(path.join(ops, 'h01-health.ps1'), path.join(http, 'h01-health.ps1'))
    copyFileSync(path.join(ops, '03-live-env-check.ps1'), path.join(ps, '03-live-env-check.ps1'))
    const serverFile = path.join(fixture, 'health.cjs')
    const diskLabel = path.join(fixture, 'disk-label')
    const pm2App = path.join(fixture, 'pm2-app.json')
    const probe = path.join(http, 'h01-health.ps1')
    const peerFixture = path.join(fixture, 'peer-fixture.ps1')
    const p3 = '1'.repeat(40)
    writeFileSync(serverFile, healthServer)
    writeFileSync(diskLabel, '220bd80ab62fc7e6b3b40b7d4263a712d9a09405')
    writeFileSync(path.join(bin, 'pm2.cmd'), '@type "%P3_TEST_PM2_DATA%"\r\n')
    writeFileSync(peerFixture, peerLookupFixture)
    async function startHealthServer() {
      const child = spawn(process.execPath, [serverFile, diskLabel], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
      servers.push(child)
      const [port] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error('fixture listener exited early') }),
      ])
      return { pid: child.pid, port }
    }
    const old = await startHealthServer()
    writeFileSync(path.join(pm2, 'pm2.pid'), String(old.pid))
    writeFileSync(diskLabel, p3)
    const overlayCompleted = new Date().toISOString().replace('Z', '0000+00:00')
    const fresh = await startHealthServer()

    function signoff(listener, app, peerMode) {
      writeFileSync(pm2App, JSON.stringify([{
        name: 'metasheet-backend',
        pid: app.pid,
        pm2_env: { PATH: 'fixture', status: 'online', pm_exec_path: backend },
      }]))
      return spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', peerMode ? peerFixture : probe,
        '-P3Commit', p3, '-InstallRoot', fixture, '-OverlayCompletedUtc', overlayCompleted, '-ExpectedBuild', 'P3',
      ], {
        env: {
          ...process.env, PM2_HOME: pm2, P3_TEST_PM2_DATA: pm2App, MS_API: `http://127.0.0.1:${listener.port}`,
          P3_TEST_H01: probe, P3_TEST_PEER_MODE: peerMode, P3_TEST_PEER_PID: String(listener.pid),
        },
        encoding: 'utf8',
        timeout: 90000,
      })
    }
    for (const app of [old, fresh]) {
      const refused = signoff(old, app)
      assert.equal(refused.status, 3, refused.stdout + refused.stderr)
      assert.match(refused.stdout, /HEALTH status=200 build=P3/)
      assert.match(refused.stdout, /reason=backend_not_bound_or_fresh/)
      assert.doesNotMatch(refused.stdout, /HEALTH_RUNTIME/)
    }
    const accepted = signoff(fresh, fresh)
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
    assert.match(accepted.stdout, /HEALTH_RUNTIME peer=verified generation=post_overlay/)
    assert.match(accepted.stdout, /HEALTH_RESULT file=h01-health.ps1 status=complete/)
    const delayed = signoff(fresh, fresh, 'delayed')
    assert.equal(delayed.status, 0, delayed.stdout + delayed.stderr)
    assert.match(delayed.stdout, /HEALTH_RUNTIME peer=verified generation=post_overlay/)
    for (const [mode, reason] of [
      ['missing', 'peer_lookup_timeout'], ['ambiguous', 'peer_owner_unconfirmed'], ['ownerless', 'peer_owner_unconfirmed'],
    ]) {
      const refused = signoff(fresh, fresh, mode)
      assert.equal(refused.status, 3, refused.stdout + refused.stderr)
      assert.match(refused.stdout, new RegExp(`reason=${reason}\\r?\\n`))
      assert.doesNotMatch(refused.stdout, /HEALTH_RUNTIME|HEALTH status=/)
    }
  } finally {
    for (const child of servers) child.kill()
    rmSync(fixture, { recursive: true, force: true })
  }
})

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
