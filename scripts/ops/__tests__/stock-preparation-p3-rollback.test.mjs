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

function run(scenario, { target = 'R85', apply = false, authorized = true, badHash = false } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3 rollback '))
  try {
    const install = path.join(fixture, 'install')
    const sql = path.join(fixture, 'sql')
    const archive = path.join(fixture, 'old archive.zip')
    const bootstrap = path.join(fixture, 'old bootstrap.ps1')
    const flag = path.join(fixture, 'overlay-invoked')
    const backend = path.join(install, 'packages/core-backend/dist/src')
    mkdirSync(backend, { recursive: true })
    mkdirSync(path.join(install, 'docker'), { recursive: true })
    mkdirSync(sql)
    writeFileSync(path.join(backend, 'index.js'), '// fixture')
    writeFileSync(path.join(install, 'docker/app.env'), '# fixture')
    writeFileSync(archive, 'synthetic zip')
    writeFileSync(bootstrap, [
      'param($RootDir, $PackageArchive, $InstallDeps, $RunMigrations)',
      'if ($RunMigrations -ne "0" -or $RootDir -ne $env:P3_TEST_ROOT -or $InstallDeps -ne "1" -or $PackageArchive -ne $env:P3_TEST_ARCHIVE) { exit 9 }',
      '[IO.File]::WriteAllText($env:P3_TEST_FLAG, "ok")',
      'exit 0',
    ].join('\r\n'))
    for (const file of [
      's06-new-migrations.sql', 'r2-stock-prep-stop.sql', 'r3-platform-stop.sql',
      'p4-include-children-false-rows.sql', 'p5-switch-off-row-counts.sql',
    ]) writeFileSync(path.join(sql, file), '-- synthetic probe')
    writeFileSync(path.join(fixture, 'psql.cjs'), probe)
    writeFileSync(path.join(fixture, 'psql.cmd'), '@node "%~dp0psql.cjs" %*\r\n')

    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const argv = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Target', target, '-InstallState', 'C', '-InstallRoot', install, '-SqlDir', sql,
      '-Archive', archive, '-ArchiveSha256', badHash ? '0'.repeat(64) : digest(archive),
      '-Bootstrap', bootstrap, '-BootstrapSha256', digest(bootstrap), '-InstallDeps', '1',
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
      P3_TEST_ROOT: install,
      P3_TEST_ARCHIVE: archive,
    }
    const result = spawnSync(powershell, argv, { env, encoding: 'utf8' })
    let overlaid = false
    try { overlaid = readFileSync(flag, 'utf8') === 'ok' } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { ...result, overlaid }
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
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /P5_VERDICT all_zero=f/)
  assert.match(result.stdout, /status=overlay_complete/)
  assert.equal(result.overlaid, true)
})

test('a changed post-overlay ledger cannot report overlay complete', { skip: !windows }, () => {
  const result = run('ledger-changed', { apply: true })
  assert.equal(result.status, 2, result.stderr + result.stdout)
  assert.match(result.stdout, /status=STOP stage=ledger_after/)
  assert.equal(result.overlaid, true)
})
