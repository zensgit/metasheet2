import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../stock-preparation-p3/Invoke-P3Rollback.ps1', import.meta.url))
const windows = process.platform === 'win32'
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')

const probe = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const sql = path.basename(args[args.indexOf('-f') + 1])
const scenario = process.env.P3_TEST_SCENARIO
const overlaid = fs.existsSync(process.env.P3_TEST_FLAG)
const requireReadOnly = args.join(' ').includes('SET default_transaction_read_only = on; SET row_security = off;')
if (!requireReadOnly || !args.includes('-X') || !args.includes('-w')) process.exit(7)
if (sql === 's06-new-migrations.sql') {
  if (!overlaid && scenario === 'replace-verified-inputs') {
    for (const [file, replacement] of [
      [process.env.P3_TEST_ARCHIVE, 'replacement archive'],
      [process.env.P3_TEST_ORIGINAL_BOOTSTRAP, '[Console]::Out.WriteLine("UNVERIFIED_LAUNCHER"); exit 0'],
    ]) {
      fs.writeFileSync(file + '.new', replacement)
      fs.renameSync(file + '.new', file)
    }
  }
  console.log('MIG_COUNT kysely_migration=' + (overlaid && scenario === 'ledger-changed' ? 8 : 7))
  console.log('MIG_NAMESET ledger=' + (scenario === 'wrong-ledger' ? 'other' : 'baseline'))
  console.log('MIG_RESULT file=s06-new-migrations.sql status=complete')
} else if (sql === 'r2-stock-prep-stop.sql') {
  console.log('STOP_SP q102_claim_active=' + (scenario === 'legacy-102' ? 1 : 0) + ' q103_holds_open=0 q103_executions_unfinished=0 q104_plans_confirmed_or_written=0 q106_unsettled=0 q108_repair_running=0')
  console.log('STOP_PULLBATCH settings=0 sheet=0 batch=0 execution=' + (scenario === 'active-pullbatch' ? 1 : 0))
  console.log('STOP_SP_RESULT file=r2-stock-prep-stop.sql status=complete')
} else if (sql === 'r3-platform-stop.sql') {
  console.log('STOP_PLAT handovers_applied_or_finalized=' + (scenario === 'platform-active' ? 1 : 0) + ' login_repairs_applied=0 datasource_tokens_encrypted=0 users_in_recycle_bin=0')
  console.log('STOP_PLAT_RESULT file=r3-platform-stop.sql status=complete')
} else if (sql === 'p5-switch-off-row-counts.sql') {
  console.log('P5_COUNT n=1 metric=automation_rules value=2')
  console.log('P5_SUMMARY metrics=1 counted=1 absent=0 no_select=0 nonzero=1')
  console.log('P5_VERDICT all_zero=f')
  console.log('P5_RESULT file=p5-switch-off-row-counts.sql status=complete')
} else if (sql === 'p4-include-children-false-rows.sql') {
  const columns = scenario === 'partial-p4' ? 1 : 0
  console.log('P4_SUMMARY tables=2 columns_present=' + columns + ' false_rows_total=' + (scenario === 'false-rows' ? 1 : 0))
  console.log('P4_VERDICT blocking=' + (scenario === 'unknown-p4' ? 'unknown' : scenario === 'false-rows' ? 'STOP' : 'pass'))
  if (scenario !== 'missing-p4-result') console.log('P4_RESULT file=p4-include-children-false-rows.sql status=complete')
} else {
  process.exit(6)
}
`

function run(scenario, { target = 'R85', release = target, apply = false, authorized = true, badHash = false, otherBootstrap = false } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3 rollback '))
  try {
    const install = path.join(fixture, 'install')
    const sql = path.join(fixture, 'sql')
    const archive = path.join(fixture, 'old archive.zip')
    const bootstrap = path.join(fixture, 'old bootstrap.ps1')
    const stdoutLog = path.join(fixture, 'p3-rollback-launcher.stdout.log')
    const stderrLog = path.join(fixture, 'p3-rollback-launcher.stderr.log')
    const flag = path.join(fixture, 'overlay-invoked')
    const backend = path.join(install, 'packages/core-backend/dist/src')
    mkdirSync(backend, { recursive: true })
    mkdirSync(path.join(install, 'docker'), { recursive: true })
    mkdirSync(sql)
    writeFileSync(path.join(backend, 'index.js'), '// fixture')
    writeFileSync(path.join(install, 'docker/app.env'), '# fixture')
    const packageName = 'metasheet-multitable-onprem-v2.5.0-' + release.toLowerCase()
    const packageRoot = path.join(fixture, packageName)
    mkdirSync(packageRoot)
    writeFileSync(path.join(packageRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({
      schema: 'metasheet-onprem-build-provenance/v1',
      gitCommit: release === 'R85' ? '220bd80ab62fc7e6b3b40b7d4263a712d9a09405' : 'beed2a1e1cd239975d695ce6ce4d7264e38c3a1e',
      packageName,
      tag: release.toLowerCase(),
    }))
    const zip = spawnSync('tar.exe', ['-a', '-cf', archive, packageName], { cwd: fixture, encoding: 'utf8' })
    assert.equal(zip.status, 0, zip.stderr)
    writeFileSync(bootstrap, [
      'param($RootDir, $PackageArchive, $InstallDeps, $RunMigrations)',
      'function Stop-Fixture([string]$Field) { [Console]::Error.WriteLine("FIXTURE_ARGUMENT_MISMATCH field=" + $Field); exit 9 }',
      'function Assert-FixturePath([string]$Field, [string]$Actual, [string]$Expected) {',
      '  if ([string]::IsNullOrWhiteSpace($Actual)) { Stop-Fixture $Field }',
      '  try {',
      '    $actualPath = (Get-Item -LiteralPath $Actual -ErrorAction Stop).FullName',
      '    $expectedPath = (Get-Item -LiteralPath $Expected -ErrorAction Stop).FullName',
      '  } catch { Stop-Fixture $Field }',
      '  if ($actualPath -ine $expectedPath) { Stop-Fixture $Field }',
      '}',
      'if ($RunMigrations -ne "0") { Stop-Fixture "RunMigrations" }',
      'if ($InstallDeps -ne "1") { Stop-Fixture "InstallDeps" }',
      'Assert-FixturePath "RootDir" $RootDir $env:P3_TEST_ROOT',
      '$sha = [Security.Cryptography.SHA256]::Create()',
      '$archiveStream = [IO.File]::OpenRead($PackageArchive)',
      'try { $actualDigest = [BitConverter]::ToString($sha.ComputeHash($archiveStream)).Replace("-", "") }',
      'finally { $archiveStream.Dispose(); $sha.Dispose() }',
      'if ($actualDigest -ine $env:P3_TEST_ARCHIVE_SHA256) { Stop-Fixture "PackageArchive" }',
      '[IO.File]::WriteAllText($env:P3_TEST_FLAG, "ok")',
      '[Console]::Out.WriteLine("FIXTURE_STDOUT")',
      '[Console]::Error.WriteLine("FIXTURE_STDERR")',
      'if ($env:P3_TEST_SCENARIO -eq "launcher-failed") { exit 8 }',
      'exit 0',
    ].join('\r\n'))
    for (const file of [
      's06-new-migrations.sql', 'r2-stock-prep-stop.sql', 'r3-platform-stop.sql',
      'p4-include-children-false-rows.sql', 'p5-switch-off-row-counts.sql',
    ]) writeFileSync(path.join(sql, file), '-- synthetic probe')
    writeFileSync(path.join(fixture, 'psql.cjs'), probe)
    writeFileSync(path.join(fixture, 'psql.cmd'), '@node "%~dp0psql.cjs" %*\r\n')

    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    // Use the released sidecar check as-is in the mismatch case. For the other
    // fixtures only its approved digest changes, so no real launcher can run.
    const fixtureScript = path.join(fixture, 'Invoke-P3Rollback.ps1')
    const source = readFileSync(script, 'utf8')
    const releaseDigest = "'0c7f7ce8af5c71cc798f5bab21a1dd9014039c9902d6c82aca4e974f0b00bea7'"
    const archiveDigest = release === 'R85'
      ? "'f3f09d87511712f1dbe48f0274d4745c6bba6b4a5fe316c1c82c17dde95bd164'"
      : "'22c6c528b2571defe9b722860a0ef885e9b57d3a7a51bc919f331fff5e895bd4'"
    assert.ok(source.includes(releaseDigest))
    assert.ok(source.includes(archiveDigest))
    const withArchive = source.replace(archiveDigest, "'" + digest(archive) + "'")
    writeFileSync(fixtureScript, otherBootstrap ? withArchive : withArchive.replace(releaseDigest, "'" + digest(bootstrap) + "'"))
    const argv = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript,
      '-Target', target, '-InstallState', 'C', '-InstallRoot', install, '-SqlDir', sql,
      '-Archive', archive, '-ArchiveSha256', badHash ? '0'.repeat(64) : digest(archive),
      '-Bootstrap', bootstrap, '-BootstrapSha256', digest(bootstrap), '-InstallDeps', '1',
      '-LauncherLogDirectory', fixture,
    ]
    if (target === 'R84') argv.push('-LegacyClassBOff')
    if (apply) argv.push('-Execute')
    if (apply && authorized) argv.push('-OwnerApproved', '-WritesQuiesced')
    const env = {
      ...process.env,
      Path: fixture + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.Path,
      PGDATABASE: 'synthetic-only',
      P3_TEST_SCENARIO: scenario,
      P3_TEST_FLAG: flag,
      P3_TEST_ROOT: install.split(path.sep).join('/'),
      P3_TEST_ARCHIVE: archive.split(path.sep).join('/'),
      P3_TEST_ARCHIVE_SHA256: digest(archive),
      P3_TEST_ORIGINAL_BOOTSTRAP: bootstrap,
    }
    const result = spawnSync(powershell, argv, { env, encoding: 'utf8' })
    let overlaid = false
    try { overlaid = readFileSync(flag, 'utf8') === 'ok' } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    function readLog(file) {
      try { return readFileSync(file, 'utf8') } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return ''
      }
    }
    const originalsReplaced = readFileSync(archive, 'utf8') === 'replacement archive' &&
      readFileSync(bootstrap, 'utf8').includes('UNVERIFIED_LAUNCHER')
    return { ...result, overlaid, originalsReplaced, stdoutLog: readLog(stdoutLog), stderrLog: readLog(stderrLog) }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

for (const [scenario, stage, options] of [
  ['wrong-ledger', 'ledger_before', { apply: true }],
  ['active-pullbatch', 'stock_prep', { apply: true }],
  ['legacy-102', 'stock_prep', { target: 'R84', apply: true }],
  ['platform-active', 'platform', { target: 'R84', apply: true }],
  ['false-rows', 'p4', { apply: true }],
  ['unknown-p4', 'p4', { apply: true }],
  ['partial-p4', 'p4', { apply: true }],
  ['missing-p4-result', 'p4', { apply: true }],
  ['unauthorized', 'input', { apply: true, authorized: false }],
  ['bad-hash', 'hash', { apply: true, badHash: true }],
  ['wrong-release', 'release', { apply: true, target: 'R85', release: 'R84' }],
  ['other-bootstrap', 'release', { apply: true, otherBootstrap: true }],
]) {
  test(`rollback blocks ${scenario} before invoking the old launcher`, { skip: !windows }, () => {
    const result = run(scenario, options)
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stdout, new RegExp(`status=STOP stage=${stage}`))
    assert.equal(result.overlaid, false)
  })
}

test('rollback preflight never invokes the old launcher', { skip: !windows }, () => {
  const result = run('ok')
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /status=preflight_pass/)
  assert.equal(result.overlaid, false)
})

test('state C overlay passes exactly RunMigrations=0 and permits report-only counts', { skip: !windows }, () => {
  const result = run('legacy-102', { apply: true })
  assert.equal(result.status, 0, result.stderr + result.stdout + result.stderrLog)
  assert.match(result.stdout, /P5_VERDICT all_zero=f/)
  assert.match(result.stdout, /status=overlay_complete/)
  assert.equal(result.overlaid, true)
  assert.match(result.stdoutLog, /FIXTURE_STDOUT/)
  assert.match(result.stderrLog, /FIXTURE_STDERR/)
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_STDOUT|FIXTURE_STDERR/)
})

test('launcher failure keeps separate stdout and stderr logs', { skip: !windows }, () => {
  const result = run('launcher-failed', { apply: true })
  assert.equal(result.status, 2, result.stderr + result.stdout)
  assert.match(result.stdout, /status=STOP stage=overlay reason=launcher_nonzero/, result.stderrLog)
  assert.match(result.stdoutLog, /FIXTURE_STDOUT/)
  assert.match(result.stderrLog, /FIXTURE_STDERR/)
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_STDOUT|FIXTURE_STDERR/)
})

test('a changed post-overlay ledger cannot report overlay complete', { skip: !windows }, () => {
  const result = run('ledger-changed', { apply: true })
  assert.equal(result.status, 2, result.stderr + result.stdout)
  assert.match(result.stdout, /status=STOP stage=ledger_after/)
  assert.equal(result.overlaid, true)
})

test('replacing the original ZIP and sidecar after hash verification cannot change the bytes used', { skip: !windows }, () => {
  const result = run('replace-verified-inputs', { apply: true })
  assert.equal(result.status, 0, result.stdout + result.stderrLog)
  assert.equal(result.originalsReplaced, true)
  assert.equal(result.overlaid, true)
  assert.match(result.stdoutLog, /FIXTURE_STDOUT/)
  assert.doesNotMatch(result.stdoutLog, /UNVERIFIED_LAUNCHER/)
  assert.match(result.stdout, /P3_ROLLBACK_OVERLAY completed_utc=\S+/)
})
