// Values-free acceptance for scripts/ops/02-pm2-owner-check.ps1 and 03-live-env-check.ps1.
// Proves three hosting outcomes without printing a path, account, PID, command line or env value:
//   (a) a live God named by pm2.pid still reaches status=complete and real process= words
//   (b) a live owned pm2-runtime + MetaSheet-PM2 host does too, with no pm2.pid
//   (c) when nothing safe is listening, both stay incomplete and the pm2 shim is never started
// The shim is the stand-in for pm2. If the scripts run it, it appends argv= to a log. It does not
// spawn a daemon. CiProbe replaces only the Windows process table, task and pipe; the hosting
// decision itself is the production function.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const opsDir = path.join(repoRoot, 'scripts/ops')
const libPath = path.join(opsDir, 'onprem-live-env-lib.ps1')
const ownerPath = path.join(opsDir, '02-pm2-owner-check.ps1')
const livePath = path.join(opsDir, '03-live-env-check.ps1')
const PWSH = process.env.ONPREM_LIVEENV_TEST_SHELL || 'pwsh'
const ME = 'DEMO\\op'
const PID_GOD = 424242
const PID_RUNTIME = 424242
const PID_APP = 515151
const PID_STRAY = 777001
const LEAKS = ['CMDLINE_SHOULD_NOT_PRINT', 'PATH_SENTINEL_VALUE', 'synthetic-exists-value', 'postgres://synthetic.example/app', 'liveenv-home-secret', 'DEMO\\op', 'DEMO/op', String(PID_GOD), String(PID_APP), String(PID_STRAY)]

function psSingleQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, (ch) => ch + ch)}'`
}

function childEnv(env = {}) {
  const merged = { ...process.env, ...env }
  if (!Object.prototype.hasOwnProperty.call(env, 'PM2_HOME')) delete merged.PM2_HOME
  return merged
}

function runPwsh(command, env = {}) {
  const result = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: childEnv(env),
    timeout: 60_000,
  })
  return result
}

function runFile(scriptPath, args, env = {}) {
  const result = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
    encoding: 'utf8',
    env: childEnv(env),
    timeout: 60_000,
  })
  return result
}

function assertNoLeaks(text, label) {
  for (const leak of LEAKS) {
    assert.equal(text.includes(leak), false, `${label} printed ${leak}`)
  }
}

function line(stdout, prefix) {
  const found = stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith(prefix))
  assert.equal(found.length, 1, `expected one ${prefix} line in:\n${stdout}`)
  return found[0]
}

function resultLine(stdout, prefix) {
  const lines = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  assert.ok(lines.length > 0, 'no output')
  assert.ok(lines[lines.length - 1].startsWith(prefix), `last line was ${lines[lines.length - 1]}`)
  return lines[lines.length - 1]
}

function writeShim(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    '#!/bin/sh',
    'log="$LIVEENV_TEST_LOG"',
    '{',
    '  echo "argv=$*"',
    '  if [ -n "$PM2_HOME" ]; then echo "home_set=true"; else echo "home_set=false"; fi',
    '  if [ -n "$LIVEENV_EXPECT_HOME" ]; then',
    '    if [ "$PM2_HOME" = "$LIVEENV_EXPECT_HOME" ]; then echo "home_match=true"; else echo "home_match=false"; fi',
    '  fi',
    '} >> "$log"',
    'printf \'%s\' "$LIVEENV_JLIST_STDOUT"',
    'exit 0',
    '',
  ].join('\n'))
  fs.chmodSync(filePath, 0o755)
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function initHome(home, { godPid = null, appPid = null, initialized = false } = {}) {
  fs.mkdirSync(home, { recursive: true })
  if (initialized) {
    for (const dir of ['logs', 'pids', 'modules']) fs.mkdirSync(path.join(home, dir), { recursive: true })
    fs.writeFileSync(path.join(home, 'module_conf.json'), '{}\n')
  } else {
    fs.mkdirSync(path.join(home, 'pids'), { recursive: true })
  }
  if (godPid != null) fs.writeFileSync(path.join(home, 'pm2.pid'), `${godPid}\n`)
  if (appPid != null) fs.writeFileSync(path.join(home, 'pids', 'metasheet-backend-0.pid'), `${appPid}\n`)
}

function writeProbe(filePath, probe) {
  fs.writeFileSync(filePath, JSON.stringify(probe))
}

function processRow({ processId, parentProcessId, commandLine, owner = ME, name = 'node.exe' }) {
  return { processId, parentProcessId, name, commandLine, owner }
}

function runtimeProbe(extra = {}) {
  return {
    currentUser: ME,
    pipe: 'present',
    processes: [
      processRow({
        processId: PID_RUNTIME,
        parentProcessId: 4,
        commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT binaries/Runtime4Docker.js',
      }),
      processRow({
        processId: PID_APP,
        parentProcessId: PID_RUNTIME,
        commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT index.js',
      }),
    ],
    tasks: [{ taskName: 'MetaSheet-PM2', state: 'Running', userId: ME }],
    ...extra,
  }
}

function godProbe() {
  return {
    currentUser: ME,
    pipe: 'present',
    processes: [
      processRow({
        processId: PID_GOD,
        parentProcessId: 4,
        commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT pm2/lib/Daemon.js',
      }),
      processRow({
        processId: PID_APP,
        parentProcessId: PID_GOD,
        commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT index.js',
      }),
    ],
    tasks: [],
  }
}

const jlistApp = {
  name: 'metasheet-backend',
  pm2_env: {
    PATH: 'PATH_SENTINEL_VALUE',
    SECURITY_ACTION_PROOF_ENABLED: 'true',
    RBAC_BYPASS: 'TRUE',
    TASKS_ENABLED: '',
    TASKS_SCHEDULER_ENABLED: false,
    NODE_ENV: 'production',
    MULTITABLE_EMAIL_TRANSPORT: 'mock',
    INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'synthetic-exists-value',
    INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED: 'false',
    DATABASE_URL: 'postgres://synthetic.example/app',
    env: { SECURITY_ACTION_PROOF_ENABLED: 'true' },
  },
}

function writeInstall(root) {
  fs.mkdirSync(path.join(root, 'docker'), { recursive: true })
  const env = 'DATABASE_URL=postgres://synthetic.example/app\nSECURITY_ACTION_PROOF_ENABLED=false\n'
  fs.writeFileSync(path.join(root, 'docker', 'app.env'), env)
  fs.writeFileSync(path.join(root, 'app.env'), env)
  writeShim(path.join(root, 'node_modules', '.bin', 'pm2.cmd'))
}

function keyLine(stdout, key) {
  return line(stdout, `LIVEENV key=${key} `)
}

test('source is ASCII and the jlist gate names the pipe before any pm2 command', () => {
  for (const filePath of [libPath, ownerPath, livePath]) {
    const source = fs.readFileSync(filePath)
    assert.ok(source.every((byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)), path.basename(filePath))
  }
  const live = fs.readFileSync(livePath, 'utf8')
  const lib = fs.readFileSync(libPath, 'utf8')
  assert.match(lib, /JavaScriptSerializer/)
  assert.match(lib, /rpc\.sock/)
  assert.doesNotMatch(live, /pm2 (start|resurrect|kill|save)\b/)
  assert.ok(lib.indexOf('RunJlist') < lib.indexOf("Arguments = '/d /s /c"))
})

test('dot-sourcing defines the decision and does not run a check', () => {
  const owner = runPwsh(`. ${psSingleQuote(ownerPath)}; if (Get-Command Resolve-LiveEnvHosting -ErrorAction SilentlyContinue) { 'loaded' }`)
  assert.equal(owner.status, 0, owner.stderr)
  assert.match(owner.stdout, /loaded/)
  assert.doesNotMatch(owner.stdout, /PM2OWNER_RESULT/)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'liveenv-home-secret-dot-'))
  try {
    const live = runPwsh(`. ${psSingleQuote(livePath)} -InstallRoot ${psSingleQuote(scratch)}; 'loaded'`)
    assert.equal(live.status, 0, live.stderr)
    assert.match(live.stdout, /loaded/)
    assert.doesNotMatch(live.stdout, /LIVEENV_RESULT/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

function decide(facts) {
  const pairs = Object.entries(facts).map(([key, value]) => {
    if (typeof value === 'boolean') return `${key}=$${value ? 'true' : 'false'}`
    if (typeof value === 'number') return `${key}=${value}`
    return `${key}=${psSingleQuote(value)}`
  })
  const command = [
    `. ${psSingleQuote(libPath)}`,
    `$facts = [pscustomobject]@{ ${pairs.join('; ')} }`,
    `$decision = Resolve-LiveEnvHosting -Facts $facts`,
    `Write-Output ($decision.Hosting + '|' + $decision.RunJlist + '|' + $decision.Owned + '|' + $decision.Reason + '|' + $decision.OwnerStatus + '|' + $decision.OwnerReason)`,
  ].join('; ')
  const result = runPwsh(command)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const lineText = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  const [hosting, runJlist, owned, reason, ownerStatus, ownerReason] = lineText.split('|')
  return { hosting, runJlist: runJlist === 'True', owned: owned === 'True', reason, ownerStatus, ownerReason }
}

function runtimeFacts(overrides = {}) {
  return {
    HomeSet: false,
    HomeExists: true,
    HomeInitialized: true,
    DaemonPidFile: false,
    DaemonAlive: false,
    DaemonClass: 'none',
    DaemonOwner: 'false',
    AppPidFile: true,
    AppAlive: true,
    AppOwner: 'true',
    AppParentIsRuntime: true,
    RuntimeTask: 'present',
    RuntimeTaskState: 'running',
    RuntimeTaskOwner: 'true',
    RuntimeProcessCount: 1,
    RuntimeProcessOwner: 'true',
    StrayGod: 'false',
    Pipe: 'present',
    OtherUserPm2: 'false',
    ProcessQuery: 'ok',
    ...overrides,
  }
}

function godFacts(overrides = {}) {
  return {
    HomeSet: true,
    HomeExists: true,
    HomeInitialized: false,
    DaemonPidFile: true,
    DaemonAlive: true,
    DaemonClass: 'god',
    DaemonOwner: 'true',
    AppPidFile: true,
    AppAlive: true,
    AppOwner: 'true',
    AppParentIsRuntime: false,
    RuntimeTask: 'absent',
    RuntimeTaskState: 'none',
    RuntimeTaskOwner: 'none',
    RuntimeProcessCount: 0,
    RuntimeProcessOwner: 'none',
    StrayGod: 'false',
    Pipe: 'present',
    OtherUserPm2: 'false',
    ProcessQuery: 'ok',
    ...overrides,
  }
}

test('hosting decision: a live non-God pid does not hide pm2-runtime and does not run jlist by itself', () => {
  const hidden = decide(runtimeFacts({
    DaemonPidFile: true,
    DaemonAlive: true,
    DaemonClass: 'other',
    DaemonOwner: 'true',
  }))
  assert.equal(hidden.hosting, 'pm2-runtime')
  assert.equal(hidden.runJlist, true)
  assert.equal(hidden.owned, true)
  const alone = decide(godFacts({
    DaemonClass: 'other',
    AppAlive: false,
    AppPidFile: false,
    AppOwner: 'false',
    RuntimeTask: 'absent',
    RuntimeProcessCount: 0,
    RuntimeProcessOwner: 'none',
  }))
  assert.notEqual(alone.hosting, 'god')
  assert.equal(alone.runJlist, false)
  assert.equal(alone.owned, false)
  const realGodWithoutApp = decide(godFacts({ AppAlive: false, AppPidFile: false, AppOwner: 'false' }))
  assert.notEqual(realGodWithoutApp.hosting, 'god')
  assert.equal(realGodWithoutApp.runJlist, false)
  assert.equal(realGodWithoutApp.reason, 'app_not_under_god')
})

test('hosting decision: God with a live pid and a present pipe may jlist; a missing pipe may not', () => {
  const ready = decide(godFacts())
  assert.deepEqual(ready, { hosting: 'god', runJlist: true, owned: true, reason: '', ownerStatus: 'complete', ownerReason: '' })
  const noPipe = decide(godFacts({ Pipe: 'absent' }))
  assert.equal(noPipe.runJlist, false)
  assert.equal(noPipe.reason, 'no_daemon')
  const other = decide(godFacts({ DaemonOwner: 'false' }))
  assert.equal(other.runJlist, false)
  assert.equal(other.reason, 'daemon_not_owned')
  assert.equal(other.ownerStatus, 'complete')
})

test('hosting decision: owned pm2-runtime may jlist; each unsafe gap refuses and does not jlist', () => {
  const ready = decide(runtimeFacts())
  assert.deepEqual(ready, { hosting: 'pm2-runtime', runJlist: true, owned: true, reason: '', ownerStatus: 'complete', ownerReason: '' })
  const readyState = decide(runtimeFacts({ RuntimeTaskState: 'ready' }))
  assert.equal(readyState.runJlist, true)
  const cases = [
    ['pipe absent', { Pipe: 'absent' }, 'no_daemon'],
    ['pipe unknown', { Pipe: 'unknown' }, 'pipe_unknown'],
    ['stray god', { StrayGod: 'true' }, 'stray_daemon'],
    ['two tasks', { RuntimeTask: 'ambiguous' }, 'host_ambiguous'],
    ['task not running', { RuntimeTaskState: 'other' }, 'task_not_running'],
    ['app parent is not the runtime', { AppParentIsRuntime: false }, 'app_not_under_runtime'],
    ['home not initialized', { HomeInitialized: false }, 'pm2_home_not_initialized'],
    ['no task and no runtime', { RuntimeTask: 'absent', RuntimeProcessCount: 0, RuntimeProcessOwner: 'none', AppAlive: false, AppParentIsRuntime: false, Pipe: 'absent' }, 'no_daemon'],
  ]
  for (const [label, overrides, reason] of cases) {
    const decision = decide(runtimeFacts(overrides))
    assert.equal(decision.runJlist, false, label)
    assert.equal(decision.owned, false, label)
    assert.equal(decision.reason, reason, label)
  }
  const empty = decide(runtimeFacts({
    Pipe: 'absent',
    RuntimeTask: 'absent',
    RuntimeTaskState: 'none',
    RuntimeTaskOwner: 'none',
    RuntimeProcessCount: 0,
    RuntimeProcessOwner: 'none',
    AppAlive: false,
    AppPidFile: false,
    AppParentIsRuntime: false,
    HomeExists: false,
    HomeInitialized: false,
  }))
  assert.equal(empty.reason, 'no_daemon')
  assert.equal(empty.ownerReason, 'no_pm2_process')
})

function scenario(name, build) {
  test(name, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'liveenv-home-secret-'))
    try {
      build(scratch)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
}

function baseEnv(scratch, { pm2Home = '', expectHome = '', jlist = [jlistApp] } = {}) {
  const env = {
    LIVEENV_TEST_LOG: path.join(scratch, 'pm2-shim.log'),
    LIVEENV_JLIST_STDOUT: JSON.stringify(jlist),
    USERPROFILE: path.join(scratch, 'profile'),
  }
  if (pm2Home) env.PM2_HOME = pm2Home
  else delete env.PM2_HOME
  if (expectHome) env.LIVEENV_EXPECT_HOME = expectHome
  fs.mkdirSync(env.USERPROFILE, { recursive: true })
  return env
}

scenario('(a) God + pm2.pid: status=complete, real process words, jlist runs once', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2')
  const root = path.join(scratch, 'install')
  initHome(home, { godPid: PID_GOD, appPid: PID_APP, initialized: false })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), godProbe())
  const env = baseEnv(scratch, { pm2Home: home, expectHome: '' })
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(owner.status, 0, owner.stderr)
  assert.match(line(owner.stdout, 'PM2OWNER_PROBE'), /ci=true/)
  assert.match(line(owner.stdout, 'PM2OWNER hosting='), /hosting=god/)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_alive='), /daemon_alive=true/)
  assert.equal(resultLine(owner.stdout, 'PM2OWNER_RESULT'), 'PM2OWNER_RESULT owned=true status=complete')
  assertNoLeaks(owner.stdout, '02 god')

  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=god/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /read=ok/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /app_matches=1/)
  assert.match(keyLine(live.stdout, 'SECURITY_ACTION_PROOF_ENABLED'), /process=literal-true/)
  assert.match(keyLine(live.stdout, 'SECURITY_ACTION_PROOF_ENABLED'), /pdup=same/)
  assert.match(keyLine(live.stdout, 'RBAC_BYPASS'), /process=loose-true/)
  assert.match(keyLine(live.stdout, 'TASKS_ENABLED'), /process=empty/)
  assert.match(keyLine(live.stdout, 'TASKS_SCHEDULER_ENABLED'), /process=exists/)
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=literal-production/)
  assert.match(keyLine(live.stdout, 'MULTITABLE_EMAIL_TRANSPORT'), /process=literal-mock/)
  assert.match(keyLine(live.stdout, 'INTEGRATION_YIDA_OWNER_SEND_ENABLED'), /process=exists/)
  assert.match(keyLine(live.stdout, 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'), /process=exists/)
  assert.match(keyLine(live.stdout, 'STOCK_PREP_PULL_BATCH_ENABLED'), /process=absent/)
  assert.match(line(live.stdout, 'LIVEENV_DBURL_PROCESS'), /process=same/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=27 status=complete')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG).filter((item) => item.startsWith('argv=')), ['argv=jlist'])
  assertNoLeaks(live.stdout, '03 god')
})

scenario('(b) pm2-runtime + MetaSheet-PM2, no pm2.pid: status=complete and the child PM2_HOME is the runtime home', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  assert.equal(fs.existsSync(path.join(home, 'pm2.pid')), false)
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), runtimeProbe())
  const env = baseEnv(scratch, { expectHome: home })
  assert.equal(env.PM2_HOME, undefined)
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(owner.status, 0, owner.stderr + owner.stdout)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_pid_file='), /daemon_pid_file=false/)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_alive='), /daemon_alive=false/)
  assert.match(line(owner.stdout, 'PM2OWNER hosting='), /hosting=pm2-runtime/)
  assert.match(line(owner.stdout, 'PM2OWNER runtime_task='), /runtime_task=present/)
  assert.match(line(owner.stdout, 'PM2OWNER runtime_task_state='), /runtime_task_state=running/)
  assert.match(line(owner.stdout, 'PM2OWNER rpc_pipe='), /rpc_pipe=present/)
  assert.equal(resultLine(owner.stdout, 'PM2OWNER_RESULT'), 'PM2OWNER_RESULT owned=true status=complete')
  assertNoLeaks(owner.stdout, '02 runtime')

  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'SECURITY_ACTION_PROOF_ENABLED,RBAC_BYPASS'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /daemon_alive=false/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=pm2-runtime/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /read=ok/)
  assert.match(keyLine(live.stdout, 'SECURITY_ACTION_PROOF_ENABLED'), /process=literal-true/)
  assert.match(keyLine(live.stdout, 'RBAC_BYPASS'), /process=loose-true/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=2 status=complete')
  const log = readLog(env.LIVEENV_TEST_LOG)
  assert.deepEqual(log.filter((item) => item.startsWith('argv=')), ['argv=jlist'])
  assert.ok(log.includes('home_set=true'), log.join('\n'))
  assert.ok(log.includes('home_match=true'), log.join('\n'))
  assertNoLeaks(live.stdout, '03 runtime')
})

scenario('(b) a Ready MetaSheet-PM2 task is still the live runtime host', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  writeInstall(root)
  const probe = runtimeProbe()
  probe.tasks[0].state = 'Ready'
  writeProbe(path.join(scratch, 'probe.json'), probe)
  const env = baseEnv(scratch, { expectHome: home })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=literal-production/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=complete')
})

scenario('(b) a stale pm2.pid that names no live process does not hide the runtime host', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { godPid: 1, appPid: PID_APP, initialized: true })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), runtimeProbe())
  const env = baseEnv(scratch, { pm2Home: home })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /daemon_alive=false/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=pm2-runtime/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=complete')
})

scenario('a live non-God pm2.pid does not classify as god and still accepts pm2-runtime', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { godPid: PID_STRAY, appPid: PID_APP, initialized: true })
  writeInstall(root)
  const probe = runtimeProbe()
  probe.processes.push(processRow({
    processId: PID_STRAY,
    parentProcessId: 4,
    commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT worker.js',
  }))
  writeProbe(path.join(scratch, 'probe.json'), probe)
  const env = baseEnv(scratch, { pm2Home: home })
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(owner.status, 0, owner.stderr + owner.stdout)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_alive='), /daemon_alive=true/)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_class='), /daemon_class=other/)
  assert.match(line(owner.stdout, 'PM2OWNER hosting='), /hosting=pm2-runtime/)
  assert.equal(resultLine(owner.stdout, 'PM2OWNER_RESULT'), 'PM2OWNER_RESULT owned=true status=complete')
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /daemon_class=other/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=pm2-runtime/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /read=ok/)
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG).filter((item) => item.startsWith('argv=')), ['argv=jlist'])
  assertNoLeaks(owner.stdout + live.stdout, 'non-god pid')
})

scenario('a live non-God pm2.pid with no runtime host does not run jlist', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2')
  const root = path.join(scratch, 'install')
  initHome(home, { godPid: PID_STRAY, initialized: true })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), {
    currentUser: ME,
    pipe: 'present',
    processes: [processRow({
      processId: PID_STRAY,
      parentProcessId: 4,
      commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT worker.js',
    })],
    tasks: [],
  })
  const env = baseEnv(scratch, { pm2Home: home })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 2, live.stdout)
  assert.doesNotMatch(line(live.stdout, 'LIVEENV_PM2'), /hosting=god/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /read=skipped/)
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=unknown/)
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
  assertNoLeaks(live.stdout, 'non-god alone')
})

scenario('PM2_HOME unset keeps a confirmed .pm2 tree when .pm2-runtime also exists', (scratch) => {
  const profile = path.join(scratch, 'profile')
  const dotPm2 = path.join(profile, '.pm2')
  const runtime = path.join(profile, '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(dotPm2, { appPid: PID_APP, initialized: true })
  fs.writeFileSync(path.join(dotPm2, 'dump.pm2'), '{}\n')
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(runtime, 'pm2.pid'), `${PID_STRAY}\n`)
  writeInstall(root)
  const probe = runtimeProbe()
  probe.processes.push(processRow({
    processId: PID_STRAY,
    parentProcessId: 4,
    commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT worker.js',
  }))
  writeProbe(path.join(scratch, 'probe.json'), probe)
  const env = baseEnv(scratch, { expectHome: dotPm2 })
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(owner.status, 0, owner.stderr + owner.stdout)
  assert.match(line(owner.stdout, 'PM2OWNER pm2_home_set='), /pm2_home_set=false/)
  assert.match(line(owner.stdout, 'PM2OWNER daemon_pid_file='), /daemon_pid_file=false/)
  assert.match(line(owner.stdout, 'PM2OWNER hosting='), /hosting=pm2-runtime/)
  assert.equal(resultLine(owner.stdout, 'PM2OWNER_RESULT'), 'PM2OWNER_RESULT owned=true status=complete')
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=pm2-runtime/)
  const log = readLog(env.LIVEENV_TEST_LOG)
  assert.deepEqual(log.filter((item) => item.startsWith('argv=')), ['argv=jlist'])
  assert.ok(log.includes('home_match=true'), log.join('\n'))
  assertNoLeaks(owner.stdout + live.stdout, 'both homes')
})

scenario('an empty default .pm2 directory still allows the .pm2-runtime home', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  fs.mkdirSync(path.join(scratch, 'profile', '.pm2'), { recursive: true })
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), runtimeProbe())
  const env = baseEnv(scratch, { expectHome: home })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 0, live.stderr + live.stdout)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /hosting=pm2-runtime/)
  assert.ok(readLog(env.LIVEENV_TEST_LOG).includes('home_match=true'))
})

scenario('(c) no listener: official 03 is no_daemon and the shim is not started', (scratch) => {
  const root = path.join(scratch, 'install')
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), { currentUser: ME, pipe: 'absent', processes: [], tasks: [] })
  const env = baseEnv(scratch)
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.equal(owner.status, 0, owner.stderr)
  assert.equal(resultLine(owner.stdout, 'PM2OWNER_RESULT'), 'PM2OWNER_RESULT owned=false status=incomplete reason=no_pm2_process')
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 2, live.stdout)
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=unknown/)
  assert.match(line(live.stdout, 'LIVEENV_PM2'), /read=skipped/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=incomplete reason=no_daemon')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
  assertNoLeaks(live.stdout, '03 empty')
})

scenario('(c) real mode with no Windows host does not start the shim', (scratch) => {
  const root = path.join(scratch, 'install')
  writeInstall(root)
  const env = baseEnv(scratch)
  delete env.PM2_HOME
  const live = runFile(livePath, ['-InstallRoot', root, '-Keys', 'NODE_ENV'], env)
  assert.notEqual(live.status, 0, live.stdout)
  assert.match(resultLine(live.stdout, 'LIVEENV_RESULT'), /status=incomplete reason=/)
  assert.doesNotMatch(live.stdout, /LIVEENV_PROBE/)
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
  assertNoLeaks(live.stdout, '03 real')
})

scenario('(c) a runtime-shaped host with the pipe absent does not start pm2', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), runtimeProbe({ pipe: 'absent' }))
  const env = baseEnv(scratch)
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 2, live.stdout)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=incomplete reason=no_daemon')
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=unknown/)
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
})

scenario('a stray Daemon.js beside pm2-runtime is not accepted and pm2 is not started', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  writeInstall(root)
  const probe = runtimeProbe()
  probe.processes.push(processRow({
    processId: PID_STRAY,
    parentProcessId: 4,
    commandLine: 'node.exe CMDLINE_SHOULD_NOT_PRINT pm2/lib/Daemon.js',
  }))
  writeProbe(path.join(scratch, 'probe.json'), probe)
  const env = baseEnv(scratch)
  const owner = runFile(ownerPath, ['-CiProbe', path.join(scratch, 'probe.json')], env)
  assert.match(resultLine(owner.stdout, 'PM2OWNER_RESULT'), /owned=false status=incomplete reason=stray_daemon/)
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=incomplete reason=stray_daemon')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
  assertNoLeaks(owner.stdout + live.stdout, 'stray')
})

scenario('two MetaSheet-PM2 tasks are ambiguous and pm2 is not started', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2-runtime')
  const root = path.join(scratch, 'install')
  initHome(home, { appPid: PID_APP, initialized: true })
  writeInstall(root)
  const probe = runtimeProbe()
  probe.tasks.push({ taskName: 'MetaSheet-PM2', state: 'Running', userId: ME })
  writeProbe(path.join(scratch, 'probe.json'), probe)
  const env = baseEnv(scratch)
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=incomplete reason=host_ambiguous')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
})

scenario('an explicit PM2_HOME that is not the runtime home is not silently switched', (scratch) => {
  const runtime = path.join(scratch, 'profile', '.pm2-runtime')
  const wrong = path.join(scratch, 'wrong-home')
  const root = path.join(scratch, 'install')
  initHome(runtime, { appPid: PID_APP, initialized: true })
  fs.mkdirSync(wrong, { recursive: true })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), runtimeProbe())
  const env = baseEnv(scratch, { pm2Home: wrong })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 2, live.stdout)
  assert.notEqual(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=complete')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG), [])
  assertNoLeaks(live.stdout, 'wrong home')
})

scenario('jlist that is safe to run but has no PATH is env_not_visible, never absent', (scratch) => {
  const home = path.join(scratch, 'profile', '.pm2')
  const root = path.join(scratch, 'install')
  initHome(home, { godPid: PID_GOD, appPid: PID_APP })
  writeInstall(root)
  writeProbe(path.join(scratch, 'probe.json'), godProbe())
  const env = baseEnv(scratch, {
    pm2Home: home,
    jlist: [{ name: 'metasheet-backend', pm2_env: { NODE_ENV: 'production' } }],
  })
  const live = runFile(livePath, ['-InstallRoot', root, '-CiProbe', path.join(scratch, 'probe.json'), '-Keys', 'NODE_ENV'], env)
  assert.equal(live.status, 2, live.stdout)
  assert.match(keyLine(live.stdout, 'NODE_ENV'), /process=unknown/)
  assert.equal(resultLine(live.stdout, 'LIVEENV_RESULT'), 'LIVEENV_RESULT keys=1 status=incomplete reason=env_not_visible')
  assert.deepEqual(readLog(env.LIVEENV_TEST_LOG).filter((item) => item.startsWith('argv=')), ['argv=jlist'])
})

test('PowerShell 7 refuses a jlist that contains both Path and PATH instead of dropping one', () => {
  const command = [
    `. ${psSingleQuote(libPath)}`,
    `$text = '[{"name":"metasheet-backend","pm2_env":{"Path":"a","PATH":"b"}}]'`,
    `$parsed = ConvertFrom-LiveEnvJlistText -Text $text`,
    `if ($null -eq $parsed) { 'null' } else { 'parsed' }`,
  ].join('; ')
  const result = runPwsh(command)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /null/)
})
