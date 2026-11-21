import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const startScriptPath = path.join(repoRoot, 'scripts/ops/attendance-onprem-start-pm2.ps1')
const requestedShell = process.env.ONPREM_PM2_TEST_SHELL || 'powershell.exe'
const readyPattern = /\[attendance-onprem-start-pm2\] pm2 service is ready: metasheet-backend/
const retiredSensitiveKeys = [
  'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED',
  'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON',
]
const TEST_TIMEOUT_MS = 60_000

function isWindowsPowershell(shellPath) {
  return /(^|[\\/])powershell(\.exe)?$/i.test(shellPath)
}

function locateWhereExe() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'where.exe')
}

function shellProbe(command) {
  const probe = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  return !probe.error && probe.status === 0
}

function resolveSelectedShell(name) {
  if (process.platform !== 'win32') {
    return { requested: name, resolved: null, error: 'native-process PM2 startup tests require Windows' }
  }
  if (path.isAbsolute(name)) {
    if (fs.existsSync(name) || shellProbe(name)) {
      return { requested: name, resolved: name, error: null }
    }
    return { requested: name, resolved: null, error: `selected shell is missing: ${name}` }
  }
  const whereExe = locateWhereExe()
  if (fs.existsSync(whereExe)) {
    const located = spawnSync(whereExe, [name], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    if (located.status === 0) {
      const first = String(located.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      // WindowsApps execution aliases can fail fs.existsSync while still being spawnable.
      if (first && (fs.existsSync(first) || shellProbe(first) || shellProbe(name))) {
        return { requested: name, resolved: fs.existsSync(first) ? first : name, error: null }
      }
    }
  }
  if (shellProbe(name)) {
    return { requested: name, resolved: name, error: null }
  }
  if (/^(powershell)(\.exe)?$/i.test(name)) {
    const wellKnown = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    if (fs.existsSync(wellKnown)) {
      return { requested: name, resolved: wellKnown, error: null }
    }
  }
  return { requested: name, resolved: null, error: `selected shell is missing: ${name}` }
}

const selectedShell = resolveSelectedShell(requestedShell)
const shellLabel = path.basename(selectedShell.resolved || requestedShell)

function requireSelectedShell() {
  assert.equal(process.platform, 'win32', 'native-process PM2 startup tests require Windows')
  assert.ok(
    selectedShell.resolved,
    selectedShell.error || `selected shell is missing: ${requestedShell}`,
  )
  return selectedShell.resolved
}

function writeUtf8(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function nativeFailure(message) {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

function nativeOk(stdout = '') {
  return { stdout, stderr: '', exitCode: 0 }
}

function matchingApp(root, extraPm2Env = {}) {
  return [
    {
      name: 'metasheet-backend',
      pm2_env: {
        pm_exec_path: path.join(root, 'packages', 'core-backend', 'dist', 'src', 'index.js'),
        pm_cwd: root,
        ...extraPm2Env,
      },
    },
  ]
}

function defaultCommands() {
  return {
    jlist: nativeOk('[]\n'),
    describe: nativeOk(''),
    start: nativeOk(''),
    restart: nativeOk(''),
    delete: nativeOk(''),
    save: nativeOk(''),
  }
}

function writeFakeConfig(fixture, commandOverrides = {}) {
  const commands = { ...defaultCommands(), ...commandOverrides }
  writeUtf8(
    path.join(fixture.root, 'node_modules', '.bin', 'pm2-fake.config.json'),
    `${JSON.stringify({ logPath: fixture.logPath, commands }, null, 2)}\n`,
  )
}

function createFixture(t, commandOverrides = {}) {
  const tempRoot = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(tempRoot, 'onprem-pm2-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const binDir = path.join(root, 'node_modules', '.bin')
  const logPath = path.join(root, 'pm2-invocations.jsonl')
  const fakeModulePath = path.join(binDir, 'pm2-fake.mjs')
  const cmdPath = path.join(binDir, 'pm2.cmd')

  writeUtf8(
    path.join(root, 'app.env'),
    [
      '# synthetic fixture; retired sensitive keys are intentionally absent',
      'NODE_ENV=production',
      'ATTENDANCE_ONPREM_PM2_FIXTURE=1',
      '',
    ].join('\n'),
  )
  writeUtf8(path.join(root, 'ecosystem.config.cjs'), 'module.exports = { apps: [] }\n')
  writeUtf8(path.join(root, 'packages/core-backend/dist/src/index.js'), 'export {}\n')

  const fixture = {
    root,
    logPath,
    userProfile: path.join(root, 'user-profile'),
    pm2Home: path.join(root, 'pm2-home'),
    tempDir: path.join(root, 'tmp'),
  }
  writeFakeConfig(fixture, commandOverrides)

  writeUtf8(
    fakeModulePath,
    `${[
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      'const config = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), \'pm2-fake.config.json\'), \'utf8\'))',
      'const args = process.argv.slice(2)',
      "const verb = String(args[0] || '').toLowerCase()",
      'fs.appendFileSync(config.logPath, `${JSON.stringify({ verb, args })}\\n`)',
      "const spec = config.commands[verb] || { stdout: '', stderr: `unknown pm2 verb ${verb}\\n`, exitCode: 2 }",
      'if (spec.stdout) process.stdout.write(spec.stdout)',
      'if (spec.stderr) process.stderr.write(spec.stderr)',
      "if (spec.removeCommand) fs.unlinkSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pm2.cmd'))",
      'process.exit(spec.exitCode ?? 0)',
      '',
    ].join('\n')}`,
  )

  writeUtf8(
    cmdPath,
    `@echo off\r\n"${process.execPath}" "%~dp0pm2-fake.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
  )

  return fixture
}

function readInvocations(logPath) {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function verbsOf(invocations) {
  return invocations.map((entry) => entry.verb)
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function runStartPm2(fixture) {
  const shell = requireSelectedShell()
  const env = { ...process.env }
  if (isWindowsPowershell(shell)) {
    delete env.PSModulePath
  }
  env.PM2_HOME = fixture.pm2Home
  env.USERPROFILE = fixture.userProfile
  env.HOME = fixture.userProfile
  env.TEMP = fixture.tempDir
  env.TMP = fixture.tempDir
  fs.mkdirSync(fixture.userProfile, { recursive: true })
  fs.mkdirSync(fixture.pm2Home, { recursive: true })
  fs.mkdirSync(fixture.tempDir, { recursive: true })

  const result = spawnSync(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      startScriptPath,
      '-RootDir',
      fixture.root,
    ],
    {
      cwd: fixture.root,
      env,
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  )

  if (result.error && result.error.code === 'ENOENT') {
    assert.fail(`selected shell is missing: ${shell}`)
  }
  assert.ifError(result.error)

  const invocations = readInvocations(fixture.logPath)
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: combinedOutput(result),
    invocations,
    verbs: verbsOf(invocations),
  }
}

function assertReady(run) {
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, readyPattern)
}

function assertFailedWithoutReady(run) {
  assert.notEqual(run.status, 0, run.output)
  assert.notEqual(run.status, null, 'startup script timed out')
  assert.doesNotMatch(run.output, readyPattern)
}

test(`${shellLabel}: Windows-only selected shell must exist`, () => {
  assert.equal(
    process.platform,
    'win32',
    'native-process PM2 startup tests require Windows',
  )
  assert.ok(
    selectedShell.resolved,
    selectedShell.error || `selected shell is missing: ${requestedShell}`,
  )
  assert.equal(
    fs.existsSync(selectedShell.resolved) || shellProbe(selectedShell.resolved),
    true,
    `selected shell is missing: ${requestedShell}`,
  )
})

test(`${shellLabel}: missing selected shell fails explicitly`, () => {
  assert.equal(
    process.platform,
    'win32',
    'native-process PM2 startup tests require Windows',
  )
  const missingName = 'onprem-pm2-missing-shell-grok-20261119.exe'
  const missing = resolveSelectedShell(missingName)
  assert.equal(missing.resolved, null)
  assert.equal(missing.error, `selected shell is missing: ${missingName}`)
})

test(`${shellLabel}: cold empty jlist plus native describe stderr exit 1 proceeds to start and save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t, {
    jlist: nativeOk('[]\n'),
    describe: nativeFailure('[PM2][WARN] metasheet-backend doesn\'t exist'),
  })
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'describe', 'start', 'save'])
  const start = run.invocations.find((entry) => entry.verb === 'start')
  assert.ok(start.args.includes('--update-env'))
  assert.ok(start.args.includes('--only'))
  assert.ok(start.args.includes('metasheet-backend'))
})

test(`${shellLabel}: stderr from jlist nonzero reaches describe fallback then start and save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t, {
    jlist: nativeFailure('[PM2][ERROR] daemon inspect failed'),
    describe: nativeFailure('[PM2][WARN] metasheet-backend doesn\'t exist'),
  })
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'describe', 'start', 'save'])
})

test(`${shellLabel}: a disappearing resolved PM2 command fails without a mutation`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t, {
    jlist: { ...nativeOk('[]\n'), removeCommand: true },
  })
  const run = runStartPm2(fixture)
  assertFailedWithoutReady(run)
  assert.deepEqual(run.verbs, ['jlist'])
  assert.equal(fs.existsSync(path.join(fixture.root, 'node_modules', '.bin', 'pm2.cmd')), false)
})

test(`${shellLabel}: start native nonzero with stderr fails and never emits ready or save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root, { pm_cwd: path.join(fixture.root, 'stale-cwd') }))}\n`),
    start: nativeFailure('[PM2][ERROR] start failed'),
  })
  const run = runStartPm2(fixture)
  assertFailedWithoutReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'delete', 'start'])
  assert.ok(!run.verbs.includes('save'))
})

test(`${shellLabel}: restart native nonzero with stderr fails and never emits ready or save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root))}\n`),
    restart: nativeFailure('[PM2][ERROR] restart failed'),
  })
  const run = runStartPm2(fixture)
  assertFailedWithoutReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'restart'])
  assert.ok(!run.verbs.includes('save'))
})

test(`${shellLabel}: delete native nonzero with stderr fails and never emits ready, start, or save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root, { pm_cwd: path.join(fixture.root, 'stale-cwd') }))}\n`),
    delete: nativeFailure('[PM2][ERROR] delete failed'),
  })
  const run = runStartPm2(fixture)
  assertFailedWithoutReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'delete'])
  assert.ok(!run.verbs.includes('start'))
  assert.ok(!run.verbs.includes('save'))
})

test(`${shellLabel}: save native nonzero with stderr fails after mutation and never emits ready`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root))}\n`),
    save: nativeFailure('[PM2][ERROR] save failed'),
  })
  const run = runStartPm2(fixture)
  assertFailedWithoutReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'restart', 'save'])
})

test(`${shellLabel}: valid script and cwd restarts then saves`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root))}\n`),
  })
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'restart', 'save'])
  const restart = run.invocations.find((entry) => entry.verb === 'restart')
  assert.ok(restart.args.includes('--update-env'))
  assert.ok(!run.verbs.includes('delete'))
  assert.ok(!run.verbs.includes('start'))
})

test(`${shellLabel}: stale cwd re-creates via delete then start and save`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root, { pm_cwd: path.join(fixture.root, 'stale-cwd') }))}\n`),
  })
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'delete', 'start', 'save'])
  assert.ok(!run.verbs.includes('restart'))
})

test(`${shellLabel}: retired sensitive keys absent from synthetic app.env force delete then start`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t)
  writeFakeConfig(fixture, {
    jlist: nativeOk(`${JSON.stringify(matchingApp(fixture.root, { [retiredSensitiveKeys[0]]: '1' }))}\n`),
  })
  const envText = fs.readFileSync(path.join(fixture.root, 'app.env'), 'utf8')
  for (const key of retiredSensitiveKeys) {
    assert.equal(envText.includes(key), false, 'synthetic app.env must not contain retired keys')
  }
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'delete', 'start', 'save'])
  assert.match(run.output, /deleting pm2 app definition for metasheet-backend to retire sensitive\/test-only env keys/)
  assert.ok(!run.verbs.includes('restart'))
})

test(`${shellLabel}: malformed jlist preserves existing sensitive retirement fallback`, { timeout: TEST_TIMEOUT_MS }, (t) => {
  const fixture = createFixture(t, {
    jlist: nativeOk('[{ this is not json'),
    describe: nativeOk(''),
  })
  const envText = fs.readFileSync(path.join(fixture.root, 'app.env'), 'utf8')
  for (const key of retiredSensitiveKeys) {
    assert.equal(envText.includes(key), false, 'synthetic app.env must not contain retired keys')
  }
  const run = runStartPm2(fixture)
  assertReady(run)
  assert.deepEqual(run.verbs, ['jlist', 'describe', 'delete', 'start', 'save'])
  assert.match(
    run.output,
    /pm2 jlist did not return metasheet-backend; deleting existing pm2 app definition to retire sensitive\/test-only env keys/,
  )
  assert.ok(!run.verbs.includes('restart'))
})
