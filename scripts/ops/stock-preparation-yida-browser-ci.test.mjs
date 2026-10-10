import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertNoEnvironmentFiles, cleanEnvironment, CONFIG, DEADLINE_MS, fileHash, main, MAX_OUTPUT, parsePublicArguments,
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
