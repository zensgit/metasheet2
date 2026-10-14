import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HELP, assertSyntheticTrialPlatform, cleanSyntheticTrialEnvironment, parseSyntheticTrialArguments, runSyntheticTrial } from './run-stock-preparation-yida-synthetic-trial.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireCore = createRequire(path.join(repository, 'packages/core-backend/package.json'))
const ts = requireCore('typescript')
const publicSource = readFileSync(new URL('./run-stock-preparation-yida-synthetic-trial.mjs', import.meta.url), 'utf8')
const typedSource = readFileSync(path.join(repository, 'packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts'), 'utf8')
const valid = ['--pg-bin=/usr/lib/postgresql/16/bin', '--ttl-seconds=300']

// Selected declarations are compiled as data, never the typed entry or tsx.
// The cleanup regression below additionally runs real loopback HTTP/WS/Vite
// fixtures in an owned tmp directory; no PG, app startup or external IO runs.
function actualFunction(source, name) {
  const parsed = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.ES2022, true)
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert(declaration)
  return declaration.getText(parsed).replace(/^export\s+/u, '')
}
function compilePure(source, name, bindings) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return new Function(...Object.keys(bindings), output + '\nreturn ' + name)(...Object.values(bindings))
}
function removed(source, exact) {
  assert.equal(source.split(exact).length - 1, 1)
  return source.replace(exact, '')
}
function assertRemovalRed(fn, args) {
  // If removing the actual guard lets the forbidden input through, the original
  // rejection assertion itself must go red (ERR_ASSERTION), in memory only.
  assert.throws(() => assert.throws(() => fn(...args)), { code: 'ERR_ASSERTION' })
}

function actualWorkerHostCleanup(source = typedSource) {
  const parsed = ts.createSourceFile('actual.ts', actualFunction(source, 'ownedWorker'), ts.ScriptTarget.ES2022, true)
  const worker = parsed.statements.find(ts.isFunctionDeclaration)
  const lifetime = worker.body.statements.filter(ts.isTryStatement)
  assert.equal(lifetime.length, 1)
  const cleanup = lifetime[0].finallyBlock.statements.filter(ts.isTryStatement)
  assert.equal(cleanup.length, 1)
  const stops = cleanup[0].tryBlock.statements.slice(0, 2)
  assert(stops.every(ts.isTryStatement))
  const body = stops.map(node => node.getText(parsed)).join('\n')
  assert.equal((body.match(/host\.stop\(/gu) ?? []).length, 1)
  assert.equal((body.match(/preview\?\.close\(/gu) ?? []).length, 1)
  return compilePure('async function stopHosts(host, preview, retainFailure) {\n' + body + '\n}', 'stopHosts', {})
}

test('actual worker drains host before proxy and still closes proxy after a host failure', async () => {
  const cleanup = actualWorkerHostCleanup()
  for (const rejectHost of [false, true]) {
    const order = [], failures = []
    const sentinel = new Error('synthetic host stop failure')
    await cleanup({ stop: async reason => {
      assert.equal(reason, 'YIDA_SYNTHETIC_TRIAL_LOCAL_STOP'); order.push('host')
      if (rejectHost) throw sentinel
    } }, { close: async () => { order.push('proxy') } }, error => failures.push(error))
    assert.deepEqual(order, ['host', 'proxy'])
    assert.deepEqual(failures, rejectHost ? [sentinel] : [])
  }
  const sentinel = new Error('synthetic proxy close failure'), failures = []
  await cleanup({ stop: async () => {} }, { close: async () => { throw sentinel } }, error => failures.push(error))
  assert.deepEqual(failures, [sentinel])
  await cleanup({ stop: async () => {} }, undefined, () => assert.fail('no preview is valid before startup'))
})

test('actual worker cleanup preserves a live proxy for the real WebSocket close handshake', { timeout: 60000 }, async () => {
  const requireWeb = createRequire(path.join(repository, 'apps/web/package.json'))
  const { preview } = await import(pathToFileURL(path.join(path.dirname(requireWeb.resolve('vite/package.json')), 'dist/node/index.js')))
  const { Server: SocketServer } = requireCore('socket.io')
  const { io } = requireWeb('socket.io-client')
  const tempRoot = path.join(repository, 'tmp')
  mkdirSync(tempRoot, { recursive: true })
  const scratch = mkdtempSync(path.join(tempRoot, 'yida-proxy-drain-'))
  assert.equal(path.dirname(scratch), tempRoot)
  mkdirSync(path.join(scratch, 'empty-env')); mkdirSync(path.join(scratch, 'dist'))
  const http = createServer((_request, response) => response.end('synthetic'))
  const sockets = new SocketServer(http)
  let proxy, client, cleanupComplete = false
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    proxy = await preview({ root: scratch, configFile: false, envFile: false, envDir: path.join(scratch, 'empty-env'), logLevel: 'silent',
      build: { outDir: path.join(scratch, 'dist') },
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false, cors: false,
        proxy: { '/socket.io': { target: 'http://127.0.0.1:' + http.address().port, changeOrigin: false, ws: true } } } })
    client = io('http://127.0.0.1:' + proxy.httpServer.address().port, { transports: ['websocket'], reconnection: false })
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
    assert.equal(sockets.engine.clientsCount, 1)
    assert.equal(client.connected, true)
    const failures = [], started = performance.now()
    await actualWorkerHostCleanup()({ stop: () => new Promise((resolve, reject) => {
      void sockets.close(error => error ? reject(error) : resolve()).catch(reject)
    }) }, proxy, error => failures.push(error))
    cleanupComplete = !http.listening && !proxy.httpServer.listening
    assert.deepEqual(failures, [])
    assert.equal(cleanupComplete, true)
    // No shortened WS timeout, early client disconnect, mocks or timer override.
    // The pre-fix order waits for ws's 30s close timeout and fails this assertion.
    assert(performance.now() - started < 10000, 'live proxy must complete the close handshake within the unchanged host barrier')
  } finally {
    client?.disconnect()
    if (http.listening) await sockets.close()
    if (proxy?.httpServer.listening) await proxy.close()
    if (cleanupComplete) rmSync(scratch, { recursive: true })
  }
})

test('actual public parser and help accept only the documented local inputs', async () => {
  assert.deepEqual(parseSyntheticTrialArguments(valid), { help: false, pgBin: '/usr/lib/postgresql/16/bin', ttlSeconds: 300 })
  for (const ttl of [60, 900]) assert.equal(parseSyntheticTrialArguments([valid[0], '--ttl-seconds=' + ttl]).ttlSeconds, ttl)
  assert.deepEqual(parseSyntheticTrialArguments(['--help']), { help: true })
  let output = ''
  const original = process.stdout.write
  let result
  try {
    process.stdout.write = function (bytes) { output += String(bytes); return true }
    result = runSyntheticTrial(['--help'])
  } finally { process.stdout.write = original }
  await result
  assert.equal(output, HELP)
  assert.match(output, /node scripts\/ops\/run-stock-preparation-yida-synthetic-trial\.mjs --pg-bin=/u)
})

test('actual parser rejects internal worker, borrowed DB/env/material, extra and malformed inputs', () => {
  const rejected = [[], ['--help', ...valid], [...valid, '--worker'], ['--worker', '/tmp/borrowed'],
    [valid[1], valid[0]], [valid[0], valid[0]], ['--target=/usr/lib/postgresql/16/bin', valid[1]],
    ['--database-url=postgresql://example.invalid', valid[1]], ['--env-file=/tmp/input', valid[1]],
    ['--material=/tmp/input', valid[1]], ['--pg-bin=relative', valid[1]], ['--pg-bin=C:\\postgres', valid[1]]]
  for (const args of rejected) assert.throws(() => parseSyntheticTrialArguments(args))
  for (const ttl of ['', '0', '59', '901', '0300', '+300', '3e2', '300.0', '300 ', 'NaN', 'Infinity']) {
    assert.throws(() => parseSyntheticTrialArguments([valid[0], '--ttl-seconds=' + ttl]))
  }
})

test('removing each actual public argument guard makes its rejection contract red', () => {
  const source = actualFunction(publicSource, 'parseSyntheticTrialArguments')
  const cases = [
    ['assert.equal(args.length, 2)', [[...valid, '--worker']]],
    ["assert(args[0].startsWith('--pg-bin=') && args[1].startsWith('--ttl-seconds='))", [['--target=/usr/lib/postgresql/16/bin', valid[1]]]],
    ['assert(path.posix.isAbsolute(pgBin))', [['--pg-bin=relative', valid[1]]]],
    ['assert(/^[1-9][0-9]*$/u.test(ttlText) && Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 900)', [[valid[0], '--ttl-seconds=59']]],
  ]
  for (const [guard, args] of cases) {
    const mutant = compilePure(removed(source, guard), 'parseSyntheticTrialArguments', { assert, path })
    assertRemovalRed(mutant, args)
  }
})

test('actual platform guard rejects Windows and both root identities; finite removals are red', () => {
  assertSyntheticTrialPlatform('linux', 1000, 1000)
  assert.throws(() => assertSyntheticTrialPlatform('win32', 1000, 1000))
  assert.throws(() => assertSyntheticTrialPlatform('linux', 0, 1000))
  assert.throws(() => assertSyntheticTrialPlatform('linux', 1000, 0))
  const source = actualFunction(publicSource, 'assertSyntheticTrialPlatform')
  for (const [guard, args] of [["assert.equal(platform, 'linux')", ['win32', 1000, 1000]], ['assert(uid > 0 && gid > 0)', ['linux', 0, 1000]]]) {
    assertRemovalRed(compilePure(removed(source, guard), 'assertSyntheticTrialPlatform', { assert }), args)
  }
})

test('public entry is same-process fixed tsx registration and help precedes runtime imports', () => {
  const body = actualFunction(publicSource, 'runSyntheticTrial')
  assert(body.indexOf('if (options.help)') < body.indexOf('assertSyntheticTrialPlatform()'))
  assert(body.indexOf('assertSyntheticTrialPlatform()') < body.indexOf('cleanSyntheticTrialEnvironment(process.env)'))
  assert(body.indexOf('delete process.env[key]') < body.indexOf("requireCore.resolve('tsx/esm/api')"))
  assert.match(body, /const unregister = register\(\)/u)
  assert.match(body, /try \{ await import\(pathToFileURL\(typedEntry\)\.href\) \}/u)
  assert.match(body, /finally \{ await unregister\(\) \}/u)
  assert(!/child_process|spawn\(|exec\(|process\.argv\s*=/u.test(publicSource))
  assert.match(publicSource, /packages\/core-backend\/scripts\/run-stock-preparation-yida-synthetic-trial\.mts/u)
})

test('actual pre-tsx environment view strips ambient DB/send/loader inputs; guard removals are red', () => {
  const input = { PATH: '/usr/bin', HOME: '/home/synthetic', TMP: '/tmp', path: '/bin', TEMP: undefined,
    DATABASE_URL: 'synthetic-disallowed', INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'true', TSX_TSCONFIG_PATH: '/tmp/disallowed', NODE_OPTIONS: '--disallowed' }
  const expected = { PATH: '/usr/bin', HOME: '/home/synthetic', TMP: '/tmp', path: '/bin' }
  assert.deepEqual(cleanSyntheticTrialEnvironment(input), expected)
  const source = actualFunction(publicSource, 'cleanSyntheticTrialEnvironment')
  const whitelist = "['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME'].includes(key.toUpperCase())"
  for (const mutantSource of [source.replace(whitelist, 'true'), removed(source, "&& typeof value === 'string'")]) {
    assert.notEqual(mutantSource, source)
    const mutant = compilePure(mutantSource, 'cleanSyntheticTrialEnvironment', {})
    assert.throws(() => assert.deepEqual(mutant(input), expected), { code: 'ERR_ASSERTION' })
  }
})

test('actual cancellation closure keeps a pre-READY stop latched; guard removals are red', () => {
  const source = actualFunction(typedSource, 'parentCancellation')
  const exercise = candidate => {
    const events = new EventEmitter()
    const cancellation = compilePure(candidate, 'parentCancellation', { assert, process: events })()
    try {
      assert.equal(events.listenerCount('SIGINT'), 1); assert.equal(events.listenerCount('SIGTERM'), 1)
      cancellation.checkpoint()
      let stops = 0
      const unbind = cancellation.bind(() => { stops++ })
      cancellation.requestStop(); unbind()
      assert.equal(stops, 1); assert(cancellation.wasCancelledBeforeReady())
      assert.throws(() => cancellation.checkpoint())
      assert.throws(() => cancellation.markReady())
      cancellation.bind(() => { stops++ })()
      assert.equal(stops, 2)
    } finally { cancellation.dispose() }
    assert.equal(events.listenerCount('SIGINT'), 0); assert.equal(events.listenerCount('SIGTERM'), 0)
  }
  exercise(source)
  for (const guard of ["assert(!cancelled, 'YIDA_SYNTHETIC_TRIAL_CANCELLED')", "assert(!cancelled && !ready, 'YIDA_SYNTHETIC_TRIAL_CANCELLED')"]) {
    assert.throws(() => exercise(removed(source, guard)), { code: 'ERR_ASSERTION' })
  }
})

test('actual handoff stat guard rejects foreign inode, links and public mode; removal is red', () => {
  const source = actualFunction(typedSource, 'assertHandoffFileInfo')
  const guard = compilePure(source, 'assertHandoffFileInfo', { assert })
  const info = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o600, dev: 11, ino: 22 }
  const identity = { dev: 11, ino: 22 }
  guard(info, identity)
  for (const changed of [{ ino: 23 }, { dev: 12 }, { nlink: 2 }, { mode: 0o644 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    assert.throws(() => guard({ ...info, ...changed }, identity))
  }
  const assertion = 'assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0\n    && info.dev === identity.dev && info.ino === identity.ino)'
  assertRemovalRed(compilePure(removed(source, assertion), 'assertHandoffFileInfo', { assert }), [{ ...info, ino: 23 }, identity])
})

test('migrated worker retains fixed OFF/bootstrap/build/loopback and independent handoff cleanup wiring', () => {
  const parent = actualFunction(typedSource, 'ownedParent'), worker = actualFunction(typedSource, 'ownedWorker'), child = actualFunction(typedSource, 'child')
  const presentBefore = (source, before, after, last = false) => {
    const beforeIndex = last ? source.lastIndexOf(before) : source.indexOf(before)
    const afterIndex = last ? source.lastIndexOf(after) : source.indexOf(after)
    assert(beforeIndex >= 0 && afterIndex >= 0 && beforeIndex < afterIndex)
  }
  assert.match(parent, /startOwnedPostgres\(\{ repoRoot: root, scratchDir: scratch, pgBin, env \}\)/u)
  assert.match(parent, /if \(startedDatabase\) await startedDatabase\.stop\(\)/u)
  assert.match(parent, /INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'false'/u)
  assert.match(parent, /MULTITABLE_STOCK_PREP_(?:ERP|PLM)_AUTOPERSIST_ENABLED: 'false'/u)
  assert.match(parent, /const env = clean\(process\.env\)/u)
  assert.match(parent, /'--require', guardPath/u)
  assert.match(parent, /'--worker', scratch, String\(ttlSeconds\), String\(migrationCount\)/u)
  assert.match(child, /if \(bytes\.toString\('utf8'\)\.trim\(\) === 'stop'\) cancellation\.requestStop\(\)/u)
  presentBefore(child, 'assert(!stopRequested && !invalid', 'cancellation.markReady()')
  const withoutLateReadyGuard = removed(child, "assert(!stopRequested && !invalid, 'YIDA_SYNTHETIC_TRIAL_LATE_READY')")
  assert.throws(() => presentBefore(withoutLateReadyGuard, 'assert(!stopRequested && !invalid', 'cancellation.markReady()'), { code: 'ERR_ASSERTION' })
  assert.match(child, /proc\.once\('close',/u)
  assert.match(child, /await custody\?\.closed\(\)/u)
  assert.match(worker, /await configureThroughOwnerHttp/u)
  assert.match(worker, /SET TRANSACTION ISOLATION LEVEL READ COMMITTED/u)
  assert.match(worker, /envFile: false/u)
  assert.match(worker, /host: '127\.0\.0\.1', port: 0, strictPort: true, open: false/u)
  assert.match(worker, /constants\.O_RDWR \| constants\.O_NOFOLLOW/u)
  assert.match(worker, /finally \{\s*\/\/ Independent[\s\S]*?try \{ await removeOwnedHandoff\(scratch, handoffIdentity\) \}/u)
  presentBefore(worker, 'if (failed) throw original', "emit('STOPPED')", true)
  const withoutFailureThrow = removed(worker, 'if (failed) throw original')
  assert.throws(() => presentBefore(withoutFailureThrow, 'if (failed) throw original', "emit('STOPPED')", true), { code: 'ERR_ASSERTION' })
  assert.match(worker, /prototype: false, localSyntheticTrial: true, syntheticOnly: true, defaultOff: true/u)
  assert.match(parent, /acceptancePassed: false/u)
  assert.match(child, /bootstrapParentNodeGuardAttested: false, browserNetworkAttested: false/u)
  // These are static wiring checks only, not a lifecycle/namespace/full-app pass.
})

test('actual trial identity uses a short login while owner, tenant and password stay fresh', () => {
  const worker = actualFunction(typedSource, 'ownedWorker')
  const parsed = ts.createSourceFile('actual.ts', worker, ts.ScriptTarget.ES2022, true)
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node))
  const identityDeclarations = declaration.body.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ['identifier', 'password'].includes(item.name.getText(parsed))))
  assert.equal(identityDeclarations.length, 2)
  const actual = identityDeclarations.map(node => node.getText(parsed)).join('\n')
  const exercise = source => {
    // Run only the actual identity-producing declarations, using real crypto;
    // importing the complete worker here would start PG and the HTTP host.
    const produce = new Function('randomUUID', 'randomBytes', source + '\nreturn { owner, tenant, identifier, password }')
    const owners = new Set(), tenants = new Set(), passwords = new Set()
    for (let index = 0; index < 32; index++) {
      const identity = produce(randomUUID, randomBytes)
      assert.equal(identity.identifier, 'trial@example.invalid')
      assert.match(identity.owner, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
      assert.match(identity.tenant, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
      assert.notEqual(identity.owner, identity.tenant)
      assert.match(identity.password, /^[A-Za-z0-9_-]{32}$/u)
      owners.add(identity.owner); tenants.add(identity.tenant); passwords.add(identity.password)
    }
    assert.equal(owners.size, 32); assert.equal(tenants.size, 32); assert.equal(passwords.size, 32)
  }
  exercise(actual)
  for (const [before, after] of [
    ["'trial@example.invalid'", "'unexpected@example.invalid'"],
    ["randomBytes(24).toString('base64url')", "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
    ['owner = randomUUID()', "owner = '11111111-1111-4111-8111-111111111111'"],
    ['tenant = randomUUID()', "tenant = '22222222-2222-4222-8222-222222222222'"],
  ]) {
    assert.equal(actual.split(before).length, 2)
    assert.throws(() => exercise(actual.replace(before, after)), { code: 'ERR_ASSERTION' })
  }
})

test('strict config checks actual transitive declarations without emitted files or stub types', () => {
  const config = JSON.parse(readFileSync(path.join(repository, 'packages/core-backend/scripts/tsconfig.stock-preparation-yida-synthetic-trial.json'), 'utf8'))
  assert.deepEqual(config.include, ['run-stock-preparation-yida-synthetic-trial.mts'])
  assert(config.compilerOptions.strict && config.compilerOptions.noEmit && config.compilerOptions.allowJs)
  assert.equal(config.compilerOptions.checkJs, false); assert.equal(config.compilerOptions.skipLibCheck, true)
  assert.deepEqual(config.compilerOptions.types, ['node'])
  assert.match(typedSource, /import type \{ Pool \} from 'pg'/u)
  assert.match(typedSource, /import type \{ PreviewServer \} from '\.\.\/\.\.\/\.\.\/apps\/web\/node_modules\/vite'/u)
  assert(!/declare module|@ts-ignore|@ts-nocheck/u.test(typedSource))
})
