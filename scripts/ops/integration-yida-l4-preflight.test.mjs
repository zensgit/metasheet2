// Tests for scripts/ops/integration-yida-l4-preflight.mjs.
//
// Behaviour: every case builds a throwaway deploy root under os.tmpdir() (removed again), replaces pm2
// with a node stub through the test-only --test-pm2-command flag, and points PM2_HOME (pm2's own
// variable, not a new flag) at a temp dir whose pm2.pid names a live or dead pid. Every CLI run is
// checked for leaks: no fixture secret, no 12-character slice of one, and no pm2/log text may reach
// stdout or stderr.
//
// Contracts: the script carries copies of backend sentinels (see the header of the script for why).
// The contract tests read the backend TypeScript source text and the docs, and turn red when a copy
// diverges. The #6691 sample-list check works both before (list absent) and after (list present) that
// PR merges; the post-merge shape is pinned by an embedded excerpt of the #6691 source.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as preflight from './integration-yida-l4-preflight.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-yida-l4-preflight.mjs')

const hex = n => randomBytes(n).toString('hex')
const KEY = `SynthKeyA${hex(20)}`
const SALT = `SynthSaltB${hex(20)}`
const JWT = `SynthJwtC${hex(20)}`
const DB_PASSWORD = `SynthDbPassD${hex(12)}`
const SHORT_KEY = `SkE${hex(6)}`
const PM2_NOISE = `Pm2NoiseMarker${hex(10)}`
const LOG_NOISE = `LogNoiseMarker${hex(10)}`
const SECRETS = [KEY, SALT, JWT, DB_PASSWORD, SHORT_KEY, PM2_NOISE, LOG_NOISE]
const CONTROL_TAB = String.fromCharCode(9)
const ESC = String.fromCharCode(27)

const PROBE_OK = `2026-11-02T01:00:00: info: Encrypted store probe: 4 encrypted value(s) across 9 store field(s); 0 undecryptable with the current material, 1 plaintext, 0 legacy v1 not checked; 0 store field(s) unreadable, 2 not present. {"service":"metasheet","note":"${LOG_NOISE}"}`
const PROBE_UNAVAILABLE = '2026-11-02T01:00:00: info: Encrypted store probe: 4 encrypted value(s) across 9 store field(s); not trial-decrypted (encryption material unavailable), 1 plaintext, 0 legacy v1 not checked; 0 store field(s) unreadable, 2 not present.'
const PROBE_UNDECRYPTABLE = '2026-11-02T01:00:00: info: Encrypted store probe: 4 encrypted value(s) across 9 store field(s); 2 undecryptable with the current material, 1 plaintext, 0 legacy v1 not checked; 0 store field(s) unreadable, 2 not present.'
const PROBE_UNREADABLE = '2026-11-02T01:00:00: info: Encrypted store probe: 4 encrypted value(s) across 9 store field(s); 0 undecryptable with the current material, 1 plaintext, 0 legacy v1 not checked; 3 store field(s) unreadable, 2 not present.'
const PROBE_COULD_NOT_RUN = '2026-11-02T01:05:00: warn: Encrypted store probe could not run; startup continues without it.'

function appEnvText({ key = KEY, salt = SALT, nodeEnv = 'production', extra = [] } = {}) {
  const lines = ['# synthetic fixture', `DATABASE_URL=postgres://synth:${DB_PASSWORD}@db.invalid:5432/synth`, `JWT_SECRET=${JWT}`]
  if (nodeEnv !== null) lines.push(`NODE_ENV=${nodeEnv}`)
  if (key !== null) lines.push(`ENCRYPTION_KEY=${key}`)
  if (salt !== null) lines.push(`ENCRYPTION_SALT=${salt}`)
  return [...lines, ...extra, ''].join('\r\n')
}

function backendApp({ env = {}, nested = {}, status = 'online', name = 'metasheet-backend', nodeArgs = [] } = {}) {
  const pm2Env = {
    status,
    NODE_ENV: 'production',
    ENCRYPTION_KEY: KEY,
    ENCRYPTION_SALT: SALT,
    JWT_SECRET: JWT,
    DATABASE_URL: `postgres://synth:${DB_PASSWORD}@db.invalid:5432/synth`,
    node_args: nodeArgs,
    ...env,
    env: { PM2_NOISE, ...nested },
  }
  for (const [k, v] of Object.entries(pm2Env)) if (v === undefined) delete pm2Env[k]
  return { name, pid: 4242, pm2_env: pm2Env }
}

const STUB_SOURCE = `import { readFileSync, writeFileSync } from 'node:fs'
const here = new URL('./', import.meta.url)
writeFileSync(new URL('ran', here), 'ran')
const spec = JSON.parse(readFileSync(new URL('spec.json', here), 'utf8'))
if (process.argv[2] !== 'jlist') { process.stderr.write('unexpected argv'); process.exit(9) }
if (spec.stderr) process.stderr.write(spec.stderr)
if (spec.stdout !== undefined) process.stdout.write(spec.stdout)
if (spec.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.sleepMs)
if (spec.throwMessage) throw new Error(spec.throwMessage)
process.exit(spec.exit ?? 0)
`

const DEAD_PID = 2147483000

/**
 * Builds a fixture under os.tmpdir(): <tmp>/root (deploy root), <tmp>/stub (pm2 stub), <tmp>/pm2home.
 * Defaults are the PASS shape; every option overrides one aspect.
 */
function makeFixture({
  appEnv = appEnvText(),
  rootAppEnv = false,
  log = `${LOG_NOISE} unrelated line\n${PROBE_OK}\n${LOG_NOISE} later line\n`,
  apps = [backendApp()],
  pm2 = null,
  daemon = 'alive',
} = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'ms2-yida-l4-preflight-'))
  const root = path.join(base, 'root')
  const stubDir = path.join(base, 'stub')
  const pm2Home = path.join(base, 'pm2home')
  mkdirSync(path.join(root, 'docker'), { recursive: true })
  mkdirSync(path.join(root, 'output', 'logs'), { recursive: true })
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(pm2Home, { recursive: true })
  if (appEnv === 'directory') mkdirSync(path.join(root, 'docker', 'app.env'))
  else if (appEnv !== null) writeFileSync(path.join(root, 'docker', 'app.env'), appEnv)
  if (rootAppEnv) writeFileSync(path.join(root, 'app.env'), appEnvText())
  const logFile = path.join(root, 'output', 'logs', 'metasheet-backend.out.log')
  if (log === 'directory') mkdirSync(logFile)
  else if (log !== null) writeFileSync(logFile, log)
  writeFileSync(path.join(stubDir, 'pm2-stub.mjs'), STUB_SOURCE)
  writeFileSync(path.join(stubDir, 'spec.json'), JSON.stringify(pm2 ?? { stdout: JSON.stringify(apps), stderr: PM2_NOISE }))
  if (daemon === 'alive') writeFileSync(path.join(pm2Home, 'pm2.pid'), String(process.pid))
  if (daemon === 'dead') writeFileSync(path.join(pm2Home, 'pm2.pid'), String(DEAD_PID))
  if (daemon === 'garbage') writeFileSync(path.join(pm2Home, 'pm2.pid'), 'not-a-pid')
  return {
    base, root, stub: path.join(stubDir, 'pm2-stub.mjs'), pm2Home,
    stubRan: () => existsSync(path.join(stubDir, 'ran')),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function assertNoLeak(text, label) {
  for (const secret of SECRETS) {
    for (let start = 0; start + 12 <= secret.length; start += 1) {
      const slice = secret.slice(start, start + 12)
      assert.ok(!text.includes(slice), `${label}: output contains part of a fixture secret`)
    }
  }
  for (const phrase of ['postgres://', 'store field(s);', 'unexpected argv', 'pm2_env', 'Error:', '    at ']) {
    assert.ok(!text.includes(phrase), `${label}: output contains raw pm2/log/error text`)
  }
}

const allOutputs = []

function runCli(fixture, args = ['--test-pm2-command', fixture.stub], extraEnv = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      PM2_HOME: fixture.pm2Home,
      ...extraEnv,
    },
  })
  const combined = `${result.stdout}\n${result.stderr}`
  assertNoLeak(combined, args.join(' '))
  allOutputs.push(combined)
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  return { ...result, lines, last: lines[lines.length - 1] ?? '', text: result.stdout }
}

function withFixture(options, body) {
  const fixture = makeFixture(options)
  try {
    return body(fixture)
  } finally {
    fixture.cleanup()
  }
}

function stopNames(run) {
  const match = /^L4_PREFLIGHT=STOP (.+)$/.exec(run.last)
  assert.ok(match, `expected a STOP verdict, got: ${run.last}`)
  return match[1].split(',')
}

function expectStop(options, mustInclude, { args, env } = {}) {
  return withFixture(options, fixture => {
    const run = runCli(fixture, args?.(fixture), env)
    assert.equal(run.status, 1, `exit code for ${mustInclude.join(',')}`)
    const names = stopNames(run)
    for (const name of mustInclude) assert.ok(names.includes(name), `STOP list must include ${name}; got ${names.join(',')}`)
    return { run, names, fixture }
  })
}

function expectPass(options, { env } = {}) {
  return withFixture(options, fixture => {
    const run = runCli(fixture, undefined, env)
    assert.equal(run.last, 'L4_PREFLIGHT=PASS', run.text)
    assert.equal(run.status, 0)
    return run
  })
}

// ── PASS shape ──────────────────────────────────────────────────────────────────────────────────

test('pass: every check true, verdict PASS, exit 0, backup reminder printed, stub ran', () => {
  withFixture({}, fixture => {
    const run = runCli(fixture)
    assert.equal(run.status, 0, run.text)
    assert.equal(run.last, 'L4_PREFLIGHT=PASS')
    assert.ok(fixture.stubRan())
    assert.deepEqual(run.lines, [
      'YIDA_L4_PREFLIGHT read-only; no value is ever printed',
      'pm2Source=test_stub pm2Status=ok',
      'backendInPm2=True backendOnline=True rootAppEnvExists=False',
      'appEnvFile=present',
      'ENCRYPTION_KEY: lines=1 set=True notDefault=True notPlaceholderOrSample=True noSurroundingWhitespaceOrControl=True sameInRunningBackend=True atLeast32=True',
      'ENCRYPTION_SALT: lines=1 set=True notDefault=True notPlaceholderOrSample=True noSurroundingWhitespaceOrControl=True sameInRunningBackend=True atLeast32=True',
      'ENCRYPTION_KEY_SALT: keyDiffersFromSalt=True',
      'NODE_ENV: lines=1 fileIsProduction=True runningIsProduction=True',
      'JWT_SECRET: setInRunningBackend=True notPublicFallback=True',
      'tlsOverridesInRunningBackend=False',
      'sendSwitchInRunningBackend=False',
      'INFO connectionTestSwitchInRunningBackend=off (information only, not a check)',
      'encryptedStoreProbe=ok undecryptable=0 unreadableStoreFields=0',
      'REMINDER backup (checklist section C: a full database dump plus a copy of docker\\app.env, kept together) is manual and NOT checked by this script.',
      'L4_PREFLIGHT=PASS',
    ])
  })
})

test('pass: UTF-8 BOM, quoted values, nested pm2 env and lenient pm2 prefix line are accepted', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  expectPass({ appEnv: Buffer.concat([bom, Buffer.from(appEnvText({ key: `"${KEY}"`, salt: `'${SALT}'`, nodeEnv: 'production' }))]) })
  expectPass({ apps: [backendApp({ env: { NODE_ENV: undefined, ENCRYPTION_KEY: undefined }, nested: { NODE_ENV: 'production', ENCRYPTION_KEY: KEY } })] })
  expectPass({ pm2: { stdout: `[PM2] noise ${PM2_NOISE}\n${JSON.stringify([backendApp()])}\n` } })
})

// ── pm2 / backend presence ──────────────────────────────────────────────────────────────────────

test('stop: backend not in pm2 (no metasheet-backend app, or a case variant of the name)', () => {
  const { names, run } = expectStop({ apps: [backendApp({ name: 'other-app' })] }, ['backendInPm2', 'backendOnline', 'ENCRYPTION_KEY.sameInRunningBackend', 'NODE_ENV.runningIsProduction', 'JWT_SECRET.setInRunningBackend', 'tlsOverridesInRunningBackend', 'sendSwitchInRunningBackend'])
  assert.ok(names.length > 5)
  assert.ok(run.lines.includes('INFO connectionTestSwitchInRunningBackend=unknown (information only, not a check)'))
  expectStop({ apps: [backendApp({ name: 'Metasheet-Backend' })] }, ['backendInPm2'])
  expectStop({ apps: [] }, ['backendInPm2'])
})

test('stop: backend registered but not online', () => {
  expectStop({ apps: [backendApp({ status: 'stopped' })] }, ['backendOnline'])
})

test('stop: no live pm2 daemon -> pm2 is never run (it would spawn a daemon)', () => {
  for (const daemon of ['none', 'dead', 'garbage']) {
    withFixture({ daemon }, fixture => {
      const run = runCli(fixture)
      assert.equal(run.status, 1)
      assert.ok(run.lines.includes('pm2Source=test_stub pm2Status=daemon_not_found'), daemon)
      assert.equal(fixture.stubRan(), false, `${daemon}: pm2 must not be executed`)
      assert.ok(stopNames(run).includes('backendInPm2'))
    })
  }
})

test('error paths: pm2 non-zero exit, thrown error, non-JSON output, wrong shape -> fixed category, no pm2 text', () => {
  const cases = [
    [{ stdout: JSON.stringify([backendApp()]), stderr: PM2_NOISE, exit: 3 }, 'exit_nonzero'],
    [{ throwMessage: `boom ${PM2_NOISE} ${KEY}` }, 'exit_nonzero'],
    [{ stdout: `not json ${PM2_NOISE} ${KEY}` }, 'output_not_json'],
    [{ stdout: '' }, 'output_not_json'],
    [{ stdout: JSON.stringify({ name: 'metasheet-backend', secret: KEY }) }, 'unexpected_shape'],
  ]
  for (const [spec, category] of cases) {
    withFixture({ pm2: spec }, fixture => {
      const run = runCli(fixture)
      assert.equal(run.status, 1, category)
      assert.ok(run.lines.includes(`pm2Source=test_stub pm2Status=${category}`), `${category}: ${run.lines[1]}`)
      assert.ok(stopNames(run).includes('backendInPm2'))
    })
  }
})

test('error path: pm2 command missing -> exit_nonzero category, no stack text', () => {
  withFixture({}, fixture => {
    const run = runCli(fixture, ['--test-pm2-command', path.join(fixture.base, 'no-such-stub.mjs')])
    assert.equal(run.status, 1)
    assert.ok(run.lines.includes('pm2Source=test_stub pm2Status=exit_nonzero'))
  })
})

test('error path: pm2 timeout -> timeout category (in-process, short timeout)', () => {
  withFixture({ pm2: { sleepMs: 5000, stdout: '[]' } }, fixture => {
    const result = preflight.readBackendFromPm2(fixture.root, { testStub: fixture.stub, env: { PM2_HOME: fixture.pm2Home }, timeoutMs: 300 })
    assert.deepEqual(result, { source: 'test_stub', status: 'timeout', app: null })
  })
})

test('pm2 invocation: local package entry runs under this node with no shell; .cmd only through a fixed cmd.exe line', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ms2-yida-l4-preflight-'))
  try {
    assert.deepEqual(preflight.resolvePm2Invocation(base, { platform: 'win32' }).args.slice(-1), ['"pm2 jlist"'])
    mkdirSync(path.join(base, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(path.join(base, 'node_modules', '.bin', 'pm2.cmd'), '@echo off')
    const viaCmd = preflight.resolvePm2Invocation(base, { platform: 'win32' })
    assert.equal(viaCmd.source, 'local')
    assert.equal(viaCmd.verbatim, true)
    assert.deepEqual(viaCmd.args, ['/d', '/s', '/c', '"node_modules\\.bin\\pm2.cmd jlist"'])
    mkdirSync(path.join(base, 'node_modules', 'pm2', 'bin'), { recursive: true })
    writeFileSync(path.join(base, 'node_modules', 'pm2', 'bin', 'pm2'), '')
    const viaNode = preflight.resolvePm2Invocation(base, { platform: 'win32' })
    assert.equal(viaNode.command, process.execPath)
    assert.equal(viaNode.verbatim, false)
    assert.deepEqual(viaNode.args, [path.join(base, 'node_modules', 'pm2', 'bin', 'pm2'), 'jlist'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// Real resolution, no stub flag: a fake local shim (node_modules/.bin/pm2[.cmd]) and a fake global pm2 on
// PATH. On Windows this goes through the fixed cmd.exe line, which Node 20 requires for a .cmd file.
function writeFakePm2(dir, apps) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'pm2-out.json'), JSON.stringify(apps))
  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'pm2.cmd'), '@echo off\r\nif not "%1"=="jlist" exit /b 9\r\ntype "%~dp0pm2-out.json"\r\n')
  } else {
    writeFileSync(path.join(dir, 'pm2'), '#!/bin/sh\n[ "$1" = jlist ] || exit 9\ncat "$(dirname "$0")/pm2-out.json"\n', { mode: 0o755 })
  }
}

test('real pm2 resolution: local node_modules/.bin shim (no stub flag)', () => {
  withFixture({}, fixture => {
    writeFakePm2(path.join(fixture.root, 'node_modules', '.bin'), [backendApp()])
    const run = runCli(fixture, [])
    assert.ok(run.lines.includes('pm2Source=local pm2Status=ok'), run.lines[1])
    assert.equal(run.last, 'L4_PREFLIGHT=PASS')
  })
})

test('real pm2 resolution: global pm2 on PATH (no stub flag)', () => {
  withFixture({}, fixture => {
    const bin = path.join(fixture.base, 'global-bin')
    writeFakePm2(bin, [backendApp()])
    const run = runCli(fixture, [], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` })
    assert.ok(run.lines.includes('pm2Source=global pm2Status=ok'), run.lines[1])
    assert.equal(run.last, 'L4_PREFLIGHT=PASS')
  })
})

test('real pm2 resolution: global pm2 absent and no live daemon -> pm2 never run', () => {
  withFixture({ daemon: 'none' }, fixture => {
    const run = runCli(fixture, [])
    assert.ok(run.lines.includes('pm2Source=global pm2Status=daemon_not_found'), run.lines[1])
    assert.equal(run.status, 1)
  })
})

test('pm2 home: mirrors pm2/paths.js getDefaultPM2Home', () => {
  assert.equal(preflight.resolvePm2Home({ PM2_HOME: path.resolve('/x/home') }), path.resolve('/x/home'))
  assert.equal(preflight.resolvePm2Home({ HOME: path.resolve('/h') }), path.resolve('/h', '.pm2'))
  assert.equal(preflight.resolvePm2Home({ HOMEDRIVE: '', HOMEPATH: path.resolve('/hp') }), path.resolve('', path.resolve('/hp'), '.pm2'))
  assert.equal(preflight.resolvePm2Home({}), path.resolve('/etc', '.pm2'))
})

// ── files ───────────────────────────────────────────────────────────────────────────────────────

test('stop: a root app.env exists (the package start scripts would read it instead)', () => {
  const { run } = expectStop({ rootAppEnv: true }, ['rootAppEnvExists'])
  assert.ok(run.lines.includes('backendInPm2=True backendOnline=True rootAppEnvExists=True'))
})

test('stop: docker\\app.env missing, unreadable, or UTF-16', () => {
  expectStop({ appEnv: null }, ['appEnvFile', 'ENCRYPTION_KEY.lines', 'NODE_ENV.lines'])
  expectStop({ appEnv: 'directory' }, ['appEnvFile'])
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(appEnvText(), 'utf16le')])
  const { run } = expectStop({ appEnv: utf16 }, ['appEnvFile'])
  assert.ok(run.lines.includes('appEnvFile=unsupported_encoding'))
})

// ── encryption material ─────────────────────────────────────────────────────────────────────────

for (const name of ['ENCRYPTION_KEY', 'ENCRYPTION_SALT']) {
  const isKey = name === 'ENCRYPTION_KEY'
  const fileWith = value => appEnvText(isKey ? { key: value } : { salt: value })
  const runningWith = value => [backendApp({ env: { [name]: value } })]
  const own = isKey ? preflight.DEFAULT_ENCRYPTION_KEY : preflight.DEFAULT_ENCRYPTION_SALT
  const other = isKey ? preflight.DEFAULT_ENCRYPTION_SALT : preflight.DEFAULT_ENCRYPTION_KEY

  test(`${name}: lines must be exactly one`, () => {
    const real = isKey ? KEY : SALT
    expectStop({ appEnv: appEnvText({ extra: [`${name}=${real}`] }) }, [`${name}.lines`])
    expectStop({ appEnv: fileWith(null) }, [`${name}.lines`, `${name}.set`, `${name}.sameInRunningBackend`])
  })

  test(`${name}: commented-out lines do not count`, () => {
    expectPass({ appEnv: appEnvText({ extra: [`# ${name}=old`, `   #${name}=older`] }) })
  })

  test(`${name}: must be set`, () => {
    expectStop({ appEnv: fileWith(''), apps: runningWith('') }, [`${name}.set`, `${name}.notDefault`, `${name}.sameInRunningBackend`])
    expectStop({ appEnv: fileWith('""'), apps: runningWith('') }, [`${name}.set`])
  })

  test(`${name}: built-in defaults (own, swapped, any case) stop`, () => {
    for (const value of [own, other, own.toUpperCase()]) {
      expectStop({ appEnv: fileWith(value), apps: runningWith(value) }, [`${name}.notDefault`])
    }
  })

  test(`${name}: placeholders and documented samples (any case) stop`, () => {
    const values = [...preflight.SAMPLE_ENCRYPTION_VALUES, '<put the key here>', preflight.SAMPLE_ENCRYPTION_VALUES[4].toUpperCase(), 'YOUR-SALT-HERE']
    for (const value of values) {
      expectStop({ appEnv: fileWith(value), apps: runningWith(value) }, [`${name}.notPlaceholderOrSample`])
    }
  })

  test(`${name}: surrounding whitespace or control characters stop (sealed byte for byte)`, () => {
    const real = isKey ? KEY : SALT
    expectStop({ appEnv: fileWith(`" ${real}"`), apps: runningWith(` ${real}`) }, [`${name}.noSurroundingWhitespaceOrControl`])
    expectStop({ appEnv: fileWith(`"${real}${CONTROL_TAB}"`), apps: runningWith(`${real}${CONTROL_TAB}`) }, [`${name}.noSurroundingWhitespaceOrControl`])
    expectStop({ appEnv: fileWith(`${real.slice(0, 10)}${CONTROL_TAB}${real.slice(10)}`), apps: runningWith(`${real.slice(0, 10)}${CONTROL_TAB}${real.slice(10)}`) }, [`${name}.noSurroundingWhitespaceOrControl`])
    const { names } = expectStop({ apps: runningWith(`${real}\r`) }, [`${name}.noSurroundingWhitespaceOrControl`, `${name}.sameInRunningBackend`])
    assert.ok(names.length >= 2)
  })

  test(`${name}: running backend must hold the same value`, () => {
    const real = isKey ? KEY : SALT
    expectStop({ apps: runningWith(`${real}x`) }, [`${name}.sameInRunningBackend`])
    expectStop({ apps: runningWith(real.toUpperCase()) }, [`${name}.sameInRunningBackend`])
    expectStop({ apps: runningWith(undefined) }, [`${name}.sameInRunningBackend`])
  })

  test(`${name}: shorter than 32 characters is a WARN, not a stop`, () => {
    const run = expectPass({ appEnv: fileWith(SHORT_KEY), apps: runningWith(SHORT_KEY) })
    const warn = run.lines.find(line => line.startsWith(`WARN ${name} `))
    assert.ok(warn, 'WARN line expected')
    assert.match(warn, /cannot be re-keyed later/)
    assert.ok(run.lines.some(line => line.startsWith(`${name}: `) && line.includes('atLeast32=False')))
  })
}

test('ENCRYPTION_KEY equal to ENCRYPTION_SALT stops', () => {
  expectStop({ appEnv: appEnvText({ salt: KEY }), apps: [backendApp({ env: { ENCRYPTION_SALT: KEY } })] }, ['ENCRYPTION_KEY_SALT.keyDiffersFromSalt'])
})

// ── NODE_ENV / JWT / TLS / switches ────────────────────────────────────────────────────────────

test('NODE_ENV: one line, file and running value exactly production (case-sensitive)', () => {
  expectStop({ appEnv: appEnvText({ nodeEnv: null }) }, ['NODE_ENV.lines', 'NODE_ENV.fileIsProduction'])
  expectStop({ appEnv: appEnvText({ extra: ['NODE_ENV=production'] }) }, ['NODE_ENV.lines'])
  expectStop({ appEnv: appEnvText({ nodeEnv: 'Production' }) }, ['NODE_ENV.fileIsProduction'])
  expectStop({ appEnv: appEnvText({ nodeEnv: 'prod' }) }, ['NODE_ENV.fileIsProduction'])
  expectStop({ apps: [backendApp({ env: { NODE_ENV: 'PRODUCTION' } })] }, ['NODE_ENV.runningIsProduction'])
  expectStop({ apps: [backendApp({ env: { NODE_ENV: 'development' } })] }, ['NODE_ENV.runningIsProduction'])
  expectStop({ apps: [backendApp({ env: { NODE_ENV: undefined } })] }, ['NODE_ENV.runningIsProduction'])
})

test('JWT_SECRET in the running backend: set and not the public fallback / a known placeholder', () => {
  expectStop({ apps: [backendApp({ env: { JWT_SECRET: undefined } })] }, ['JWT_SECRET.setInRunningBackend', 'JWT_SECRET.notPublicFallback'])
  expectStop({ apps: [backendApp({ env: { JWT_SECRET: '  ' } })] }, ['JWT_SECRET.setInRunningBackend'])
  expectStop({ apps: [backendApp({ env: { JWT_SECRET: preflight.DEV_FALLBACK_JWT_SECRET } })] }, ['JWT_SECRET.notPublicFallback'])
  expectStop({ apps: [backendApp({ env: { JWT_SECRET: 'change-me' } })] }, ['JWT_SECRET.notPublicFallback'])
})

test('tlsOverridesInRunningBackend: any TLS override variable or CA flag stops', () => {
  const stops = [
    { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    { nested: { NODE_TLS_REJECT_UNAUTHORIZED: '1' } },
    { env: { NODE_EXTRA_CA_CERTS: 'synthetic.pem' } },
    { env: { NODE_OPTIONS: '--max-old-space-size=4096 --use-system-ca' } },
    { env: { NODE_OPTIONS: '--USE-OPENSSL-CA' } },
    { nodeArgs: ['--use-openssl-ca'] },
    { nodeArgs: '--use-system-ca' },
  ]
  for (const options of stops) expectStop({ apps: [backendApp(options)] }, ['tlsOverridesInRunningBackend'])
  expectPass({ apps: [backendApp({ env: { NODE_OPTIONS: '--max-old-space-size=4096', NODE_EXTRA_CA_CERTS: '' } })] })
})

test('sendSwitchInRunningBackend: the send switch must be absent (any value, any place)', () => {
  for (const options of [{ env: { INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'true' } }, { env: { INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'false' } }, { nested: { INTEGRATION_YIDA_OWNER_SEND_ENABLED: '' } }, { env: { integration_yida_owner_send_enabled: '1' } }]) {
    const { run } = expectStop({ apps: [backendApp(options)] }, ['sendSwitchInRunningBackend'])
    assert.ok(run.lines.includes('sendSwitchInRunningBackend=True'))
  }
})

test('connection-test switch: information only (on / off), never a stop', () => {
  const on = expectPass({ apps: [backendApp({ env: { INTEGRATION_YIDA_CONNECTION_TEST_ENABLED: 'true' } })] })
  assert.ok(on.lines.includes('INFO connectionTestSwitchInRunningBackend=on (information only, not a check)'))
  const other = expectPass({ apps: [backendApp({ env: { INTEGRATION_YIDA_CONNECTION_TEST_ENABLED: 'TRUE' } })] })
  assert.ok(other.lines.includes('INFO connectionTestSwitchInRunningBackend=off (information only, not a check)'))
})

// ── encrypted store probe ───────────────────────────────────────────────────────────────────────

test('encrypted store probe: categories, and the last matching line wins', () => {
  const cases = [
    [`${PROBE_OK}\n${PROBE_UNAVAILABLE}\n`, 'material_unavailable', 'encryptedStoreProbe=material_unavailable unreadableStoreFields=0'],
    [`${PROBE_OK}\n${PROBE_UNDECRYPTABLE}\n`, 'undecryptable', 'encryptedStoreProbe=undecryptable undecryptable=2 unreadableStoreFields=0'],
    [`${PROBE_OK}\n${PROBE_COULD_NOT_RUN}\n`, 'could_not_run', 'encryptedStoreProbe=could_not_run'],
    [`${LOG_NOISE} nothing relevant\n`, 'missing', 'encryptedStoreProbe=missing'],
    ['', 'missing', 'encryptedStoreProbe=missing'],
    [null, 'log_missing', 'encryptedStoreProbe=log_missing'],
    ['directory', 'log_unreadable', 'encryptedStoreProbe=log_unreadable'],
    [`Encrypted store probe: 4 encrypted value(s) across 9 store field(s); some future wording ${LOG_NOISE}\n`, 'unrecognized', 'encryptedStoreProbe=unrecognized'],
  ]
  for (const [log, category, line] of cases) {
    const { run } = expectStop({ log }, ['encryptedStoreProbe'])
    assert.ok(run.lines.includes(line), `${category}: ${run.lines.find(l => l.startsWith('encryptedStoreProbe'))}`)
  }
  expectPass({ log: `${PROBE_UNDECRYPTABLE}\n${PROBE_OK}\n` })
  expectPass({ log: `${PROBE_OK}` })
  expectPass({ log: `${ESC}[32minfo${ESC}[39m: ${PROBE_OK.slice(PROBE_OK.indexOf('Encrypted'))}\r\n` })
})

test('encrypted store probe: unreadable store fields -> WARN but still PASS', () => {
  const run = expectPass({ log: `${PROBE_UNREADABLE}\n` })
  assert.ok(run.lines.includes('encryptedStoreProbe=ok undecryptable=0 unreadableStoreFields=3'))
  assert.ok(run.lines.some(line => line.startsWith('WARN the last encrypted store probe could not read')))
})

test('encrypted store probe: found across 1 MiB chunk boundaries in a large log', () => {
  const filler = `${'x'.repeat(200)}\n`.repeat(12_000)
  expectPass({ log: `${PROBE_UNDECRYPTABLE}\n${filler}${PROBE_OK}\n${filler}${filler}` })
  const { run } = expectStop({ log: `${PROBE_OK}\n${filler}${PROBE_UNDECRYPTABLE}\n${filler}` }, ['encryptedStoreProbe'])
  assert.ok(run.lines.includes('encryptedStoreProbe=undecryptable undecryptable=2 unreadableStoreFields=0'))
  const straddle = 'y'.repeat(1024 * 1024 - 40)
  expectPass({ log: `${straddle}\n${PROBE_OK}` })
})

// ── usage / internal error ──────────────────────────────────────────────────────────────────────

test('usage: unknown argument or missing flag value -> exit 2 and the argument is never echoed', () => {
  withFixture({}, fixture => {
    for (const args of [[KEY], ['--root', KEY], ['--test-pm2-command'], ['--test-pm2-command', '--x']]) {
      const run = runCli(fixture, args)
      assert.equal(run.status, 2, args.join(' '))
      assert.equal(run.stdout, '')
      assert.match(run.stderr, /^Usage: /)
    }
    const help = runCli(fixture, ['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /^Usage: /)
  })
})

test('internal error: an unexpected exception is a STOP, never a PASS', () => {
  withFixture({}, fixture => {
    const written = []
    let calls = 0
    const code = preflight.main(['--test-pm2-command', fixture.stub], {
      root: fixture.root,
      env: { PM2_HOME: fixture.pm2Home },
      write: text => {
        calls += 1
        if (calls === 2) throw new Error(`synthetic ${KEY}`)
        written.push(text)
      },
    })
    assert.equal(code, 1)
    assert.equal(written[written.length - 1], 'L4_PREFLIGHT=STOP internal_error\n')
    assertNoLeak(written.join(''), 'internal error')
  })
  const stub = { app: null, source: 'test_stub', status: 'ok' }
  assert.throws(() => preflight.evaluate({ appEnv: null, rootAppEnvExists: false, pm2: stub, probe: { category: 'ok' } }))
})

test('the script is spawnable from a deploy root path that contains spaces', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ms2-yida-l4-preflight- spaced '))
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--help'], { cwd: base, encoding: 'utf8' })
    assert.equal(result.status, 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('leak summary: no case printed any fixture secret, pm2 text or log text', () => {
  assert.ok(allOutputs.length > 60, `expected many CLI runs, got ${allOutputs.length}`)
  for (const [index, output] of allOutputs.entries()) assertNoLeak(output, `run ${index}`)
})

// ── read-only surface ───────────────────────────────────────────────────────────────────────────

const scriptSource = readFileSync(scriptPath, 'utf8')

test('read-only: no network module, no write API, no process control beyond signal 0', () => {
  const imports = [...scriptSource.matchAll(/^import .* from '([^']+)'$/gm)].map(match => match[1]).sort()
  assert.deepEqual(imports, ['node:child_process', 'node:fs', 'node:path', 'node:url'])
  for (const forbidden of [/\bfetch\s*\(/, /node:(?:http|https|net|dns|tls|dgram)\b/, /\bwriteFileSync\b|\bappendFileSync\b|\bwriteSync\b|\bmkdirSync\b|\brmSync\b|\bunlinkSync\b|\brenameSync\b|\bcreateWriteStream\b/, /\bexecSync\b|\bexecFile|(?<![.\w])exec\(|\bspawn\(|\bfork\(/, /shell:\s*true/]) {
    assert.ok(!forbidden.test(scriptSource), `forbidden pattern ${forbidden}`)
  }
  const kills = [...scriptSource.matchAll(/process\.kill\(([^)]*)\)/g)].map(match => match[1])
  assert.deepEqual(kills, ['pid, 0'])
  const fsImport = /^import \{([^}]*)\} from 'node:fs'$/m.exec(scriptSource)[1].split(',').map(s => s.trim()).sort()
  assert.deepEqual(fsImport, ['closeSync', 'existsSync', 'fstatSync', 'openSync', 'readFileSync', 'readSync'])
  assert.deepEqual([...scriptSource.matchAll(/openSync\(([^)]*)\)/g)].map(match => match[1]), ["file, 'r'"], 'files are opened read-only')
  assert.equal([...scriptSource.matchAll(/spawnSync\(/g)].length, 1)
})

test('values-free: every printed line comes from the fixed vocabulary', () => {
  const allowed = [
    /^YIDA_L4_PREFLIGHT read-only; no value is ever printed$/,
    /^pm2Source=[a-z_]+ pm2Status=[a-z_]+$/,
    /^backendInPm2=(True|False) backendOnline=(True|False) rootAppEnvExists=(True|False)$/,
    /^appEnvFile=[a-z_]+$/,
    /^ENCRYPTION_(KEY|SALT): lines=\d+ set=(True|False) notDefault=(True|False) notPlaceholderOrSample=(True|False) noSurroundingWhitespaceOrControl=(True|False) sameInRunningBackend=(True|False) atLeast32=(True|False)$/,
    /^ENCRYPTION_KEY_SALT: keyDiffersFromSalt=(True|False)$/,
    /^NODE_ENV: lines=\d+ fileIsProduction=(True|False) runningIsProduction=(True|False)$/,
    /^JWT_SECRET: setInRunningBackend=(True|False) notPublicFallback=(True|False)$/,
    /^tlsOverridesInRunningBackend=(True|False)$/,
    /^sendSwitchInRunningBackend=(True|False)$/,
    /^INFO connectionTestSwitchInRunningBackend=(on|off|unknown) \(information only, not a check\)$/,
    /^encryptedStoreProbe=[a-z_]+( undecryptable=\d+)?( unreadableStoreFields=\d+)?$/,
    /^WARN ENCRYPTION_(KEY|SALT) is shorter than 32 characters\. Not a stop, but the YiDa seal made at L4 cannot be re-keyed later\. Do not change the value yourself \(other stored secrets depend on it\); report to the owner\.$/,
    /^WARN the last encrypted store probe could not read some store fields; their values were not checked\. Report to the owner\.$/,
    /^REMINDER backup \(checklist section C: a full database dump plus a copy of docker\\app\.env, kept together\) is manual and NOT checked by this script\.$/,
    /^L4_PREFLIGHT=(PASS|STOP [A-Za-z0-9_.,]+)$/,
    /^Usage: |^$|^Run from the deploy root|^L4_PREFLIGHT=STOP <failing checks>/,
  ]
  let checked = 0
  for (const output of allOutputs) {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue
      checked += 1
      assert.ok(allowed.some(pattern => pattern.test(line)), 'a printed line is outside the fixed vocabulary')
    }
  }
  assert.ok(checked > 500)
})

// ── contracts: copies vs backend source and docs ────────────────────────────────────────────────

const readRepo = relative => readFileSync(path.join(repoRoot, relative), 'utf8')

function extractStringConst(source, name) {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(source)
  assert.ok(match, `${name} not found as a single-quoted export const`)
  return match[1]
}

function quotedStrings(block) {
  return [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(match => match[1])
}

function extractInsecureJwtValues(source) {
  const match = /const INSECURE_JWT_SECRET_VALUES = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(match, 'INSECURE_JWT_SECRET_VALUES not found')
  return quotedStrings(match[1])
}

/** Post-#6691: the backend's own sample list, or null while it is absent (pre-#6691). */
function extractBackendSampleList(source) {
  if (!source.includes('SAMPLE_ENCRYPTION_VALUES')) return null
  const match = /const SAMPLE_ENCRYPTION_VALUES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(match, 'SAMPLE_ENCRYPTION_VALUES exists but its Object.freeze([...]) shape changed; update this contract')
  return quotedStrings(match[1])
}

function assertSampleListCovers(scriptSamples, backendSamples) {
  if (backendSamples === null) return 'pre-6691'
  for (const value of backendSamples) {
    assert.ok(scriptSamples.includes(value.toLowerCase()), 'a backend sample value is missing from the operator-side list')
  }
  return 'covered'
}

/** Evaluates the backend's own probe summary template with synthetic totals. */
function renderProbeSummary(source, { decryptChecked, undecryptable, unreadable }) {
  const match = /logger\.info\(\s*(`Encrypted store probe: [\s\S]*?`)\s*,\s*\{/.exec(source)
  assert.ok(match, 'probe summary logger.info template not found')
  const totals = { encrypted: 4, undecryptable, plaintext: 1, legacyNotChecked: 0, unreadable, missing: 2 }
  const report = { decryptChecked, stores: new Array(9).fill({}) }
  // eslint-disable-next-line no-new-func
  return new Function('totals', 'report', `return ${match[1]}`)(totals, report)
}

const encryptedSecretsSource = readRepo('packages/core-backend/src/security/encrypted-secrets.ts')
const authRuntimeSource = readRepo('packages/core-backend/src/security/auth-runtime-config.ts')
const probeSource = readRepo('packages/core-backend/src/security/encrypted-store-probe.ts')
const indexSource = readRepo('packages/core-backend/src/index.ts')
const ecosystemSource = readRepo('ecosystem.config.cjs')
const yidaRuntimeSource = readRepo('packages/core-backend/src/integration/yida-initialization-runtime.ts')

test('contract: encryption defaults equal the backend constants (encrypted-secrets.ts)', () => {
  assert.equal(preflight.DEFAULT_ENCRYPTION_KEY, extractStringConst(encryptedSecretsSource, 'DEFAULT_ENCRYPTION_KEY'))
  assert.equal(preflight.DEFAULT_ENCRYPTION_SALT, extractStringConst(encryptedSecretsSource, 'DEFAULT_ENCRYPTION_SALT'))
  const mutated = encryptedSecretsSource.replace("'default-key-change-in-production'", "'default-key-changed'")
  assert.notEqual(mutated, encryptedSecretsSource)
  assert.notEqual(preflight.DEFAULT_ENCRYPTION_KEY, extractStringConst(mutated, 'DEFAULT_ENCRYPTION_KEY'))
})

test('contract: JWT fallback and placeholder set equal auth-runtime-config.ts; production is the exact string', () => {
  assert.equal(preflight.DEV_FALLBACK_JWT_SECRET, extractStringConst(authRuntimeSource, 'DEV_FALLBACK_JWT_SECRET'))
  assert.deepEqual([...preflight.INSECURE_JWT_SECRET_VALUES].sort(), extractInsecureJwtValues(authRuntimeSource).sort())
  assert.ok(authRuntimeSource.includes("return normalizeEnvString(env.NODE_ENV) === 'production'"), 'isProductionRuntime changed; re-check NODE_ENV rules')
})

test('contract: probe log phrases parse the line the backend actually renders (encrypted-store-probe.ts)', () => {
  assert.ok(probeSource.includes(`'${preflight.PROBE_COULD_NOT_RUN_PHRASE}; startup continues without it.'`))
  const ok = renderProbeSummary(probeSource, { decryptChecked: true, undecryptable: 0, unreadable: 0 })
  assert.deepEqual(preflight.classifyProbeLine(`info: ${ok}`), { category: 'ok', undecryptable: 0, unreadable: 0 })
  const bad = renderProbeSummary(probeSource, { decryptChecked: true, undecryptable: 3, unreadable: 1 })
  assert.deepEqual(preflight.classifyProbeLine(bad), { category: 'undecryptable', undecryptable: 3, unreadable: 1 })
  const unavailable = renderProbeSummary(probeSource, { decryptChecked: false, undecryptable: 0, unreadable: 0 })
  assert.deepEqual(preflight.classifyProbeLine(unavailable), { category: 'material_unavailable', undecryptable: null, unreadable: 0 })
  assert.equal(PROBE_OK.includes(ok), true, 'the fixture line must be the rendered backend line')
  const reworded = probeSource.replace('undecryptable with the current material', 'cannot be decrypted now')
  assert.equal(preflight.classifyProbeLine(renderProbeSummary(reworded, { decryptChecked: true, undecryptable: 0, unreadable: 0 })).category, 'unrecognized')
})

test('contract: switch names are the ones the backend reads (index.ts)', () => {
  assert.ok(indexSource.includes(`readEnablement: () => process.env.${preflight.SEND_SWITCH_FLAG},`))
  assert.ok(indexSource.includes(`readEnablement: () => process.env.${preflight.CONNECTION_TEST_SWITCH_FLAG},`))
})

test('contract: pm2 app name and out log path match ecosystem.config.cjs', () => {
  assert.ok(ecosystemSource.includes(`name: '${preflight.BACKEND_APP_NAME}',`))
  assert.ok(ecosystemSource.includes(`out_file: '${preflight.BACKEND_OUT_LOG_RELATIVE_PARTS.join('/')}',`))
})

test('contract: every documented sample value is still printed by the doc it is tied to', () => {
  for (const entry of preflight.SAMPLE_ENCRYPTION_VALUE_SOURCES) {
    assert.equal(entry.value, entry.value.toLowerCase())
    assert.ok(entry.docs.length > 0)
    for (const doc of entry.docs) {
      assert.ok(readRepo(doc).toLowerCase().includes(entry.value), `${doc} no longer prints a sample value tied to it`)
    }
  }
})

// Excerpt of packages/core-backend/src/integration/yida-initialization-runtime.ts on the #6691 head.
const PR6691_EXCERPT = `const SAMPLE_ENCRYPTION_VALUES: readonly string[] = Object.freeze(['<openssl rand -hex 32>',
  '<openssl rand -hex 32, generated separately>', 'your-32-byte-key-here', 'your-salt-here',
  'abcdef0123456789abcdef0123456789', '0123456789abcdef0123456789abcdef'])
const sealValue = (value: unknown) => typeof value === 'string' ? value.trim() : ''`

test('contract: the operator-side sample list covers the backend list before and after #6691', () => {
  const state = assertSampleListCovers(preflight.SAMPLE_ENCRYPTION_VALUES, extractBackendSampleList(yidaRuntimeSource))
  assert.ok(['pre-6691', 'covered'].includes(state))
  assert.equal(assertSampleListCovers(preflight.SAMPLE_ENCRYPTION_VALUES, extractBackendSampleList(PR6691_EXCERPT)), 'covered')
  const widened = PR6691_EXCERPT.replace("'your-salt-here',", "'your-salt-here', 'a-new-sample',")
  assert.throws(() => assertSampleListCovers(preflight.SAMPLE_ENCRYPTION_VALUES, extractBackendSampleList(widened)))
  assert.throws(() => extractBackendSampleList('const SAMPLE_ENCRYPTION_VALUES = new Set([])'))
})

test('wiring: shipped by the package build, required by the package verify, runnable via package.json and CI', () => {
  const rel = 'scripts/ops/integration-yida-l4-preflight.mjs'
  const build = readRepo('scripts/ops/multitable-onprem-package-build.sh').replace(/\r/g, '')
  const buildPaths = [...build.match(/\nREQUIRED_PATHS=\(\n([\s\S]*?)\n\)/)[1].matchAll(/^  "([^"]+)"$/gm)].map(match => match[1])
  assert.ok(buildPaths.includes(rel), 'package build REQUIRED_PATHS must list the preflight')
  const verify = readRepo('scripts/ops/multitable-onprem-package-verify.sh').replace(/\r/g, '')
  const required = [...verify.match(/\nrequired=\(\n([\s\S]*?)\n\)/)[1].matchAll(/^  "([^"]+)"$/gm)].map(match => match[1])
  assert.ok(required.includes(rel), 'package verify required list must list the preflight')
  const scripts = JSON.parse(readRepo('package.json')).scripts
  assert.equal(scripts['verify:integration-yida:l4-preflight'], 'node --test scripts/ops/integration-yida-l4-preflight.test.mjs')
  const workflow = readRepo('.github/workflows/integration-yida-l4-preflight.yml')
  assert.equal(workflow.split('node --test --test-reporter=tap scripts/ops/integration-yida-l4-preflight.test.mjs').length - 1, 2, 'both CI jobs run this suite')
})

test('contract: the script rejects everything the backend L4 seal check would reject (rules mirror #6691)', () => {
  for (const value of extractBackendSampleList(PR6691_EXCERPT)) assert.ok(preflight.isPlaceholderOrSample(value.toUpperCase()))
  assert.ok(preflight.isPlaceholderOrSample('<anything at all>'))
  assert.ok(preflight.isBuiltInDefault(preflight.DEFAULT_ENCRYPTION_SALT))
  assert.ok(preflight.isBuiltInDefault(preflight.DEFAULT_ENCRYPTION_KEY))
  assert.equal(preflight.isPlaceholderOrSample(KEY), false)
})

