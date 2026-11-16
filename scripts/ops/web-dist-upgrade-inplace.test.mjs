import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const updater = path.join(repo, 'scripts/ops/multitable-onprem-package-upgrade-inplace.ps1')
const helper = path.join(repo, 'scripts/ops/web-dist-retain-assets.mjs')
const shell = process.env.WEB_DIST_TEST_POWERSHELL || process.env.WEB_DIST_TEST_SHELL || process.env.UPGRADE_INPLACE_TEST_SHELL || 'pwsh'
const mainMarker = "if ($MyInvocation.InvocationName -ne '.') {"
const web = 'apps/web/dist'
const backend = 'packages/core-backend/dist'
const replaceDirs = `@('${backend}', '${web}', 'packages/core-backend/migrations')`
const quote = value => `'${String(value).replaceAll("'", "''")}'`

function write(root, relative, contents) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}

function run(source, fx) {
  const harness = write(fx.root, 'harness.ps1', '\uFEFF' + source)
  const env = { ...process.env }
  // PowerShell 5.1 must discover its own module path when launched from pwsh 7.
  delete env.PSModulePath
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', harness], {
    encoding: 'utf8', env, timeout: 60000,
  })
  assert.ifError(result.error)
  return result
}

function fixture(t, { collision = false, missingHelper = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'web-inplace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'live')
  const packaged = path.join(root, 'package-parent', 'release')
  write(live, `${web}/index.html`, 'OLD INDEX')
  write(live, `${web}/build-info.json`, '{"version":"old"}')
  write(live, `${web}/assets/old-123456.js`, 'old lazy route')
  write(live, `${web}/assets/shared-123456.js`, 'shared immutable bytes')
  write(live, `${backend}/src/db/migrate.js`, 'old backend')
  write(live, 'packages/core-backend/migrations/000_old.sql', 'old migration')
  write(live, 'plugins/plugin-integration-core/index.cjs', 'old plugin')
  write(packaged, `${web}/index.html`, 'NEW INDEX')
  write(packaged, `${web}/build-info.json`, '{"version":"new"}')
  write(packaged, `${web}/assets/new-234567.js`, 'new lazy route')
  write(packaged, `${web}/assets/shared-123456.js`, collision ? 'different bytes under same name' : 'shared immutable bytes')
  write(packaged, `${backend}/src/db/migrate.js`, 'new backend')
  write(packaged, 'packages/core-backend/migrations/001_new.sql', 'new migration')
  write(packaged, 'plugins/plugin-integration-core/index.cjs', 'new plugin')
  write(packaged, 'plugins/plugin-integration-core/app.manifest.json', '{"id":"plugin-integration-core"}')
  write(packaged, 'plugins/plugin-integration-core/package.json', '{"version":"1.0.0"}')
  write(packaged, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs', 'preflight')
  if (!missingHelper) write(packaged, 'scripts/ops/web-dist-retain-assets.mjs', fs.readFileSync(helper))
  return { root, live, packaged, lifecycle: path.join(root, 'lifecycle.log'), backups: path.join(root, 'backups') }
}

function assertOldLive(fx) {
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'index.html'), 'utf8'), 'OLD INDEX')
  assert.equal(fs.readFileSync(path.join(fx.live, backend, 'src/db/migrate.js'), 'utf8'), 'old backend')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'assets/old-123456.js'), 'utf8'), 'old lazy route')
  assert.equal(fs.existsSync(path.join(fx.live, web, 'assets/new-234567.js')), false)
}

function runMain(fx, { failLiveCopy = false, missingNode = false } = {}) {
  const archive = path.join(fx.root, 'release.zip')
  const compressed = run(`Compress-Archive -LiteralPath ${quote(fx.packaged)} -DestinationPath ${quote(archive)} -Force`, fx)
  assert.equal(compressed.status, 0, compressed.stderr || compressed.stdout)
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  fs.writeFileSync(archive + '.sha256', `${digest}  release.zip\n`)
  // Keep the real main, checksum, backup, extraction, preparation, journal and
  // filesystem replacement. Only replace OS/service/network boundaries.
  const stubs = `
function Resolve-Pm2Home { return [pscustomobject]@{ Home = ''; Source = 'synthetic' } }
function Resolve-Pm2Command { return 'synthetic-pm2' }
function Test-MaintenanceGateWired { return 'WIRED' }
function Get-Pm2ScheduledTask { return $null }
function Stop-Pm2App {
  param($Pm2Command, $Name, $Pm2Home, [switch]$AfterFailure, [switch]$KillDaemonAfterStop)
  Add-Content -LiteralPath ${quote(fx.lifecycle)} -Value $(if ($AfterFailure) { 'stop-after-failure' } else { 'stop' })
}
function Start-BackendAfterUnappliedUpgrade { Add-Content -LiteralPath ${quote(fx.lifecycle)} -Value 'unapplied-recovery'; return 'synthetic' }
${failLiveCopy ? `
Set-Item -Path Function:Original-CopyTree -Value (Get-Item Function:Copy-TreeExcludingNodeModules).ScriptBlock
function Copy-TreeExcludingNodeModules {
  param($Source, $Destination)
  if ([System.IO.Path]::GetFullPath($Destination) -eq [System.IO.Path]::GetFullPath(${quote(path.join(fx.live, backend))})) { throw 'SYNTHETIC_LIVE_COPY_FAILURE' }
  Original-CopyTree -Source $Source -Destination $Destination
}
` : ''}
${missingNode ? "$env:PATH = ''" : ''}
`
  const source = fs.readFileSync(updater, 'utf8')
  assert.equal(source.split(mainMarker).length, 2)
  const executable = write(fx.root, 'updater.ps1', '\uFEFF' + source.replace(mainMarker, stubs + '\n' + mainMarker))
  return run(`& ${quote(executable)} -PackageArchive ${quote(archive)} -RootDir ${quote(fx.live)} -BackupRoot ${quote(fx.backups)} -StagingRoot ${quote(path.join(fx.root, 'extract'))} -RunMigrations '0' -RestartService '0'`, fx)
}

test('real preparation writes only package assets; backup and replacement preserve the old route', t => {
  const fx = fixture(t)
  const result = run(`
. ${quote(updater)} -PackageArchive 'unused' -RootDir ${quote(fx.live)}
$journal = @{ Replaced = $false }
$backup = New-TimestampedBackup -RootDir ${quote(fx.live)} -BackupRoot ${quote(fx.backups)} -RelativePaths ${replaceDirs}
Prepare-WebDistForUpgrade -PackageRoot ${quote(fx.packaged)} -RootDir ${quote(fx.live)} -RelativeDirs ${replaceDirs}
if ($journal.Replaced) { throw 'Preparation changed the replacement journal' }
if ((Get-Content -LiteralPath ${quote(path.join(fx.live, web, 'index.html'))} -Raw) -ne 'OLD INDEX') { throw 'Preparation changed live index' }
Update-ReplaceDirs -PackageRoot ${quote(fx.packaged)} -RootDir ${quote(fx.live)} -RelativeDirs ${replaceDirs} -Journal $journal
if (-not $journal.Replaced) { throw 'Replacement did not mark journal' }
Write-Host ('BACKUP=' + $backup)
`, fx)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'index.html'), 'utf8'), 'NEW INDEX')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'build-info.json'), 'utf8'), '{"version":"new"}')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'assets/old-123456.js'), 'utf8'), 'old lazy route')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'assets/new-234567.js'), 'utf8'), 'new lazy route')
  const backup = result.stdout.match(/BACKUP=([^\r\n]+)/)?.[1]
  assert.ok(backup, result.stdout)
  assert.equal(fs.readFileSync(path.join(backup, web, 'index.html'), 'utf8'), 'OLD INDEX')
  assert.equal(fs.existsSync(path.join(backup, web, 'assets/new-234567.js')), false)
})

test('the real main retains old chunks while publishing the new index', t => {
  const fx = fixture(t)
  const result = runMain(fx)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'index.html'), 'utf8'), 'NEW INDEX')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'assets/old-123456.js'), 'utf8'), 'old lazy route')
  assert.equal(fs.readFileSync(path.join(fx.live, web, 'assets/new-234567.js'), 'utf8'), 'new lazy route')
  assert.equal(fs.readFileSync(fx.lifecycle, 'utf8').trim(), 'stop')
  assert.equal(fs.existsSync(path.join(fx.live, 'output/maintenance.flag')), false)
})

for (const [name, options, error] of [
  ['collision', { collision: true }, /WEB_DIST_VALIDATE_FAILED|collision/i],
  ['missing packaged helper', { missingHelper: true }, /WEB_DIST_HELPER_MISSING/],
]) {
  test(`the real main refuses ${name} before any runtime replacement`, t => {
    const fx = fixture(t, options)
    const result = runMain(fx)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, error)
    assertOldLive(fx)
    assert.deepEqual(fs.readFileSync(fx.lifecycle, 'utf8').trim().split(/\r?\n/), ['stop', 'unapplied-recovery'])
    assert.equal(fs.existsSync(path.join(fx.live, 'output/maintenance.flag')), false)
  })
}

test('a copy failure after preparation retains the original replaced-upgrade recovery branch', t => {
  const fx = fixture(t)
  const result = runMain(fx, { failLiveCopy: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /SYNTHETIC_LIVE_COPY_FAILURE/)
  assert.deepEqual(fs.readFileSync(fx.lifecycle, 'utf8').trim().split(/\r?\n/), ['stop', 'stop-after-failure'])
  assert.match(result.stdout, /Backup path:/)
  const backups = fs.readdirSync(fx.backups)
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(fx.backups, backups[0], web, 'assets/old-123456.js'), 'utf8'), 'old lazy route')
  assert.equal(fs.readFileSync(path.join(fx.backups, backups[0], backend, 'src/db/migrate.js'), 'utf8'), 'old backend')
})

test('missing Node fails in main before creating a backup or maintenance gate and before stop', t => {
  const fx = fixture(t)
  const result = runMain(fx, { missingNode: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /WEB_DIST_NODE_MISSING/)
  assertOldLive(fx)
  assert.equal(fs.existsSync(fx.lifecycle), false)
  assert.equal(fs.existsSync(fx.backups), false)
  assert.equal(fs.existsSync(path.join(fx.live, 'output/maintenance.flag')), false)
})

test('backend-only replacement does not introduce a web or Node prerequisite', t => {
  const fx = fixture(t, { missingHelper: true })
  const result = run(`
. ${quote(updater)} -PackageArchive 'unused' -RootDir ${quote(fx.live)}
$env:PATH = ''
Assert-WebDistNodeAvailable -RelativeDirs @('${backend}')
Prepare-WebDistForUpgrade -PackageRoot ${quote(fx.packaged)} -RootDir ${quote(fx.live)} -RelativeDirs @('${backend}')
Write-Host 'BACKEND_ONLY_OK'
`, fx)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /BACKEND_ONLY_OK/)
  assertOldLive(fx)
})
