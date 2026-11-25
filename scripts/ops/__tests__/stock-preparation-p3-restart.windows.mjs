import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ops = fileURLToPath(new URL('../', import.meta.url))
const restart = path.join(ops, 'stock-preparation-p3/Restart-P3BackendForSignoff.ps1')
const bootstrapFixture = String.raw`
param([string]$RootDir, [string]$ApplyScript)
$ErrorActionPreference = 'Stop'
# Use the production installer import function without running the installer.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($ApplyScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { exit 7 }
$import = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Import-AppEnvFile' }, $false)
. ([scriptblock]::Create($import.Extent.Text))
$null = Import-AppEnvFile (Join-Path $RootDir 'docker\app.env')
& (Join-Path $RootDir 'scripts\ops\attendance-onprem-start-pm2.ps1') -RootDir $RootDir
exit $LASTEXITCODE
`

const pm2Fixture = String.raw`
const fs = require('node:fs')
const [command, target, ...flags] = process.argv.slice(2)
const stateFile = process.env.P3_FIXTURE_STATE
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
if (command === 'jlist') {
  const app = structuredClone(state.app)
  if (process.env.P3_FIXTURE_WRONG_CWD === 'true') app.pm2_env.pm_cwd = process.env.SystemRoot
  process.stdout.write(JSON.stringify([app]))
} else if (command === 'restart' && target === 'metasheet-backend') {
  if (flags.includes('--update-env')) {
    state.effective = Object.fromEntries(['PORT', 'P3_SHARED', 'P3_ROOT_ONLY', 'P3_DOCKER_ONLY', 'P3_AMBIENT'].map(key => [key, process.env[key]]))
  } else if (flags.length) {
    process.exit(4)
  }
  state.restarts++
  fs.writeFileSync(stateFile, JSON.stringify(state))
} else if (command !== 'save') {
  process.exit(6)
}
`

test('P3 signoff restart preserves the installer-saved environment when both app.env files exist', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3 restart fixture '))
  try {
    const bin = path.join(fixture, 'node_modules/.bin')
    const appdataNpm = path.join(fixture, 'appdata/Roaming/npm')
    const pm2Home = path.join(fixture, 'pm2')
    const startup = path.join(fixture, 'scripts/ops/attendance-onprem-start-pm2.ps1')
    const boot = path.join(fixture, 'bootstrap-fixture.ps1')
    const stateFile = path.join(fixture, 'pm2-state.json')
    const backend = path.join(fixture, 'packages/core-backend/dist/src/index.js')
    for (const dir of [bin, appdataNpm, pm2Home, path.dirname(startup), path.dirname(backend), path.join(fixture, 'docker')]) {
      mkdirSync(dir, { recursive: true })
    }
    copyFileSync(path.join(ops, 'attendance-onprem-start-pm2.ps1'), startup)
    writeFileSync(boot, bootstrapFixture)
    writeFileSync(path.join(fixture, 'ecosystem.config.cjs'), '// fixture')
    writeFileSync(backend, '// fixture')
    writeFileSync(path.join(pm2Home, 'pm2.pid'), String(process.pid))
    writeFileSync(path.join(bin, 'pm2.cmd'), '@node "%~dp0pm2-fixture.cjs" %*\r\n')
    writeFileSync(path.join(bin, 'pm2-fixture.cjs'), pm2Fixture)
    writeFileSync(path.join(appdataNpm, 'pm2.cmd'), '@node "%~dp0pm2-fixture.cjs" %*\r\n')
    writeFileSync(path.join(appdataNpm, 'pm2-fixture.cjs'), pm2Fixture)
    writeFileSync(path.join(appdataNpm, 'pm2-fixture.cjs'), pm2Fixture)
    writeFileSync(path.join(fixture, 'docker/app.env'), "PORT = '4012'\r\nP3_SHARED=docker\r\nP3_DOCKER_ONLY=\"left=right\"\r\n")
    writeFileSync(path.join(fixture, 'app.env'), 'P3_SHARED=root\r\nP3_ROOT_ONLY=root\r\n')
    writeFileSync(stateFile, JSON.stringify({
      app: {
        name: 'metasheet-backend',
        pid: process.pid,
        pm2_env: { status: 'online', PATH: 'fixture', pm_exec_path: backend, pm_cwd: fixture },
      },
      restarts: 0,
    }))

    function run(script, args, extraEnv) {
      return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
        env: {
          ...process.env, PM2_HOME: pm2Home, APPDATA: path.join(fixture, 'appdata'),
          Path: path.dirname(process.execPath) + path.delimiter + process.env.Path.replace(appdataNpm, ''),
          P3_FIXTURE_STATE: stateFile, PORT: '3900', P3_AMBIENT: 'installer', ...extraEnv,
        },
        encoding: 'utf8',
        timeout: 40000,
      })
    }
    const applied = run(boot, ['-RootDir', fixture, '-ApplyScript', path.join(ops, 'multitable-onprem-apply-package.ps1')], {})
    assert.equal(applied.status, 0, applied.stdout + applied.stderr)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')).effective
    assert.deepEqual(saved, {
      PORT: '4012', P3_SHARED: 'root', P3_ROOT_ONLY: 'root', P3_DOCKER_ONLY: 'left=right', P3_AMBIENT: 'installer',
    })

    const restarted = run(restart, ['-InstallRoot', fixture], { P3_AMBIENT: 'operator' })
    assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr)
    assert.match(restarted.stdout, /P3_SIGNOFF_RESTART status=complete/)
    const after = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(after.restarts, 2)
    assert.deepEqual(after.effective, saved)

    const refused = run(restart, ['-InstallRoot', fixture], { P3_FIXTURE_WRONG_CWD: 'true' })
    assert.equal(refused.status, 2, refused.stdout + refused.stderr)
    assert.match(refused.stdout, /reason=backend_target_unconfirmed/)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).restarts, 2)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
