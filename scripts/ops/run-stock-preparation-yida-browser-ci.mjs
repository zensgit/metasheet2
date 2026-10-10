import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRATCH_OWNER, startOwnedPostgres } from './lib/stock-preparation-plm-owned-pg.mjs'

// Test-only Linux/Node20 launcher. No external DB, .env, arbitrary command,
// customer configuration, migration CLI, or source mutation is accepted.
export const TEST_FILES = Object.freeze([
  'tests/integration/yida-initialization-runtime-realdb.test.ts',
  'tests/integration/stock-preparation-yida-owner-http-realdb.test.ts',
  'tests/integration/stock-preparation-yida-owner-browser-realdb.test.ts',
  'tests/integration/stock-preparation-yida-initialization-http-realdb.test.ts',
  'tests/integration/stock-preparation-yida-initialization-browser-realdb.test.ts',
])
export const CONFIG = 'vitest.yida-owner-realdb.config.ts'
export const MAX_OUTPUT = 32 * 1024 * 1024
export const DEADLINE_MS = 15 * 60 * 1000
const runner = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(runner), '../..')
const lib = path.join(root, 'scripts/ops/lib')
const nativePath = path.join(lib, 'stock-preparation-browser-network-isolation.cjs')
const pgPath = path.join(lib, 'stock-preparation-plm-owned-pg.mjs')
const helper = path.join(lib, 'stock-preparation-yida-browser-ci-namespace.py')
const preload = path.join(lib, 'stock-preparation-yida-browser-ci-preload.cjs')
const backend = path.join(root, 'packages/core-backend')
const requireBackend = createRequire(path.join(backend, 'package.json'))
const native = createRequire(import.meta.url)(nativePath)
// Only errors created here carry a public reason. Never inspect thrown values:
// even message/code getters or a forged Error can contain customer values.
const failureReasons = new WeakMap()
const failureStages = new WeakMap()
const startupReasons = new Set(['ARGUMENTS_INVALID', 'ENVIRONMENT_FILE_PRESENT', 'PATH_INVALID',
  'PLATFORM_UNSUPPORTED', 'NODE_VERSION_UNSUPPORTED', 'IDENTITY_INVALID', 'INIT_UNAVAILABLE', 'INTERRUPTED'])
const startupStages = new Set(['RUNTIME', 'ARGUMENTS', 'ENVIRONMENT_FILES', 'PATHS', 'TOOLS',
  'SOURCE_INTEGRITY', 'OWNER', 'NAMESPACE', 'WORKER'])
const fail = code => {
  const reason = startupReasons.has(code) ? code : 'INTERNAL'
  const error = new Error('YIDA_BROWSER_CI_' + reason)
  failureReasons.set(error, reason)
  return error
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function startupFailureDiagnostic(error, stage) {
  return Object.freeze({ stage: startupStages.has(stage) ? stage : 'RUNTIME',
    reason: failureReasons.get(error) ?? 'INTERNAL' })
}

export function reportStartupFailure(error, stage = failureStages.get(error), write = console.error) {
  process.exitCode = 1
  write('YIDA_BROWSER_CI_FAILED')
  write('YIDA_BROWSER_CI_STARTUP_FAILED ' + JSON.stringify(startupFailureDiagnostic(error, stage)))
}

function assertRuntime() {
  if (process.platform !== 'linux') throw fail('PLATFORM_UNSUPPORTED')
  if (Number(process.versions.node.split('.')[0]) !== 20) throw fail('NODE_VERSION_UNSUPPORTED')
  if (!(process.getuid() > 0 && process.getgid() > 0)) throw fail('IDENTITY_INVALID')
}

export function cleanEnvironment(input = {}) {
  // HOME/cache location is OS plumbing for the preinstalled Chromium. Node,
  // PG, credentials, production switches and application environments cannot
  // flow through this allowlist. The fixed PATH also avoids ambient executables.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }
  for (const key of ['HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (typeof input[key] === 'string' && path.isAbsolute(input[key]) && !input[key].includes('\0')) env[key] = input[key]
  }
  return env
}

export function parsePublicArguments(args) {
  if (args.length !== 2 || args[0] !== '--pg-bin' || !path.isAbsolute(args[1]) || args[1].includes('\0')) {
    throw fail('ARGUMENTS_INVALID')
  }
  return { pgBin: path.resolve(args[1]) }
}

export function assertNoEnvironmentFiles(directories) {
  // Check names only, never content. Vite's original backend config can load
  // .env implicitly; refuse such a workspace before invoking the real CLI.
  for (const directory of directories) {
    if (fs.readdirSync(directory).some(name => /^\.env(?:$|\.)/u.test(name)
      && !/\.(?:example|template)$/u.test(name))) throw fail('ENVIRONMENT_FILE_PRESENT')
  }
}

function plain(target, directory = false, privateMode = undefined, dependencyHardlinks = false) {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
    || fs.realpathSync(target) !== target
    || !directory && stat.nlink !== 1 && !dependencyHardlinks
    || privateMode !== undefined && ((stat.mode & 0o777) !== privateMode || stat.uid !== process.getuid())) throw fail('PATH_INVALID')
  return stat
}
export function fileHash(file) {
  // PNPM may hardlink its resolved CLI to its package store. Only that exact
  // dependency gets the exception; source, guard, collector and receipts do not.
  // Raw hashes detect persistent drift, not hostile same-user filesystem races.
  plain(file, false, undefined, file === requireBackend.resolve('vitest/vitest.mjs'))
  // Source files are small; the actual Node executable may exceed that limit.
  const descriptor = fs.openSync(file, 'r')
  const result = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try { for (;;) { const count = fs.readSync(descriptor, buffer); if (!count) break; result.update(buffer.subarray(0, count)) } }
  finally { fs.closeSync(descriptor) }
  return result.digest('hex')
}
function sourcePaths(node, cli) {
  return [runner, nativePath, pgPath, helper, preload, node, cli, path.join(backend, CONFIG),
    ...TEST_FILES.map(file => path.join(backend, file)),
    ...['stock-preparation-yida-owner-browser-fixture.ts', 'stock-preparation-yida-owner-http-fixture.ts',
      'yida-native-module-import.cjs'].map(file => path.join(backend, 'tests/utils', file))]
}
function verifyHashes(owner) {
  for (const [file, sha] of Object.entries(owner.hashes)) assert.equal(fileHash(file), sha)
  assert.equal(owner.hashes[nativePath], 'cf364bfed3960af8e5c387a4c5d7aa882ce1d558c84f937e6b5816ae5927980c')
  assert.equal(owner.hashes[pgPath], '37b430df4a9edc093d1f8839aeacd90d376088539e19f4a8916d01d501164677')
}
function privateWrite(file, bytes) { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }) }
function readOwner(ownerPath, sha) {
  const relative = path.relative(path.join(root, 'tmp'), ownerPath)
  assert.match(relative, /^yida-browser-ci-[a-f0-9-]{36}[/\\]owner\.json$/u)
  plain(path.dirname(ownerPath), true, 0o700)
  assert(plain(ownerPath, false, 0o600).size < 65536)
  const raw = fs.readFileSync(ownerPath)
  assert.equal(hash(raw), sha)
  const owner = JSON.parse(raw)
  assert.equal(owner.protocol, 'YIDA_BROWSER_CI_NATIVE_V1')
  assert.equal(owner.root, root); assert.equal(owner.runner, runner)
  assert.equal(owner.helper, helper); assert.equal(owner.preload, preload); assert.equal(owner.native, nativePath)
  assert.equal(owner.node, process.execPath); assert.equal(owner.uid, process.getuid()); assert.equal(owner.gid, process.getgid())
  assert.equal(owner.cli, requireBackend.resolve('vitest/vitest.mjs'))
  assert.equal(owner.collector, path.join(path.dirname(ownerPath), 'collector.mjs'))
  assert.deepEqual(Object.keys(owner.hashes).sort(), [...sourcePaths(owner.node, owner.cli), owner.collector].sort())
  assert.equal(owner.hashes[owner.collector], hash(COLLECTOR))
  verifyHashes(owner)
  assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), owner.parentNetworkNamespace)
  return owner
}

// Reporter-only observation of the actual original CLI task tree. No task,
// config, test name, retry or setup modification. Raw errors remain private.
const COLLECTOR = `import fs from 'node:fs'
import path from 'node:path'
export default class Collector {
  onInit(ctx) { this.ctx = ctx }
  onFinished(files = this.ctx.state.getFiles(), errors = this.ctx.state.getUnhandledErrors()) {
    const counts = { files: files.length, tests: 0, passed: 0, failed: 0, skipped: 0,
      sentinels: 0, retries: 0, repeats: 0, unhandled: errors.length, missingRetryFields: 0 }
    const visit = task => {
      if (task.type === 'test') {
        counts.tests++
        if (task.name.startsWith('sentinel:')) counts.sentinels++
        if (!Number.isSafeInteger(task.result?.retryCount)) counts.missingRetryFields++
        counts.retries += task.result?.retryCount ?? 0
        counts.repeats += task.result?.repeatCount ?? 0
        if (task.mode === 'skip' || task.mode === 'todo' || task.result?.state === 'skip') counts.skipped++
        else if (task.result?.state === 'pass') counts.passed++
        else counts.failed++
      }
      for (const child of task.tasks ?? []) visit(child)
    }
    for (const file of files) visit(file)
    const config = this.ctx.config
    const receipt = { counts, files: files.map(file => path.relative(this.ctx.config.root, file.filepath)).sort(),
      policy: { pool: config.pool, config: path.basename(this.ctx.server.config.configFile),
        retry: config.retry ?? 0, repeat: config.repeat ?? 0, watch: config.watch,
        filtered: config.testNamePattern !== undefined, setupFiles: config.setupFiles.length,
        globalSetup: config.globalSetup.length } }
    fs.writeFileSync(process.env.YIDA_BROWSER_CI_TASKS, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  }
}
`

export function validateTaskReceipt(receipt) {
  assert.deepEqual(receipt.files, [...TEST_FILES].sort())
  assert.deepEqual(receipt.counts, { files: 5, tests: 70, passed: 70, failed: 0, skipped: 0,
    sentinels: 5, retries: 0, repeats: 0, unhandled: 0, missingRetryFields: 0 })
  assert.deepEqual(receipt.policy, { pool: 'forks', config: CONFIG, retry: 0, repeat: 0,
    watch: false, filtered: false, setupFiles: 0, globalSetup: 0 })
  return true
}

// Every stream is bounded and private. Closing is awaited after signaling.
// Timed-out cleanup is never advertised as proven or followed by broad removal.
async function capture(executable, args, cwd, env, evidence, name, milliseconds, namespaceOwner) {
  const handles = Object.fromEntries(['stdout', 'stderr'].map(stream =>
    [stream, fs.openSync(path.join(evidence, name + '.' + stream + '.log'), 'wx', 0o600)]))
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let timedOut = false, interrupted = false, outputExceeded = false, error = false, bytes = 0, closed = false, escalation, gracefulRetry
  let terminationRequested = false
  const terminate = () => {
    if (closed || terminationRequested) return
    terminationRequested = true
    if (namespaceOwner) {
      // The direct unshare child owns exactly one PID1 descendant. Verify its
      // live executable and complete command before sending the graceful signal.
      // Killing unshare immediately would invoke --kill-child and bypass PG stop.
      let attempts = 0
      const signalInit = () => {
        if (closed) return
        try {
          const children = fs.readFileSync('/proc/' + child.pid + '/task/' + child.pid + '/children', 'utf8').trim().split(/\s+/u)
          if (children.length !== 1 || !/^[1-9][0-9]*$/u.test(children[0])) throw fail('INIT_UNAVAILABLE')
          const pid = Number(children[0])
          assert.equal(fs.readlinkSync('/proc/' + pid + '/exe'), namespaceOwner.node)
          const actual = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean)
          assert.deepEqual(actual, [namespaceOwner.node, runner, '--namespace-init', namespaceOwner.ownerPath, namespaceOwner.ownerSha])
          process.kill(pid, 'SIGTERM')
        } catch {
          // A signal can arrive during the short Python -> setpriv -> Node
          // bootstrap window. Retry only this owned child relation, bounded.
          if (++attempts < 50) gracefulRetry = setTimeout(signalInit, 100)
        }
      }
      signalInit()
      if (!escalation) escalation = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, 70000)
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { error = true }
      if (!escalation) escalation = setTimeout(() => { if (!closed) try { process.kill(-child.pid, 'SIGKILL') } catch { error = true } }, 5000)
    }
  }
  const signal = () => { interrupted = true; terminate() }
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  const timer = setTimeout(() => { timedOut = true; terminate() }, milliseconds)
  child.once('error', () => { error = true })
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    bytes += chunk.length
    if (bytes > MAX_OUTPUT) { outputExceeded = true; terminate(); return }
    try {
      for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(handles[stream], chunk, offset, chunk.length - offset)
    } catch { error = true; terminate() }
  })
  const terminal = await new Promise(resolve => child.once('close', (code, childSignal) => {
    closed = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(gracefulRetry)
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal)
    for (const fd of Object.values(handles)) { fs.fsyncSync(fd); fs.closeSync(fd) }
    resolve({ code, signaled: childSignal !== null, timedOut, interrupted, outputExceeded, error, bytes })
  }))
  return { ...terminal, passed: terminal.code === 0 && !terminal.signaled && !timedOut && !interrupted && !outputExceeded && !error }
}

async function namespaceInit(owner, ownerPath, ownerSha) {
  assert.equal(process.pid, 1)
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\s*1$/mu)
  native.verifyBrowserNamespaceLauncher(owner.parentNetworkNamespace)
  const child = spawn(process.execPath, [runner, '--worker', ownerPath, ownerSha],
    { cwd: root, env: cleanEnvironment(process.env), stdio: ['ignore', 'inherit', 'inherit'] })
  const terminate = () => { child.kill('SIGTERM') }
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate)
  // PID1 stays alive until worker cleanup finishes. Its death causes the kernel
  // to kill all remaining PG/Chromium descendants in this PID namespace.
  const result = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('close', code => resolve(code ?? 1)) })
  process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate)
  process.exitCode = result
}

async function worker(owner, ownerPath, ownerSha) {
  assert(process.pid > 1)
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\s*1$/mu)
  const init = fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean)
  assert.deepEqual(init, [owner.node, runner, '--namespace-init', ownerPath, ownerSha])
  const isolation = native.installBrowserNetworkIsolation(owner.parentNetworkNamespace)
  const evidence = path.dirname(ownerPath)
  const nonce = randomUUID(), scratchDir = path.join(root, 'tmp', 'stock-preparation-plm-full-app-' + nonce)
  fs.mkdirSync(scratchDir, { mode: 0o700 })
  privateWrite(path.join(scratchDir, 'owner.json'), JSON.stringify({ owner: SCRATCH_OWNER, nonce, repoRoot: root, pid: process.pid }))
  let database, result, passed = false, cleanup = 'not-started', interrupted = false
  const signal = () => { interrupted = true }
  process.once('SIGTERM', signal); process.once('SIGINT', signal)
  try {
    database = await startOwnedPostgres({ repoRoot: root, scratchDir, pgBin: owner.pgBin, env: cleanEnvironment(process.env) })
    if (interrupted) throw fail('INTERRUPTED')
    verifyHashes(owner)
    const tasks = path.join(evidence, 'tasks.json'), json = path.join(evidence, 'vitest.json')
    const env = { ...cleanEnvironment(process.env), DATABASE_URL: database.url, EXPECT_DB: '1',
      NODE_OPTIONS: '--require ' + JSON.stringify(preload), YIDA_BROWSER_CI_OWNER: ownerPath,
      YIDA_BROWSER_CI_OWNER_SHA256: ownerSha, YIDA_BROWSER_CI_TASKS: tasks }
    const args = [owner.cli, 'run', '--config', CONFIG, '--reporter=verbose', ...TEST_FILES,
      '--reporter=json', '--reporter=' + owner.collector, '--outputFile.json=' + json]
    native.assertBrowserNetworkIsolation()
    result = await capture(owner.node, args, backend, env, evidence, 'vitest', DEADLINE_MS - 120000)
    assert(result.passed && !interrupted)
    for (const file of [tasks, json]) assert(plain(file, false, 0o600).size < 4 * 1024 * 1024)
    validateTaskReceipt(JSON.parse(fs.readFileSync(tasks, 'utf8')))
    const report = JSON.parse(fs.readFileSync(json, 'utf8'))
    assert.equal(report.success, true); assert.equal(report.numTotalTests, 70); assert.equal(report.numPassedTests, 70)
    for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests']) assert.equal(report[key], 0)
    assert.deepEqual(native.assertBrowserNetworkIsolation(), isolation)
    verifyHashes(owner)
    passed = true
  } catch { process.exitCode = 1 } finally {
    if (database) {
      try { await database.stop(); assert.equal(fs.readdirSync(scratchDir).filter(name => name.startsWith('pg-')).length, 0); cleanup = 'stopped-owned-pg-removed' }
      catch { cleanup = 'stop-failed-data-retained'; passed = false; process.exitCode = 1 }
    }
    try { verifyHashes(owner) } catch { passed = false; process.exitCode = 1 }
    process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal)
    if (interrupted) { passed = false; process.exitCode = 1 }
    // Credentials never appear in this receipt. Scratch and private logs stay
    // available; only the original owned-PG module removes its own PG subtree.
    privateWrite(path.join(evidence, 'receipt.json'), JSON.stringify({ protocol: owner.protocol,
      ownerSha, sourceSha: hash(JSON.stringify(owner.hashes)), passed, cleanup,
      tests: passed ? 70 : 0, sentinels: passed ? 5 : 0, business: passed ? 65 : 0,
      isolatedNetwork: isolation.isolatedNetwork, unixIpcIsolated: false,
      sameProcessHostileCodeIsolated: false, filesystemIsolated: false, result }))
  }
}

async function outer(args, setStage) {
  setStage('ARGUMENTS')
  const { pgBin } = parsePublicArguments(args)
  setStage('RUNTIME')
  assertRuntime()
  setStage('ENVIRONMENT_FILES')
  assertNoEnvironmentFiles([root, backend, path.join(root, 'apps/web')])
  setStage('PATHS')
  plain(root, true); plain(pgBin, true)
  setStage('TOOLS')
  for (const tool of ['/usr/bin/unshare', '/usr/bin/setpriv', '/usr/bin/python3', '/usr/sbin/ip']) {
    // System tools may legitimately be symlinks; they are fixed paths, never caller executables.
    fs.accessSync(tool, fs.constants.X_OK)
  }
  setStage('PATHS')
  const node = fs.realpathSync(process.execPath), cli = requireBackend.resolve('vitest/vitest.mjs')
  assert.equal(process.execPath, node)
  const tmp = path.join(root, 'tmp')
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { mode: 0o700 })
  plain(tmp, true)
  const evidence = path.join(tmp, 'yida-browser-ci-' + randomUUID())
  fs.mkdirSync(evidence, { mode: 0o700 })
  const collector = path.join(evidence, 'collector.mjs')
  privateWrite(collector, COLLECTOR)
  setStage('SOURCE_INTEGRITY')
  const owner = { protocol: 'YIDA_BROWSER_CI_NATIVE_V1', root, runner, helper, preload, native: nativePath,
    node, cli, collector, pgBin, uid: process.getuid(), gid: process.getgid(),
    parentNetworkNamespace: fs.readlinkSync('/proc/self/ns/net'),
    hashes: Object.fromEntries([...sourcePaths(node, cli), collector].map(file => [file, fileHash(file)])) }
  verifyHashes(owner)
  setStage('OWNER')
  const ownerPath = path.join(evidence, 'owner.json'), raw = JSON.stringify(owner), ownerSha = hash(raw)
  privateWrite(ownerPath, raw)
  const argv = ['--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--fork', '--mount-proc',
    '--propagation', 'private', '--kill-child=SIGKILL', '/usr/bin/python3', helper, ownerPath, ownerSha]
  setStage('NAMESPACE')
  const terminal = await capture('/usr/bin/unshare', argv, root, cleanEnvironment(process.env), evidence,
    'namespace', DEADLINE_MS, { ...owner, ownerPath, ownerSha })
  let passed = false
  try {
    verifyHashes(owner)
    const receiptPath = path.join(evidence, 'receipt.json')
    assert(plain(receiptPath, false, 0o600).size < 16384)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.ownerSha, ownerSha); assert.equal(receipt.sourceSha, hash(JSON.stringify(owner.hashes)))
    assert.equal(receipt.cleanup, 'stopped-owned-pg-removed')
    assert.equal(receipt.passed, true); assert.equal(receipt.tests, 70)
    passed = terminal.passed
  } catch { /* Fixed public result only; detail remains in private evidence. */ }
  console.log('YIDA_BROWSER_CI_RESULT ' + JSON.stringify({ passed, tests: passed ? 70 : 0,
    business: passed ? 65 : 0, sentinels: passed ? 5 : 0 }))
  if (!passed) process.exitCode = 1
}

export async function main(args = process.argv.slice(2)) {
  let stage = 'RUNTIME'
  try {
    process.umask(0o077)
    assertRuntime()
    if (args[0] === '--namespace-init' || args[0] === '--worker') {
      stage = 'OWNER'
      assert.equal(args.length, 3)
      const owner = readOwner(args[1], args[2])
      if (args[0] === '--namespace-init') {
        stage = 'NAMESPACE'
        await namespaceInit(owner, args[1], args[2])
      } else {
        stage = 'WORKER'
        await worker(owner, args[1], args[2])
      }
    } else await outer(args, next => { stage = next })
  } catch (error) {
    // Preserve programmatic rejection; the CLI alone publishes the diagnostic.
    const failure = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error : fail('INTERNAL')
    failureStages.set(failure, stage)
    throw failure
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === runner) {
  main().catch(error => { reportStartupFailure(error) })
}
