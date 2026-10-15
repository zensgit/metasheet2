import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertNoEnvironmentFiles, capture, childFailureDiagnostic, cleanEnvironment, CONFIG, DEADLINE_MS, fileHash, main, MAX_OUTPUT,
  parseChildFailureFrame, parsePublicArguments, parseWorkerFailureReceipt, reportOuterResult,
  reportStartupFailure, startupFailureDiagnostic, TEST_FILES, validateTaskReceipt } from './run-stock-preparation-yida-browser-ci.mjs'
import { assertOwnedScratch, assertPlainOwnedTree, SCRATCH_OWNER } from './lib/stock-preparation-plm-owned-pg.mjs'

// Synthetic contracts only: never spawn PG, Chromium, namespaces or a socket.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/ops/lib')
const native = createRequire(import.meta.url)(path.join(lib, 'stock-preparation-browser-network-isolation.cjs'))
const clone = value => JSON.parse(JSON.stringify(value))
function validSnapshot() {
  return {
    parentNetworkNamespace: 'net:[101]', networkNamespace: 'net:[102]', initNetworkNamespace: 'net:[102]',
    pidNamespace: 'pid:[103]', initPidNamespace: 'pid:[103]', initExecutableMatches: true, initStartTime: '123',
    uid: 1000, gid: 1000, uidMap: [1000, 1000, 1], gidMap: [1000, 1000, 1], selfPid: 2,
    capabilities: Array(5).fill('0000000000000000'),
    links: [{ ifname: 'lo', link_type: 'loopback', flags: ['LOOPBACK', 'UP'] }],
    addresses: [{ name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true }],
    routes4: [{ dev: 'lo', dst: '127.0.0.0/8', type: 'local' }], routes6: [],
  }
}
function validReceipt() {
  return { files: [...TEST_FILES].sort(), counts: { files: 5, tests: 70, passed: 70, failed: 0, skipped: 0,
    sentinels: 5, retries: 0, repeats: 0, unhandled: 0, missingRetryFields: 0 },
  policy: { pool: 'forks', config: CONFIG, retry: 0, repeat: 0, watch: false,
    filtered: false, setupFiles: 0, globalSetup: 0 } }
}

test('ambient DB, PG, preload, credentials and production flags cannot enter child environment', () => {
  const env = cleanEnvironment({ PATH: 'poisoned-executable-path', HOME: root, TMPDIR: path.join(root, 'tmp'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'tmp/cache'), DATABASE_URL: 'synthetic-secret',
    PGHOST: 'synthetic-secret', PGPASSWORD: 'synthetic-secret', NODE_OPTIONS: '--require attacker',
    NODE_PG_FORCE_NATIVE: '1', JWT_SECRET: 'synthetic-secret', YIDA_OWNER_RUNTIME_ENABLED: 'true',
    PLM_AUTOPERSIST_ENABLED: 'true', YIDA_BROWSER_CI_OWNER: 'forged' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR', 'TZ'].sort())
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(JSON.stringify(env).includes('synthetic-secret'), false)
  assert.equal(cleanEnvironment({ HOME: 'relative', TMPDIR: 'bad\0path', PLAYWRIGHT_BROWSERS_PATH: '0' }).HOME, undefined)
})

test('public entry accepts only one PG binary directory and no arbitrary command or test selector', () => {
  assert.deepEqual(parsePublicArguments(['--pg-bin', root]), { pgBin: root })
  for (const args of [[], ['--pg-bin', 'relative'], ['--command', root], ['--pg-bin', root, '--retry', '1'],
    ['--pg-bin', root, '--testNamePattern', 'sentinel'], ['--worker', root], ['--pg-bin', root + '\0']]) {
    assert.throws(() => parsePublicArguments(args), /YIDA_BROWSER_CI_ARGUMENTS_INVALID/u)
  }
})

test('startup diagnostic accepts only private reason tags and fixed stage labels', () => {
  let failure
  try { parsePublicArguments(['--command', 'synthetic-private-path']) } catch (error) { failure = error }
  const diagnostic = startupFailureDiagnostic(failure, 'ARGUMENTS')
  assert.deepEqual(diagnostic, { stage: 'ARGUMENTS', reason: 'ARGUMENTS_INVALID' })
  assert.equal(Object.isFrozen(diagnostic), true)
  assert.deepEqual(startupFailureDiagnostic(failure, 'synthetic-private-stage'),
    { stage: 'RUNTIME', reason: 'ARGUMENTS_INVALID' })
  // Text and public properties cannot forge a private launcher tag.
  for (const error of [new Error('YIDA_BROWSER_CI_ENVIRONMENT_FILE_PRESENT'),
    { code: 'ENVIRONMENT_FILE_PRESENT', reason: 'PATH_INVALID', message: 'synthetic-secret' },
    'synthetic-secret', null, undefined]) {
    assert.deepEqual(startupFailureDiagnostic(error, 'ENVIRONMENT_FILES'),
      { stage: 'ENVIRONMENT_FILES', reason: 'INTERNAL' })
  }
})

test('startup diagnostic never reads hostile error properties, getters or proxy traps', () => {
  let reads = 0, tagged
  const hostileGetter = () => { reads++; throw new Error('synthetic-secret-getter') }
  try { parsePublicArguments([]) } catch (error) { tagged = error }
  // Replace V8's lazy stack before poisoning message, so test setup itself does
  // not invoke Error's default stack formatter.
  for (const property of ['stack', 'message', 'code', 'reason', 'stage', 'toJSON', 'toString']) {
    Object.defineProperty(tagged, property, { configurable: true, get: hostileGetter })
  }
  const forged = Object.create(null)
  for (const property of ['message', 'stack', 'code', 'reason', 'stage', 'toJSON', 'toString']) {
    Object.defineProperty(forged, property, { get: hostileGetter })
  }
  const proxy = new Proxy(forged, { get: hostileGetter, ownKeys: hostileGetter,
    getOwnPropertyDescriptor: hostileGetter, getPrototypeOf: hostileGetter })
  assert.deepEqual(startupFailureDiagnostic(tagged, 'ARGUMENTS'),
    { stage: 'ARGUMENTS', reason: 'ARGUMENTS_INVALID' })
  assert.deepEqual(startupFailureDiagnostic(proxy, proxy), { stage: 'RUNTIME', reason: 'INTERNAL' })
  const previousExitCode = process.exitCode, lines = []
  try {
    reportStartupFailure(tagged, 'ARGUMENTS', line => { lines.push(line) })
    reportStartupFailure(proxy, proxy, line => { lines.push(line) })
    assert.deepEqual(lines, ['YIDA_BROWSER_CI_FAILED',
      'YIDA_BROWSER_CI_STARTUP_FAILED {"stage":"ARGUMENTS","reason":"ARGUMENTS_INVALID"}',
      'YIDA_BROWSER_CI_FAILED', 'YIDA_BROWSER_CI_STARTUP_FAILED {"stage":"RUNTIME","reason":"INTERNAL"}'])
  } finally { process.exitCode = previousExitCode }
  assert.equal(reads, 0)
})

test('unexpected startup OS and assertion failures retain generic marker and exit one with INTERNAL', () => {
  const previousExitCode = process.exitCode
  try {
    let assertion
    try { assert.equal('synthetic-secret-actual', 'synthetic-private-expected') } catch (error) { assertion = error }
    const osError = new Error('synthetic-private-path synthetic-secret')
    osError.code = 'synthetic-private-code'
    for (const error of [osError, assertion]) {
      const lines = []
      reportStartupFailure(error, 'PATHS', line => { lines.push(line) })
      assert.equal(process.exitCode, 1)
      assert.deepEqual(lines, ['YIDA_BROWSER_CI_FAILED',
        'YIDA_BROWSER_CI_STARTUP_FAILED {"stage":"PATHS","reason":"INTERNAL"}'])
    }
  } finally { process.exitCode = previousExitCode }
})

test('real main startup catch records safe stage and preserves rejection without running launch work', async () => {
  const previousUmask = process.umask, previousExitCode = process.exitCode
  let reads = 0
  const hostile = new Proxy({}, { get: () => { reads++; throw new Error('synthetic-secret') } })
  const lines = []
  try {
    // Fail at the first OS operation, before filesystem, namespace or PG work.
    process.umask = () => { throw hostile }
    let failure
    try { await main([]) } catch (error) { failure = error }
    assert.equal(failure, hostile)
    reportStartupFailure(failure, undefined, line => { lines.push(line) })
    assert.equal(process.exitCode, 1)
    assert.equal(reads, 0)
    assert.deepEqual(lines, ['YIDA_BROWSER_CI_FAILED',
      'YIDA_BROWSER_CI_STARTUP_FAILED {"stage":"RUNTIME","reason":"INTERNAL"}'])
  } finally {
    process.umask = previousUmask; process.exitCode = previousExitCode
  }
})

test('implicit Vite env files are refused by filename without reading their values', async () => {
  const sandbox = path.join(root, 'tmp', 'yida-browser-contract-' + randomUUID())
  await fs.mkdir(sandbox, { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(path.join(sandbox, '.env.example'), 'example only')
    assertNoEnvironmentFiles([sandbox])
    for (const name of ['.env', '.env.local', '.env.test', '.env.test.local']) {
      await fs.writeFile(path.join(sandbox, name), 'synthetic-unused-value', { mode: 0o000 })
      assert.throws(() => assertNoEnvironmentFiles([sandbox]), error => {
        assert.match(error.message, /YIDA_BROWSER_CI_ENVIRONMENT_FILE_PRESENT/u)
        assert.deepEqual(startupFailureDiagnostic(error, 'ENVIRONMENT_FILES'),
          { stage: 'ENVIRONMENT_FILES', reason: 'ENVIRONMENT_FILE_PRESENT' })
        const previousExitCode = process.exitCode, lines = []
        try {
          reportStartupFailure(error, 'ENVIRONMENT_FILES', line => { lines.push(line) })
          assert.equal(process.exitCode, 1)
          assert.deepEqual(lines, ['YIDA_BROWSER_CI_FAILED',
            'YIDA_BROWSER_CI_STARTUP_FAILED {"stage":"ENVIRONMENT_FILES","reason":"ENVIRONMENT_FILE_PRESENT"}'])
        } finally { process.exitCode = previousExitCode }
        return true
      })
    }
  } finally {
    assert.equal(path.dirname(sandbox), path.join(root, 'tmp'))
    assert.match(path.basename(sandbox), /^yida-browser-contract-[a-f0-9-]{36}$/u)
    await fs.rm(sandbox, { recursive: true, force: false })
  }
})

test('whole-five-file receipt preserves 65 business tests plus five sentinels', () => {
  assert.equal(validateTaskReceipt(validReceipt()), true)
  for (const key of ['files', 'tests', 'passed', 'sentinels']) {
    const receipt = validReceipt(); receipt.counts[key]--
    assert.throws(() => validateTaskReceipt(receipt))
  }
  for (const key of ['failed', 'skipped', 'retries', 'repeats', 'unhandled', 'missingRetryFields']) {
    const receipt = validReceipt(); receipt.counts[key]++
    assert.throws(() => validateTaskReceipt(receipt))
  }
  const receipt = validReceipt(); receipt.files[0] = 'tests/synthetic-standin.test.ts'
  assert.throws(() => validateTaskReceipt(receipt))
})

test('test filters, retries, shared workers and broad setup cannot produce a valid receipt', () => {
  for (const [key, value] of [['pool', 'threads'], ['config', 'vitest.integration.config.ts'], ['retry', 1],
    ['repeat', 1], ['watch', true], ['filtered', true], ['setupFiles', 1], ['globalSetup', 1]]) {
    const receipt = validReceipt(); receipt.policy[key] = value
    assert.throws(() => validateTaskReceipt(receipt))
  }
})

test('native snapshot contract rejects missing namespace, wrong PID1, root identity and each capability', () => {
  assert.equal(native.validateSnapshot(validSnapshot()), true)
  for (const change of [snapshot => { snapshot.networkNamespace = snapshot.parentNetworkNamespace },
    snapshot => { snapshot.initPidNamespace = 'pid:[999]' }, snapshot => { snapshot.initExecutableMatches = false },
    snapshot => { snapshot.initStartTime = '' }, snapshot => { snapshot.uid = 0 },
    snapshot => { snapshot.uidMap = [0, 1000, 1] }, snapshot => { snapshot.gidMap = [1000, 1000, 2] }]) {
    const snapshot = validSnapshot(); change(snapshot)
    assert.throws(() => native.validateSnapshot(snapshot), /PLM_BROWSER_ISOLATION_REQUIRED/u)
  }
  for (let index = 0; index < 5; index++) {
    const snapshot = validSnapshot(); snapshot.capabilities[index] = '0000000000000001'
    assert.throws(() => native.validateSnapshot(snapshot), /PLM_BROWSER_ISOLATION_REQUIRED/u)
  }
  // A synthetic valid snapshot never installs the module's private capability.
  assert.throws(() => native.assertBrowserNetworkIsolation(), /PLM_BROWSER_ISOLATION_REQUIRED/u)
})

test('native boundary rejects a second interface, external address, route or gateway', () => {
  for (const change of [snapshot => { snapshot.links.push({ ifname: 'eth0' }) },
    snapshot => { snapshot.addresses[0].address = '192.0.2.1' },
    snapshot => { snapshot.routes4[0].dst = 'default' }, snapshot => { snapshot.routes4[0].gateway = '127.0.0.1' },
    snapshot => { snapshot.routes6.push({ dev: 'lo', dst: '2001:db8::/32' }) },
    snapshot => { snapshot.routes4[0].nexthops = [] }]) {
    const snapshot = validSnapshot(); change(snapshot)
    assert.throws(() => native.validateSnapshot(snapshot), /PLM_BROWSER_ISOLATION_REQUIRED/u)
  }
})

test('copied native and owned-PG modules retain approved bytes', async () => {
  for (const [file, expected] of [
    ['stock-preparation-browser-network-isolation.cjs', 'cf364bfed3960af8e5c387a4c5d7aa882ce1d558c84f937e6b5816ae5927980c'],
    ['stock-preparation-plm-owned-pg.mjs', '37b430df4a9edc093d1f8839aeacd90d376088539e19f4a8916d01d501164677'],
  ]) assert.equal(createHash('sha256').update(await fs.readFile(path.join(lib, file))).digest('hex'), expected)
})

test('only the independently resolved Vitest dependency can have hardlinks while hashing', async () => {
  const cli = createRequire(path.join(root, 'packages/core-backend/package.json')).resolve('vitest/vitest.mjs')
  assert.equal(fileHash(cli), createHash('sha256').update(await fs.readFile(cli)).digest('hex'))
  const sandbox = path.join(root, 'tmp', 'yida-browser-contract-' + randomUUID())
  await fs.mkdir(sandbox, { recursive: true, mode: 0o700 })
  const source = path.join(sandbox, 'source.cjs'), alias = path.join(sandbox, 'source-alias.cjs')
  try {
    await fs.writeFile(source, '// synthetic source', { mode: 0o600 })
    assert.equal(fileHash(source), createHash('sha256').update(await fs.readFile(source)).digest('hex'))
    await fs.link(source, alias)
    assert.equal((await fs.lstat(source)).nlink, 2)
    assert.throws(() => fileHash(source), /YIDA_BROWSER_CI_PATH_INVALID/u)
    assert.throws(() => fileHash(alias), /YIDA_BROWSER_CI_PATH_INVALID/u)
  } finally {
    assert.equal(path.dirname(sandbox), path.join(root, 'tmp'))
    assert.match(path.basename(sandbox), /^yida-browser-contract-[a-f0-9-]{36}$/u)
    await fs.rm(sandbox, { recursive: true, force: false })
  }
})

test('original browser fixture still invokes the real native assertion before actual Chromium launch', async () => {
  const fixture = await fs.readFile(path.join(root, 'packages/core-backend/tests/utils/stock-preparation-yida-owner-browser-fixture.ts'), 'utf8')
  assert.match(fixture, /stock-preparation-browser-network-isolation\.cjs/u)
  assert(fixture.indexOf('nativeIsolation.assertBrowserNetworkIsolation()') < fixture.indexOf('browser = await chromium.launch('))
  const preloadSource = await fs.readFile(path.join(lib, 'stock-preparation-yida-browser-ci-preload.cjs'), 'utf8')
  assert.match(preloadSource, /const native = require\(owner.native\)/u)
  assert.match(preloadSource, /native.installBrowserNetworkIsolation\(owner.parentNetworkNamespace\)/u)
  assert.match(preloadSource, /\/proc\/1\/cmdline/u)
})

test('owned scratch rejects a forged marker and foreign cleanup tree before any PG process exists', async () => {
  const sandbox = path.join(root, 'tmp', 'yida-browser-contract-' + randomUUID())
  await fs.mkdir(path.join(sandbox, 'tmp'), { recursive: true, mode: 0o700 })
  const nonce = randomUUID(), scratch = path.join(sandbox, 'tmp', 'stock-preparation-plm-full-app-' + nonce)
  await fs.mkdir(scratch, { mode: 0o700 })
  const marker = { owner: SCRATCH_OWNER, nonce, repoRoot: sandbox, pid: process.pid }
  const markerPath = path.join(scratch, 'owner.json')
  try {
    await fs.writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 })
    assert.equal((await assertOwnedScratch({ repoRoot: sandbox, scratchDir: scratch })).scratchDir, scratch)
    await assertPlainOwnedTree(scratch)
    for (const change of [value => { value.pid++ }, value => { value.nonce = randomUUID() },
      value => { value.owner = 'FOREIGN' }, value => { value.repoRoot = root }]) {
      const value = clone(marker); change(value)
      await fs.writeFile(markerPath, JSON.stringify(value))
      await assert.rejects(assertOwnedScratch({ repoRoot: sandbox, scratchDir: scratch }), /PLM_FULL_APP_PG_OWNER_INVALID/u)
    }
    await assert.rejects(assertOwnedScratch({ repoRoot: sandbox, scratchDir: path.join(sandbox, 'tmp') }), /PLM_FULL_APP_PG_OWNER_INVALID/u)
  } finally {
    assert.equal(path.dirname(sandbox), path.join(root, 'tmp'))
    assert.match(path.basename(sandbox), /^yida-browser-contract-[a-f0-9-]{36}$/u)
    await fs.rm(sandbox, { recursive: true, force: false })
  }
})

test('finite output and total deadline remain bounded', () => {
  assert.equal(MAX_OUTPUT, 32 * 1024 * 1024)
  assert.equal(DEADLINE_MS, 15 * 60 * 1000)
})

const sha = raw => createHash('sha256').update(raw).digest('hex')
const unshareDenied = 'unshare: unshare failed: Operation not permitted\n'
const uidMapDenied = 'unshare: write failed /proc/self/uid_map: Operation not permitted\n'
const gidMapDenied = 'unshare: write failed /proc/self/gid_map: Operation not permitted\n'
const bootstrapFrame = stage => Buffer.from('YIDA_BROWSER_CI_BOOTSTRAP_STAGE ' +
  JSON.stringify({ stage, reason: 'BOOTSTRAP_FAILED' }) + '\nYIDA_BROWSER_CI_BOOTSTRAP_FAILED\n')
function diagnosticOwner() {
  return { hashes: Object.fromEntries(['stock-preparation-browser-network-isolation.cjs',
    'stock-preparation-plm-owned-pg.mjs'].map(name => [path.join(lib, name), fileHash(path.join(lib, name))])) }
}
function failedWorkerReceipt(ownerSha, sourceSha, failureStage = 'PG_START') {
  return { protocol: 'YIDA_BROWSER_CI_NATIVE_V1', ownerSha, sourceSha, passed: false,
    cleanup: 'not-started', tests: 0, sentinels: 0, business: 0, isolatedNetwork: true,
    unixIpcIsolated: false, sameProcessHostileCodeIsolated: false, filesystemIsolated: false, failureStage }
}
async function syntheticChild(fn, { stdout = '', stderr = '', code = 1, script,
  executable = process.execPath, args } = {}) {
  const sandbox = path.join(root, 'tmp', 'yida-browser-contract-' + randomUUID())
  await fs.mkdir(sandbox, { recursive: true, mode: 0o700 })
  const previousExitCode = process.exitCode
  try {
    const terminal = await capture(executable, args ?? ['-e', script ??
      'process.stdout.write(' + JSON.stringify(stdout) + ');process.stderr.write(' + JSON.stringify(stderr) + ');process.exit(' + code + ')'],
    root, cleanEnvironment(), sandbox, 'namespace', 5000)
    await fn({ terminal, sandbox })
  } finally {
    process.exitCode = previousExitCode
    assert.equal(path.dirname(sandbox), path.join(root, 'tmp'))
    assert.match(path.basename(sandbox), /^yida-browser-contract-[a-f0-9-]{36}$/u)
    await fs.rm(sandbox, { recursive: true, force: false })
  }
}

test('child protocol accepts only a complete bounded fixed frame, never secret text or unknown labels', () => {
  for (const stage of ['BOOTSTRAP_ARGUMENTS', 'BOOTSTRAP_OWNER', 'BOOTSTRAP_PATHS', 'BOOTSTRAP_SOURCE_INTEGRITY',
    'BOOTSTRAP_NAMESPACE', 'BOOTSTRAP_LINKS', 'BOOTSTRAP_LO_UP', 'BOOTSTRAP_EXEC']) {
    assert.deepEqual(parseChildFailureFrame(bootstrapFrame(stage)), { stage, reason: 'BOOTSTRAP_FAILED' })
  }
  assert.deepEqual(parseChildFailureFrame(Buffer.from('YIDA_BROWSER_CI_FAILED\nYIDA_BROWSER_CI_STARTUP_FAILED {"stage":"OWNER","reason":"PATH_INVALID"}\n')),
    { stage: 'OWNER', reason: 'PATH_INVALID' })
  assert.deepEqual(parseChildFailureFrame(Buffer.from(unshareDenied)),
    { stage: 'NAMESPACE_CREATE', reason: 'PERMISSION_DENIED_OBSERVED' })
  assert.deepEqual(parseChildFailureFrame(Buffer.alloc(0)), { stage: 'NO_FAILURE_FRAME_OBSERVED', reason: 'UNKNOWN' })
  for (const raw of [bootstrapFrame('SYNTHETIC_SECRET'), Buffer.from('synthetic-secret\n' + bootstrapFrame('BOOTSTRAP_OWNER')),
    Buffer.from('YIDA_BROWSER_CI_FAILED\nYIDA_BROWSER_CI_STARTUP_FAILED {"stage":"OWNER","reason":"SYNTHETIC_SECRET"}\n'),
    Buffer.alloc(1025), Buffer.from('unshare: synthetic-secret'), Buffer.from(bootstrapFrame('BOOTSTRAP_OWNER').toString().trim()),
    Buffer.concat([bootstrapFrame('BOOTSTRAP_OWNER'), Buffer.from('\n')]),
    ...['synthetic-secret\n' + unshareDenied, unshareDenied + 'synthetic-secret\n',
      unshareDenied.trimEnd(), unshareDenied + '\n', unshareDenied.replace('\n', '\r\n'),
      'unshare: unshare failed: Invalid argument\n', 'setpriv: synthetic-secret\n',
      unshareDenied + 'x'.repeat(1025)].map(text => Buffer.from(text))]) {
    assert.deepEqual(parseChildFailureFrame(raw), { stage: 'UNKNOWN', reason: 'INVALID' })
  }
})

test('worker diagnostic validates raw receipt hash, all fields, stage and bounded exit values', () => {
  const ownerSha = 'a'.repeat(64), sourceSha = 'b'.repeat(64)
  for (const stage of ['PG_START', 'PG_READY', 'VITEST_SPAWN', 'EXIT', 'VALIDATE', 'CLEANUP']) {
    const raw = Buffer.from(JSON.stringify(failedWorkerReceipt(ownerSha, sourceSha, stage)))
    assert.deepEqual(parseWorkerFailureReceipt(raw, sha(raw), ownerSha, sourceSha), { stage, reason: 'WORKER_REJECTED' })
    assert.deepEqual(parseWorkerFailureReceipt(raw, 'c'.repeat(64), ownerSha, sourceSha), { stage: 'UNKNOWN', reason: 'INVALID' })
  }
  for (const change of [value => { value.failureStage = 'SYNTHETIC_SECRET' }, value => { value.secret = 'synthetic-secret' },
    value => { value.cleanup = 'synthetic-secret' }, value => { value.ownerSha = 'synthetic-secret' },
    value => { value.tests = 70 }, value => { value.isolatedNetwork = false }]) {
    const value = failedWorkerReceipt(ownerSha, sourceSha); change(value)
    const raw = Buffer.from(JSON.stringify(value))
    assert.deepEqual(parseWorkerFailureReceipt(raw, sha(raw), ownerSha, sourceSha), { stage: 'UNKNOWN', reason: 'INVALID' })
  }
  for (const code of [null, 0, 1, 255, -1, 256, 1.5, 'synthetic-secret']) {
    const value = failedWorkerReceipt(ownerSha, sourceSha, 'EXIT')
    value.result = { code, signaled: code === null, timedOut: false, interrupted: false,
      outputExceeded: false, error: false, bytes: 0, passed: false }
    const raw = Buffer.from(JSON.stringify(value))
    assert.equal(parseWorkerFailureReceipt(raw, sha(raw), ownerSha, sourceSha).reason,
      code === null || Number.isInteger(code) && code >= 0 && code <= 255 ? 'WORKER_REJECTED' : 'INVALID')
  }
})

test('child diagnostic ignores hostile terminal getters and forged public status without reads', () => {
  let reads = 0
  const hostile = new Proxy({}, { get: () => { reads++; throw new Error('synthetic-secret') },
    ownKeys: () => { reads++; throw new Error('synthetic-secret') } })
  for (const terminal of [hostile, { code: 99, reason: 'synthetic-secret', error: new Error('synthetic-secret') }, null]) {
    assert.deepEqual(childFailureDiagnostic(terminal, hostile, hostile, hostile), {
      protocol: 'YIDA_BROWSER_CI_FAILURE_V1', stage: 'UNKNOWN', reason: 'INVALID', childExit: null,
      diagnosticSource: 'CAPTURE', diagnosticOutcome: 'UNAVAILABLE',
      signaled: false, timedOut: false, interrupted: false, outputExceeded: false, error: false })
  }
  assert.equal(reads, 0)
})

test('production capture and outer caller publish bootstrap rejection before unchanged false result', async () => {
  await syntheticChild(({ terminal, sandbox }) => {
    const owner = diagnosticOwner(), lines = []
    assert.equal(reportOuterResult(owner, 'a'.repeat(64), terminal, sandbox, line => lines.push(line)), false)
    assert.equal(process.exitCode, 1)
    assert.deepEqual(JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length)), {
      protocol: 'YIDA_BROWSER_CI_FAILURE_V1', stage: 'BOOTSTRAP_LO_UP', reason: 'BOOTSTRAP_FAILED',
      diagnosticSource: 'STDERR', diagnosticOutcome: 'FRAME_ACCEPTED',
      childExit: 1, signaled: false, timedOut: false, interrupted: false, outputExceeded: false, error: false,
      stderrObservation: { byteCount: bootstrapFrame('BOOTSTRAP_LO_UP').length, lineCount: 2,
        pythonTracebackHeader: false, terminalAssertionError: false, unshareExecutableMissing: false,
        toolPrefix: 'UNKNOWN', unsharePermissionObservation: 'NONE' } })
    assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}')
  }, { stderr: bootstrapFrame('BOOTSTRAP_LO_UP').toString() })
})

test('production capture and outer caller classify only exact unshare denial and keep every variant refused', async () => {
  for (const variant of ['exact', 'prefix', 'suffix', 'missing-newline', 'extra-newline', 'unknown',
    'oversize', 'hash', 'hardlink', 'mode', 'source', 'stdout']) {
    const stderr = variant === 'prefix' ? 'synthetic-secret\n' + unshareDenied
      : variant === 'suffix' ? unshareDenied + 'synthetic-secret\n'
        : variant === 'missing-newline' ? unshareDenied.trimEnd()
          : variant === 'extra-newline' ? unshareDenied + '\n'
            : variant === 'unknown' ? 'unshare: unshare failed: Invalid argument\n'
              : variant === 'oversize' ? unshareDenied + 'x'.repeat(1025) : unshareDenied
    await syntheticChild(async ({ terminal, sandbox }) => {
      const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64), probe = path.join(sandbox, 'source-probe.mjs')
      await fs.writeFile(probe, '// synthetic original source', { mode: 0o600 })
      owner.hashes[probe] = fileHash(probe)
      // Even an otherwise successful receipt cannot override the child exit.
      await fs.writeFile(path.join(sandbox, 'receipt.json'), JSON.stringify({ ownerSha,
        sourceSha: sha(JSON.stringify(owner.hashes)), cleanup: 'stopped-owned-pg-removed', passed: true, tests: 70 }), { mode: 0o600 })
      const file = path.join(sandbox, 'namespace.stderr.log')
      if (variant === 'hash') await fs.appendFile(file, 'synthetic-secret')
      if (variant === 'hardlink') await fs.link(file, path.join(sandbox, 'stderr-alias'))
      if (variant === 'mode') await fs.chmod(file, 0o644)
      if (variant === 'source') await fs.appendFile(probe, '\n// synthetic persistent drift')
      const lines = []
      assert.equal(reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line)), false, variant)
      const [stage, reason] = variant === 'exact' ? ['NAMESPACE_CREATE', 'PERMISSION_DENIED_OBSERVED']
        : variant === 'source' ? ['SOURCE_INTEGRITY', 'POST_HASH_REJECTED'] : ['UNKNOWN', 'INVALID']
      const diagnosticSource = variant === 'source' ? 'SOURCE' : variant === 'stdout' ? 'STDOUT' : 'STDERR'
      const diagnosticOutcome = variant === 'source' ? 'POST_HASH_REJECTED'
        : variant === 'exact' ? 'FRAME_ACCEPTED' : variant === 'hash' ? 'HASH_REJECTED'
          : ['hardlink', 'mode'].includes(variant) ? 'PATH_REJECTED'
            : variant === 'oversize' ? 'SIZE_REJECTED' : 'UNRECOGNIZED_FRAME'
      assert.deepEqual(JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length)), {
        protocol: 'YIDA_BROWSER_CI_FAILURE_V1', stage, reason, childExit: 1,
        diagnosticSource, diagnosticOutcome,
        signaled: false, timedOut: false, interrupted: false, outputExceeded: false, error: false,
        ...(['exact', 'prefix', 'suffix', 'missing-newline', 'extra-newline', 'unknown'].includes(variant)
          ? { stderrObservation: { byteCount: Buffer.byteLength(stderr),
            lineCount: ['prefix', 'suffix', 'extra-newline'].includes(variant) ? 2 : 1,
            pythonTracebackHeader: false, terminalAssertionError: false, unshareExecutableMissing: false,
            toolPrefix: variant === 'prefix' ? 'UNKNOWN' : 'UNSHARE',
            unsharePermissionObservation: variant === 'exact' ? 'CREATE_DENIED' : 'NONE' } } : {}) }, variant)
      assert.equal(lines.length, 2, variant)
      assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}', variant)
      assert.equal(lines.join('\n').includes('synthetic-secret'), false, variant)
      assert.equal(process.exitCode, 1, variant)
    }, { stderr, stdout: variant === 'stdout' ? 'synthetic-secret\n' : '' })
  }
})

test('verified unshare map denials are fixed observations and remain unrecognized failure frames', async () => {
  for (const [stderr, unsharePermissionObservation] of [
    [uidMapDenied, 'UID_MAP_WRITE_DENIED'], [gidMapDenied, 'GID_MAP_WRITE_DENIED'],
  ]) {
    assert.deepEqual(parseChildFailureFrame(Buffer.from(stderr)), { stage: 'UNKNOWN', reason: 'INVALID' })
    await syntheticChild(({ terminal, sandbox }) => {
      assertRefusedDiagnostic(diagnosticOwner(), 'a'.repeat(64), terminal, sandbox,
        { diagnosticSource: 'STDERR', diagnosticOutcome: 'UNRECOGNIZED_FRAME',
          stderrObservation: { byteCount: Buffer.byteLength(stderr), lineCount: 1,
            pythonTracebackHeader: false, terminalAssertionError: false, unshareExecutableMissing: false,
            toolPrefix: 'UNSHARE', unsharePermissionObservation } })
    }, { stderr })
  }
})

test('missing receipts, signals and nonprotocol child logs remain bounded fixed failures', async () => {
  for (const fixture of [{ code: 255 }, { stderr: 'synthetic-secret ' + bootstrapFrame('BOOTSTRAP_LINKS') },
    { script: 'process.kill(process.pid,"SIGTERM")' }]) {
    await syntheticChild(({ terminal, sandbox }) => {
      const lines = [], owner = diagnosticOwner()
      assert.equal(reportOuterResult(owner, 'a'.repeat(64), terminal, sandbox, line => lines.push(line)), false)
      const diagnostic = JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length))
      assert(diagnostic.childExit === null || Number.isInteger(diagnostic.childExit) && diagnostic.childExit >= 0 && diagnostic.childExit <= 255)
      assert.equal(typeof diagnostic.signaled, 'boolean')
      assert.equal(lines.join('\n').includes('synthetic-secret'), false)
      assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}')
      if (fixture.code === 255) assert.equal(diagnostic.stage, 'NO_FAILURE_FRAME_OBSERVED')
    }, fixture)
  }
})

test('production receipt consumer rejects cleanup failure and missing, changed or hardlinked bytes', async () => {
  const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64), sourceSha = sha(JSON.stringify(owner.hashes))
  const receipt = failedWorkerReceipt(ownerSha, sourceSha, 'CLEANUP')
  receipt.cleanup = 'stop-failed-data-retained'
  const raw = JSON.stringify(receipt), stdout = 'YIDA_BROWSER_CI_RECEIPT_SHA256 ' + sha(raw) + '\n'
  for (const variant of ['valid', 'missing', 'changed', 'hardlink', 'mode']) {
    await syntheticChild(async ({ terminal, sandbox }) => {
      const file = path.join(sandbox, 'receipt.json')
      if (variant !== 'missing') await fs.writeFile(file, variant === 'changed' ? raw + ' ' : raw, { mode: 0o600 })
      if (variant === 'hardlink') await fs.link(file, path.join(sandbox, 'receipt-alias.json'))
      if (variant === 'mode') await fs.chmod(file, 0o644)
      const lines = []
      assert.equal(reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line)), false)
      const diagnostic = JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length))
      assert.deepEqual([diagnostic.stage, diagnostic.reason], variant === 'valid' ? ['CLEANUP', 'WORKER_REJECTED'] : ['UNKNOWN', 'INVALID'])
      assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}')
      assert.equal(process.exitCode, 1)
    }, { stdout })
  }
})

function assertRefusedDiagnostic(owner, ownerSha, terminal, sandbox, expected) {
  const lines = []
  assert.equal(terminal.passed, false)
  assert.equal(reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line)), false)
  assert.equal(process.exitCode, 1)
  assert.equal(lines.length, 2)
  const diagnostic = JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length))
  assert.deepEqual(diagnostic, { protocol: 'YIDA_BROWSER_CI_FAILURE_V1', stage: 'UNKNOWN', reason: 'INVALID',
    ...expected, childExit: 1, signaled: false, timedOut: false, interrupted: false, outputExceeded: false, error: false })
  assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}')
  for (const privateValue of ['synthetic-secret', sandbox, ownerSha, sha(JSON.stringify(owner.hashes))]) {
    assert.equal(lines.join('\n').includes(privateValue), false)
  }
  return diagnostic
}

test('verified stderr shape observations remain values-free and never turn nonprotocol logs into accepted frames', async () => {
  const header = 'Traceback (most recent call last):\n'
  const secret = 'synthetic-secret token=synthetic-token authorityCode=synthetic-authority host=192.0.2.17 /synthetic/private/path'
  const missing = 'unshare: failed to execute /usr/bin/python3: No such file or directory\n'
  const fixtures = [
    { stderr: secret, lineCount: 1 },
    { stderr: header + secret + '\nAssertionError\n', lineCount: 3, pythonTracebackHeader: true, terminalAssertionError: true },
    { stderr: header + secret + '\nAssertionError', lineCount: 3, pythonTracebackHeader: true, terminalAssertionError: true },
    { stderr: header + secret + '\nAssertionError: ' + secret + '\n', lineCount: 3, pythonTracebackHeader: true },
    { stderr: header + secret + '\nAssertionError\n' + secret + '\n', lineCount: 4, pythonTracebackHeader: true },
    { stderr: secret + '\n' + header + 'AssertionError\n', lineCount: 3, terminalAssertionError: true },
    { stderr: 'Traceback (most recent call last): ' + secret + '\nAssertionError\n', lineCount: 2, terminalAssertionError: true },
    { stderr: header.replace('\n', '\r\n') + secret + '\r\nAssertionError\r\n', lineCount: 3 },
    { stderr: header + secret + '\nAssertionError\n\n', lineCount: 4, pythonTracebackHeader: true },
    { stderr: 'AssertionError\n', lineCount: 1, terminalAssertionError: true },
    { stderr: missing, lineCount: 1, unshareExecutableMissing: true, toolPrefix: 'UNSHARE' },
    { stderr: missing + secret + '\n', lineCount: 2, toolPrefix: 'UNSHARE' },
    { stderr: missing.replace('/usr/bin/python3', '/synthetic/private/path'), lineCount: 1, toolPrefix: 'UNSHARE' },
    { stderr: missing.trimEnd(), lineCount: 1, toolPrefix: 'UNSHARE' },
    { stderr: 'unshare: ' + secret + '\n', lineCount: 1, toolPrefix: 'UNSHARE' },
    { stderr: 'setpriv: ' + secret + '\n', lineCount: 1, toolPrefix: 'SETPRIV' },
    { stderr: 'ip: ' + secret + '\n', lineCount: 1, toolPrefix: 'IP' },
    { stderr: secret + '\nunshare: ' + secret + '\n', lineCount: 2 },
    { stderr: 'unshare:' + secret + '\n', lineCount: 1 },
    { stderr: ' ' + uidMapDenied, lineCount: 1 },
    { stderr: gidMapDenied + ' ', lineCount: 2, toolPrefix: 'UNSHARE' },
    { stderr: uidMapDenied.replace('\n', '\r\n'), lineCount: 1, toolPrefix: 'UNSHARE' },
    { stderr: gidMapDenied.replace('/proc/self/gid_map', '/synthetic/private/path'), lineCount: 1, toolPrefix: 'UNSHARE' },
    { stderr: uidMapDenied + 'x'.repeat(950), lineCount: 2, toolPrefix: 'UNSHARE' },
    { stderr: 'synthetic-secret-' + 'x'.repeat(1007), lineCount: 1 },
  ]
  for (const { stderr, lineCount, ...shape } of fixtures) {
    assert.deepEqual(parseChildFailureFrame(Buffer.from(stderr)), { stage: 'UNKNOWN', reason: 'INVALID' })
    await syntheticChild(({ terminal, sandbox }) => {
      const diagnostic = assertRefusedDiagnostic(diagnosticOwner(), 'a'.repeat(64), terminal, sandbox,
        { diagnosticSource: 'STDERR', diagnosticOutcome: 'UNRECOGNIZED_FRAME',
          stderrObservation: { byteCount: Buffer.byteLength(stderr), lineCount, pythonTracebackHeader: false,
            terminalAssertionError: false, unshareExecutableMissing: false, toolPrefix: 'UNKNOWN',
            unsharePermissionObservation: 'NONE', ...shape } })
      for (const privateValue of [secret, 'synthetic-token', 'synthetic-authority', '192.0.2.17', '/synthetic/private/path']) {
        assert.equal(JSON.stringify(diagnostic).includes(privateValue), false)
      }
      assert.equal(Object.isFrozen(childFailureDiagnostic(terminal, sandbox, 'a'.repeat(64), 'b'.repeat(64)).stderrObservation), true)
    }, { stderr })
  }
})

test('stderr observations require original capture identity, source verification, empty stdout and verified bounded bytes', async () => {
  const stderr = 'Traceback (most recent call last):\nsynthetic-secret\nAssertionError\n'
  for (const fault of ['hash', 'missing', 'directory', 'hardlink', 'mode', 'oversize', 'stdout', 'source', 'forged', 'receipt', 'invalid-receipt']) {
    const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64)
    const receipt = failedWorkerReceipt(ownerSha, sha(JSON.stringify(owner.hashes)), 'CLEANUP')
    if (fault === 'invalid-receipt') receipt.passed = true
    const receiptRaw = JSON.stringify(receipt)
    await syntheticChild(async ({ terminal, sandbox }) => {
      const file = path.join(sandbox, 'namespace.stderr.log')
      if (fault === 'hash') await fs.appendFile(file, 'synthetic-secret')
      if (fault === 'missing' || fault === 'directory') await fs.unlink(file)
      if (fault === 'directory') await fs.mkdir(file, { mode: 0o700 })
      if (fault === 'hardlink') await fs.link(file, path.join(sandbox, 'stderr-alias'))
      if (fault === 'mode') await fs.chmod(file, 0o644)
      if (fault === 'source') owner.hashes[path.join(lib, 'stock-preparation-plm-owned-pg.mjs')] = '0'.repeat(64)
      if (fault === 'receipt' || fault === 'invalid-receipt') {
        await fs.writeFile(path.join(sandbox, 'receipt.json'), receiptRaw, { mode: 0o600 })
      }
      const diagnosticSource = fault === 'source' ? 'SOURCE' : fault === 'forged' ? 'CAPTURE'
        : ['receipt', 'invalid-receipt'].includes(fault) ? 'RECEIPT' : fault === 'stdout' ? 'STDOUT' : 'STDERR'
      const diagnosticOutcome = fault === 'source' ? 'POST_HASH_REJECTED' : fault === 'forged' ? 'UNAVAILABLE'
        : fault === 'receipt' ? 'FRAME_ACCEPTED' : fault === 'invalid-receipt' ? 'RECEIPT_INVALID'
          : fault === 'stdout' ? 'UNRECOGNIZED_FRAME' : fault === 'hash' ? 'HASH_REJECTED'
            : fault === 'oversize' ? 'SIZE_REJECTED' : 'PATH_REJECTED'
      const lines = []
      assert.equal(reportOuterResult(owner, ownerSha, fault === 'forged' ? { ...terminal, passed: true } : terminal, sandbox, line => lines.push(line)), false)
      const diagnostic = JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length))
      assert.equal(Object.hasOwn(diagnostic, 'stderrObservation'), false)
      assert.equal(diagnostic.diagnosticSource, diagnosticSource)
      assert.equal(diagnostic.diagnosticOutcome, diagnosticOutcome)
      assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}')
      assert.equal(process.exitCode, 1)
      assert.equal(lines.join('\n').includes('synthetic-secret'), false)
    }, { stderr: fault === 'oversize' ? stderr + 'x'.repeat(1025) : stderr,
      stdout: fault === 'stdout' ? 'synthetic-secret\n' : ['receipt', 'invalid-receipt'].includes(fault)
        ? 'YIDA_BROWSER_CI_RECEIPT_SHA256 ' + sha(receiptRaw) + '\n' : '' })
  }
})

test('actual capture to outer report routes each private file rejection without changing refusal', async () => {
  const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64), sourceSha = sha(JSON.stringify(owner.hashes))
  const receiptRaw = JSON.stringify(failedWorkerReceipt(ownerSha, sourceSha))
  const receiptStdout = 'YIDA_BROWSER_CI_RECEIPT_SHA256 ' + sha(receiptRaw) + '\n'
  const faults = { missing: 'PATH_REJECTED', directory: 'PATH_REJECTED', symlink: 'PATH_REJECTED',
    hardlink: 'PATH_REJECTED', mode: 'PATH_REJECTED', 'stat-size': 'SIZE_REJECTED',
    'read-size': 'SIZE_REJECTED', hash: 'HASH_REJECTED', read: 'READ_REJECTED', unexpected: 'UNAVAILABLE' }
  for (const diagnosticSource of ['STDOUT', 'STDERR', 'RECEIPT']) {
    for (const [fault, diagnosticOutcome] of Object.entries(faults)) {
      await syntheticChild(async ({ terminal, sandbox }) => {
        const file = path.join(sandbox, diagnosticSource === 'RECEIPT' ? 'receipt.json'
          : 'namespace.' + diagnosticSource.toLowerCase() + '.log')
        if (diagnosticSource === 'RECEIPT') await fs.writeFile(file, receiptRaw, { mode: 0o600 })
        if (['missing', 'directory', 'symlink'].includes(fault)) await fs.unlink(file)
        if (fault === 'directory') await fs.mkdir(file, { mode: 0o700 })
        if (fault === 'symlink') {
          const alias = path.join(sandbox, 'synthetic-alias')
          await fs.writeFile(alias, 'synthetic-secret', { mode: 0o600 })
          await fs.symlink(alias, file)
        }
        if (fault === 'hardlink') await fs.link(file, path.join(sandbox, 'synthetic-alias'))
        if (fault === 'mode') await fs.chmod(file, 0o644)
        if (fault === 'stat-size') await fs.appendFile(file, Buffer.alloc(diagnosticSource === 'RECEIPT' ? 16384 : 1025))
        if (fault === 'hash') await fs.appendFile(file, 'synthetic-secret')
        const originalRead = fsSync.readFileSync, originalStat = fsSync.lstatSync
        let reads = 0
        const hostile = new Proxy({}, { get: () => { reads++; throw new Error('synthetic-secret') },
          ownKeys: () => { reads++; throw new Error('synthetic-secret') },
          getPrototypeOf: () => { reads++; throw new Error('synthetic-secret') } })
        try {
          if (fault === 'read' || fault === 'read-size') fsSync.readFileSync = (target, ...args) => {
            if (target !== file) return originalRead(target, ...args)
            if (fault === 'read') throw hostile
            return Buffer.alloc(diagnosticSource === 'RECEIPT' ? 16384 : 1025)
          }
          if (fault === 'unexpected') fsSync.lstatSync = (target, ...args) => {
            if (target === file) throw hostile
            return originalStat(target, ...args)
          }
          assertRefusedDiagnostic(owner, ownerSha, terminal, sandbox, { diagnosticSource, diagnosticOutcome })
          assert.equal(reads, 0)
        } finally { fsSync.readFileSync = originalRead; fsSync.lstatSync = originalStat }
      }, { stdout: diagnosticSource === 'RECEIPT' ? receiptStdout : '',
        stderr: bootstrapFrame('BOOTSTRAP_OWNER').toString() })
    }
  }
})

test('actual capture to outer report distinguishes invalid receipt bytes from accepted failed worker frames', async () => {
  const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64), sourceSha = sha(JSON.stringify(owner.hashes))
  for (const variant of ['invalid-json', 'invalid-schema', 'wrong-owner', 'wrong-source',
    'PG_START', 'PG_READY', 'VITEST_SPAWN', 'EXIT', 'VALIDATE', 'CLEANUP']) {
    const accepted = ['PG_START', 'PG_READY', 'VITEST_SPAWN', 'EXIT', 'VALIDATE', 'CLEANUP'].includes(variant)
    const receipt = failedWorkerReceipt(ownerSha, sourceSha, accepted ? variant : 'PG_START')
    if (variant === 'invalid-schema') receipt.secret = 'synthetic-secret'
    if (variant === 'wrong-owner') receipt.ownerSha = 'c'.repeat(64)
    if (variant === 'wrong-source') receipt.sourceSha = 'd'.repeat(64)
    const raw = variant === 'invalid-json' ? '{"synthetic-secret":' : JSON.stringify(receipt)
    await syntheticChild(async ({ terminal, sandbox }) => {
      await fs.writeFile(path.join(sandbox, 'receipt.json'), raw, { mode: 0o600 })
      assertRefusedDiagnostic(owner, ownerSha, terminal, sandbox, { diagnosticSource: 'RECEIPT',
        diagnosticOutcome: accepted ? 'FRAME_ACCEPTED' : 'RECEIPT_INVALID',
        ...(accepted ? { stage: variant, reason: 'WORKER_REJECTED' } : {}) })
    }, { stdout: 'YIDA_BROWSER_CI_RECEIPT_SHA256 ' + sha(raw) + '\n',
      stderr: bootstrapFrame('BOOTSTRAP_OWNER').toString() })
  }
})

test('actual capture to outer report keeps stdout precedence, clean empty streams and post-hash refusal', async () => {
  for (const stdout of ['synthetic-secret\n', 'YIDA_BROWSER_CI_RECEIPT_SHA256 ' + 'c'.repeat(64),
    bootstrapFrame('BOOTSTRAP_OWNER').toString()]) {
    await syntheticChild(({ terminal, sandbox }) => {
      assertRefusedDiagnostic(diagnosticOwner(), 'a'.repeat(64), terminal, sandbox,
        { diagnosticSource: 'STDOUT', diagnosticOutcome: 'UNRECOGNIZED_FRAME' })
    }, { stdout, stderr: bootstrapFrame('BOOTSTRAP_OWNER').toString() })
  }
  await syntheticChild(({ terminal, sandbox }) => {
    assertRefusedDiagnostic(diagnosticOwner(), 'a'.repeat(64), terminal, sandbox,
      { stage: 'NO_FAILURE_FRAME_OBSERVED', reason: 'UNKNOWN', diagnosticSource: 'STDERR', diagnosticOutcome: 'EMPTY',
        stderrObservation: { byteCount: 0, lineCount: 0, pythonTracebackHeader: false,
          terminalAssertionError: false, unshareExecutableMissing: false,
          toolPrefix: 'UNKNOWN', unsharePermissionObservation: 'NONE' } })
  })
  await syntheticChild(async ({ terminal, sandbox }) => {
    const owner = diagnosticOwner(), probe = path.join(sandbox, 'source-probe.mjs')
    await fs.writeFile(probe, '// synthetic source', { mode: 0o600 })
    owner.hashes[probe] = fileHash(probe)
    await fs.appendFile(probe, '// synthetic drift')
    await fs.unlink(path.join(sandbox, 'namespace.stdout.log'))
    assertRefusedDiagnostic(owner, 'a'.repeat(64), terminal, sandbox,
      { stage: 'SOURCE_INTEGRITY', reason: 'POST_HASH_REJECTED', diagnosticSource: 'SOURCE', diagnosticOutcome: 'POST_HASH_REJECTED' })
  })
})

test('diagnostic log hash, file mode, byte budget and source failures are fixed and never affect success', async () => {
  for (const variant of ['hash', 'hardlink', 'mode', 'oversize']) {
    await syntheticChild(async ({ terminal, sandbox }) => {
      const file = path.join(sandbox, 'namespace.stderr.log')
      if (variant === 'hash') await fs.appendFile(file, 'synthetic-secret')
      if (variant === 'hardlink') await fs.link(file, path.join(sandbox, 'stderr-alias'))
      if (variant === 'mode') await fs.chmod(file, 0o644)
      const diagnostic = childFailureDiagnostic(terminal, sandbox, 'a'.repeat(64), 'b'.repeat(64))
      assert.deepEqual([diagnostic.stage, diagnostic.reason], ['UNKNOWN', 'INVALID'])
      assert.equal(JSON.stringify(diagnostic).includes('synthetic-secret'), false)
    }, { stderr: variant === 'oversize' ? 'x'.repeat(1025) : bootstrapFrame('BOOTSTRAP_OWNER').toString() })
  }
  await syntheticChild(async ({ terminal, sandbox }) => {
    const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64)
    // Original success criteria still govern even if the diagnostic view is
    // unavailable. No new protocol serves as a capability or success fallback.
    await fs.writeFile(path.join(sandbox, 'receipt.json'), JSON.stringify({ ownerSha,
      sourceSha: sha(JSON.stringify(owner.hashes)), cleanup: 'stopped-owned-pg-removed', passed: true, tests: 70 }), { mode: 0o600 })
    const lines = []
    assert.equal(reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line)), true)
    assert.deepEqual(lines, ['YIDA_BROWSER_CI_RESULT {"passed":true,"tests":70,"business":65,"sentinels":5}'])
    owner.hashes[path.join(lib, 'stock-preparation-plm-owned-pg.mjs')] = '0'.repeat(64)
    lines.length = 0
    assert.equal(reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line)), false)
    assert.deepEqual([JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length)).stage,
      JSON.parse(lines[0].slice('YIDA_BROWSER_CI_CHILD_FAILED '.length)).reason], ['SOURCE_INTEGRITY', 'POST_HASH_REJECTED'])
  }, { code: 0, stderr: 'synthetic-secret-mixed-log' })
})

test('source wiring only: Python and worker phase labels and parent diagnostic consumer remain connected', async () => {
  const runnerSource = await fs.readFile(path.join(root, 'scripts/ops/run-stock-preparation-yida-browser-ci.mjs'), 'utf8')
  const helperSource = await fs.readFile(path.join(lib, 'stock-preparation-yida-browser-ci-namespace.py'), 'utf8')
  assert.match(runnerSource, /reportOuterResult\(owner, ownerSha, terminal, evidence\)/u)
  assert.match(runnerSource, /failureStage, result/u)
  assert.match(runnerSource, /console\.log\('YIDA_BROWSER_CI_RECEIPT_SHA256 ' \+ hash\(receiptRaw\)\)/u)
  for (const stage of ['PG_START', 'PG_READY', 'VITEST_SPAWN', 'EXIT', 'VALIDATE']) assert.match(runnerSource, new RegExp("stage = '" + stage + "'", 'u'))
  assert.match(runnerSource, /failureStage = 'CLEANUP'/u)
  assert.match(helperSource, /sys\.stderr\.write\('YIDA_BROWSER_CI_BOOTSTRAP_STAGE '/u)
  assert.match(helperSource, /sys\.stderr\.write\('YIDA_BROWSER_CI_BOOTSTRAP_FAILED\\n'\)/u)
  for (const stage of ['BOOTSTRAP_ARGUMENTS', 'BOOTSTRAP_OWNER', 'BOOTSTRAP_PATHS', 'BOOTSTRAP_SOURCE_INTEGRITY',
    'BOOTSTRAP_NAMESPACE', 'BOOTSTRAP_LINKS', 'BOOTSTRAP_LO_UP', 'BOOTSTRAP_EXEC']) assert.match(helperSource, new RegExp("phase = '" + stage + "'", 'u'))
})

test('production outer caller rejects each single failure against an otherwise successful capture and receipt', async () => {
  for (const fault of ['none', 'cleanup', 'tests', 'passed', 'terminal', 'source']) {
    await syntheticChild(async ({ terminal, sandbox }) => {
      const owner = diagnosticOwner(), ownerSha = 'a'.repeat(64), probe = path.join(sandbox, 'source-probe.mjs')
      await fs.writeFile(probe, '// synthetic original source', { mode: 0o600 })
      owner.hashes[probe] = fileHash(probe)
      const receipt = { ownerSha, sourceSha: sha(JSON.stringify(owner.hashes)),
        cleanup: 'stopped-owned-pg-removed', passed: true, tests: 70 }
      if (fault === 'cleanup') receipt.cleanup = 'stop-failed-data-retained'
      if (fault === 'tests') receipt.tests = 69
      if (fault === 'passed') receipt.passed = false
      await fs.writeFile(path.join(sandbox, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 })
      // Mutate only a private synthetic source byte, keeping owner hashes and
      // receipt sourceSha unchanged so no second check masks this guard.
      if (fault === 'source') await fs.appendFile(probe, '\n// synthetic persistent drift')
      const lines = [], passed = reportOuterResult(owner, ownerSha, terminal, sandbox, line => lines.push(line))
      assert.equal(passed, fault === 'none', fault)
      if (fault === 'none') assert.deepEqual(lines,
        ['YIDA_BROWSER_CI_RESULT {"passed":true,"tests":70,"business":65,"sentinels":5}'])
      else {
        assert.equal(process.exitCode, 1, fault)
        assert.equal(lines.length, 2, fault)
        assert.equal(lines[1], 'YIDA_BROWSER_CI_RESULT {"passed":false,"tests":0,"business":0,"sentinels":0}', fault)
      }
    }, { code: fault === 'terminal' ? 1 : 0 })
  }
})

test('actual fixed Python helper produces the safe first-gate failure frame without a namespace', async () => {
  await syntheticChild(async ({ terminal, sandbox }) => {
    // No owner argument: len(argv) fails before PID, owner reads, ip, setpriv
    // or namespace work. Only this first gate is exercised by this fixture.
    assert.equal(terminal.code, 1)
    assert.equal(terminal.passed, false)
    const raw = await fs.readFile(path.join(sandbox, 'namespace.stderr.log'))
    assert.deepEqual(parseChildFailureFrame(raw), { stage: 'BOOTSTRAP_ARGUMENTS', reason: 'BOOTSTRAP_FAILED' })
    assert.deepEqual([childFailureDiagnostic(terminal, sandbox, 'a'.repeat(64), 'b'.repeat(64)).stage,
      childFailureDiagnostic(terminal, sandbox, 'a'.repeat(64), 'b'.repeat(64)).reason], ['BOOTSTRAP_ARGUMENTS', 'BOOTSTRAP_FAILED'])
  }, { executable: '/usr/bin/python3', args: [path.join(lib, 'stock-preparation-yida-browser-ci-namespace.py')] })
})
