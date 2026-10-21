import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { cleanEnvironment, runAcceptance } from './run-stock-preparation-plm-full-app.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const sourcePath = 'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs'
const source = readFileSync(path.join(repository, sourcePath), 'utf8')
const read = name => readFileSync(path.join(repository, name), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// Run the current public entry in a real Node process. Only native platform
// observations are simulated; actual argument parsing, imports, source hashes,
// owner/preload writes and owner verification execute before the fixed spawn.
// The spawn observer throws BEFORE unshare/PG/browser can run. The ESM loader
// observes the original cleaner's identity, or adds only the old static edge.
function publicCliProbe(staticCycle = false) {
  const nonce = randomUUID(), directory = path.join(repository, 'tmp', 'stock-preparation-plm-cli-cycle-' + nonce)
  mkdirSync(directory, { recursive: true })
  const runner = path.join(repository, 'scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const namespace = path.join(repository, 'scripts/ops/lib/stock-preparation-plm-namespace.mjs')
  const ownedDirectory = path.join(repository, 'tmp', 'stock-preparation-plm-full-app-namespace-' + nonce)
  const preload = path.join(directory, 'native-observer.cjs'), loader = path.join(directory, 'cycle-observer.mjs')
  const environment = cleanEnvironment(process.env)
  writeFileSync(preload, `
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const crypto = require('node:crypto'), children = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const repository = ${JSON.stringify(repository)}, ownedDirectory = ${JSON.stringify(ownedDirectory)}
const expectedEnvironment = ${JSON.stringify(environment)}
Object.defineProperty(process, 'platform', { value: 'linux' })
Object.defineProperty(process.versions, 'node', { value: '20.20.2' })
process.getuid = () => 1000; process.getgid = () => 1000
crypto.randomUUID = () => ${JSON.stringify(nonce)}
const realRead = fs.readFileSync.bind(fs), realWrite = fs.writeFileSync.bind(fs), realMkdir = fs.mkdirSync.bind(fs)
const executable = fs.realpathSync(process.execPath)
fs.readFileSync = (file, ...args) => file === executable ? Buffer.from([127, 69, 76, 70, 0, 1, 2, 3]) : realRead(file, ...args)
fs.readlinkSync = file => { assert.equal(file, '/proc/self/ns/net'); return 'net:[123]' }
fs.mkdirSync = (target, ...args) => {
  assert([path.join(repository, 'tmp'), ownedDirectory].includes(target), 'unexpected directory write')
  return realMkdir(target, ...args)
}
fs.writeFileSync = (target, ...args) => {
  assert([path.join(ownedDirectory, 'owner.json'), path.join(ownedDirectory, 'worker-preload.cjs')].includes(target), 'unexpected file write')
  return realWrite(target, ...args)
}
process.env.NODE_OPTIONS = '--synthetic-ambient-node-option'
process.env.DATABASE_URL = 'synthetic-denied-database'
process.env.NODE_ENV = 'production'
children.spawn = (command, args, options) => {
  assert.equal(command, '/usr/bin/unshare')
  const ownerBytes = realRead(path.join(ownedDirectory, 'owner.json'))
  const ownerSha256 = crypto.createHash('sha256').update(ownerBytes).digest('hex')
  assert.deepEqual(args, ['--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--fork',
    '--mount-proc', '--propagation', 'private', '--kill-child=SIGKILL', '/usr/bin/python3',
    path.join(repository, 'scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py'), repository,
    ${JSON.stringify(nonce)}, ownerSha256])
  assert.deepEqual(options, { env: expectedEnvironment, cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write('PLM_FULL_APP_CLI_FIXED_LAUNCHER_BOUNDARY\\n')
  throw new Error('PLM_FULL_APP_TEST_NATIVE_BOUNDARY_STOP')
}
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork']) children[name] = () => { throw new Error('unexpected native launch') }
syncBuiltinESMExports()
`, { flag: 'wx' })
  writeFileSync(loader, `
import assert from 'node:assert/strict'
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url === ${JSON.stringify(pathToFileURL(runner).href)}) {
    const needle = 'if (process.argv[1] && path.resolve(process.argv[1]) === filename) {'
    const source = result.source.toString()
    assert.equal(source.split(needle).length - 1, 1)
    return { ...result, source: source.replace(needle, 'globalThis.__plmOriginalCleaner = cleanEnvironment;\\n' + needle) }
  }
  if (url === ${JSON.stringify(pathToFileURL(namespace).href)}) {
    const needle = 'export async function launchFullAppNamespace(options, cleanEnvironment) {'
    let source = result.source.toString()
    assert.equal(source.split(needle).length - 1, 1)
    source = source.replace(needle, needle + "\\n  assert.equal(cleanEnvironment, globalThis.__plmOriginalCleaner);\\n  console.log('PLM_FULL_APP_CLI_ORIGINAL_CLEANER_VERIFIED')")
    if (${JSON.stringify(staticCycle)}) source = "import { cleanEnvironment } from '../run-stock-preparation-plm-full-app.mjs'\\n" + source
    return { ...result, source }
  }
  return result
}
`, { flag: 'wx' })
  const registration = 'import { register } from "node:module"; register(' + JSON.stringify(pathToFileURL(loader).href) + ');'
  const result = spawnSync(process.execPath, ['--require', preload, '--import',
    'data:text/javascript,' + encodeURIComponent(registration), runner,
    '--pg-bin=' + path.join(directory, 'synthetic-postgresql', 'bin'), '--automation-scenario=manual'],
  { cwd: repository, env: environment, windowsHide: true, timeout: 10000, encoding: 'utf8' })
  for (const stream of ['stdout', 'stderr']) writeFileSync(path.join(directory, stream + '.raw.log'), result[stream] ?? '', { flag: 'wx' })
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ staticCycle, status: result.status,
    signal: result.signal, sourceHashes: [runner, namespace, fileURLToPath(import.meta.url)].map(file => ({
      path: path.relative(repository, file).replaceAll('\\', '/'), sha256: hash(readFileSync(file)),
    })) }, null, 2) + '\n', { flag: 'wx' })
  return result
}
function assertPublicCliReachedLauncher(result) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'PLM_FULL_APP_CLI_ORIGINAL_CLEANER_VERIFIED\nPLM_FULL_APP_CLI_FIXED_LAUNCHER_BOUNDARY\n')
  assert.equal(result.stderr, 'PLM_FULL_APP_ARGUMENT_OR_SETUP_FAILED\n')
}
test('actual public CLI reaches the fixed launcher with the unique original cleaner and washed environment', t => {
  const result = publicCliProbe()
  assertPublicCliReachedLauncher(result)
  t.diagnostic(JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }))
})
test('restoring the static namespace-to-runner edge makes the same actual public CLI regression red with exit 13', t => {
  const result = publicCliProbe(true)
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 13)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.throws(() => assertPublicCliReachedLauncher(result), error => error.code === 'ERR_ASSERTION')
  t.diagnostic(JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    samePublicCliRegression: 'red' }))
})

// Execute the actual source under a values-free in-memory filesystem. Kernel
// isolation itself is exercised by the separate real snapshot contracts; this
// fixture proves owner/hash/preload/WeakSet and spawn argument guards only.
function fixture(transform = text => text) {
  const repoRoot = '/synthetic-repository', nonce = randomUUID(), selectedNode = '/synthetic-node20'
  const files = new Map(), directories = new Set([repoRoot, repoRoot + '/tmp',
    repoRoot + '/tmp/stock-preparation-plm-full-app-namespace-' + nonce])
  const paths = require('./lib/stock-preparation-plm-namespace-scope.cjs').SOURCE_PATHS
  for (const name of paths) files.set(repoRoot + '/' + name, Buffer.from(read(name)))
  files.set(selectedNode, Buffer.from([127, 69, 76, 70, 0, 1, 2, 3]))
  let installed = true, calls = 0
  const guard = {
    assertBrowserNetworkIsolation() { calls++; assert(installed, 'PLM_BROWSER_ISOLATION_REQUIRED'); return { isolatedNetwork: true } },
    installBrowserNetworkIsolation(parent) { assert.equal(parent, 'net:[123]'); installed = true },
  }
  const fakeFs = {
    realpathSync(target) { assert(files.has(target) || directories.has(target), 'synthetic missing path'); return target },
    lstatSync(target) { assert(files.has(target) || directories.has(target), 'synthetic missing path'); return {
      isSymbolicLink: () => false, isDirectory: () => directories.has(target), isFile: () => files.has(target),
      nlink: 1, size: files.get(target)?.length ?? 0,
    } },
    readFileSync(target) { assert(files.has(target), 'synthetic missing file'); return Buffer.from(files.get(target)) },
  }
  const pinned = { id: 'upstream-1719529', executablePath: '/synthetic-browser', sha256: '1'.repeat(64),
    version: '158.0.8107.0', localOnly: true }
  const context = { module: { exports: {} }, Buffer, __dirname: repoRoot + '/scripts/ops/lib',
    process: { execPath: selectedNode, versions: { node: '20.20.2' }, getuid: () => 1000 },
    require(name) { return name === 'node:fs' ? fakeFs : name === 'node:path' ? path.posix
      : name === './stock-preparation-browser-network-isolation.cjs' ? guard
        : name === './stock-preparation-yida-browser-candidate.cjs' ? { pinnedBrowserForRoot(root, id) {
          assert.equal(root, repoRoot)
          if (id === undefined) return undefined
          assert.equal(id, pinned.id)
          return context.__parseCandidate(JSON.stringify(pinned))
        } } : require(name) },
  }
  runInNewContext('globalThis.__parseCandidate = text => JSON.parse(text)', context)
  runInNewContext(transform(source), context, { filename: sourcePath, timeout: 1000 })
  const api = context.module.exports
  const owner = { owner: 'PLM_FULL_APP_NAMESPACE', nonce, repoRoot, pid: 800, uid: 1000,
    parentNamespace: 'net:[123]', node: selectedNode, nodeSha256: hash(files.get(selectedNode)),
    pgBin: '/synthetic-postgresql14/bin', automationScenario: 'manual',
    sources: paths.map(name => ({ path: name, sha256: hash(files.get(repoRoot + '/' + name)) })) }
  const directory = repoRoot + '/tmp/stock-preparation-plm-full-app-namespace-' + nonce
  const writeOwner = () => {
    const bytes = Buffer.from(JSON.stringify(owner) + '\n')
    files.set(directory + '/owner.json', bytes)
    const config = { repoRoot, nonce, ownerSha256: hash(bytes) }
    const preload = api.preloadBytes(config)
    files.set(directory + '/worker-preload.cjs', preload)
    return { ...config, preloadSha256: hash(preload) }
  }
  return { api, owner, files, repoRoot, directory, writeOwner, pinned,
    setInstalled(value) { installed = value }, get nativeCalls() { return calls } }
}

test('installed candidate is absent only in a valid default scope, never an uninstalled scope', () => {
  const f = fixture()
  assert.throws(() => f.api.installedBrowserCandidate(), /CAPABILITY_REQUIRED/)
  f.api.installOwnedNamespacePreload(f.writeOwner())
  assert.equal(f.api.installedBrowserCandidate(), undefined)
})

test('PLM owner binds the full candidate metadata and revalidates before browser selection', () => {
  const f = fixture()
  f.owner.browserCandidate = { ...f.pinned }
  f.api.installOwnedNamespacePreload(f.writeOwner())
  assert.equal(JSON.stringify(f.api.installedBrowserCandidate()), JSON.stringify(f.pinned))
  f.files.set(f.directory + '/owner.json', Buffer.from('tampered synthetic owner'))
  assert.throws(() => f.api.installedBrowserCandidate(), /OWNER_HASH_MISMATCH/)
  for (const field of ['id', 'executablePath', 'sha256', 'version', 'localOnly']) {
    const bad = fixture()
    bad.owner.browserCandidate = { ...bad.pinned, [field]: field === 'localOnly' ? false : 'wrong' }
    assert.throws(() => bad.api.scopeFromOwner(bad.writeOwner()))
  }
})

test('formal runAcceptance refuses an uninstalled scope before scratch/build/PG', async () => {
  await assert.rejects(() => runAcceptance({ pgBin: '/synthetic-postgresql/bin', automationScenario: 'manual' }),
    /PLM_FULL_APP_NAMESPACE_CAPABILITY_REQUIRED/)
  assert.throws(() => require('./lib/stock-preparation-browser-network-isolation.cjs').assertBrowserNetworkIsolation(),
    /PLM_BROWSER_ISOLATION_REQUIRED/)
})
test('actual owner capability validates exact closed owner/source/preload and internal argv', () => {
  const f = fixture(), config = f.writeOwner(), scope = f.api.scopeFromOwner(config)
  assert.deepEqual(Array.from(f.api.namespaceChildArguments(scope)), ['--require', f.directory + '/worker-preload.cjs'])
  assert.equal(f.api.namespaceArgument(scope), `--plm-full-app-namespace=${config.nonce}:${config.ownerSha256}:${config.preloadSha256}`)
  const decoded = f.api.decodeScope(f.repoRoot, f.api.namespaceArgument(scope))
  assert.equal(decoded.ownerSha256, config.ownerSha256)
  f.setInstalled(false)
  assert.throws(() => f.api.namespaceChildArguments(scope), /PLM_BROWSER_ISOLATION_REQUIRED/)
  assert.throws(() => f.api.namespaceArgument(scope), /PLM_BROWSER_ISOLATION_REQUIRED/)
})
const negativeContracts = [
  ['private capability identity', "  assert(scope && registered.has(scope), 'PLM_FULL_APP_NAMESPACE_CAPABILITY_REQUIRED')",
    f => { const scope = f.api.scopeFromOwner(f.writeOwner()); return () => f.api.assertOwnedNamespaceScope({ ...scope }) },
    /PLM_FULL_APP_NAMESPACE_CAPABILITY_REQUIRED/],
  ['owner identity', "  assert(owner.owner === 'PLM_FULL_APP_NAMESPACE' && owner.repoRoot === repoRoot && owner.nonce === nonce,\n    'PLM_FULL_APP_NAMESPACE_OWNER_MISMATCH')",
    f => { f.owner.owner = 'NOT_THE_OWNER'; const config = f.writeOwner(); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_OWNER_MISMATCH/],
  ['source hash', "    assert.equal(hash(fs.readFileSync(source)), row.sha256, 'PLM_FULL_APP_NAMESPACE_SOURCE_CHANGED')",
    f => { const config = f.writeOwner(); f.files.set(f.repoRoot + '/' + f.owner.sources[0].path, Buffer.from('changed synthetic source')); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_SOURCE_CHANGED/],
  ['preload bytes', "  assert(fs.readFileSync(preloadPath).equals(expected), 'PLM_FULL_APP_NAMESPACE_PRELOAD_CHANGED')",
    f => { const config = f.writeOwner(); f.files.set(f.directory + '/worker-preload.cjs', Buffer.from('changed synthetic preload')); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_PRELOAD_CHANGED/],
  ['preload hash', "  assert(preloadSha256 === undefined || preloadSha256 === expectedSha256,\n    'PLM_FULL_APP_NAMESPACE_PRELOAD_HASH_MISMATCH')",
    f => { const config = { ...f.writeOwner(), preloadSha256: '0'.repeat(64) }; return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_PRELOAD_HASH_MISMATCH/],
  ['owner hash', "  assert.equal(hash(bytes), ownerSha256, 'PLM_FULL_APP_NAMESPACE_OWNER_HASH_MISMATCH')",
    f => { const config = f.writeOwner(); f.files.set(f.directory + '/owner.json', Buffer.from(JSON.stringify(f.owner) + ' \n')); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_OWNER_HASH_MISMATCH/],
  ['live native namespace before every spawn', '  return native.assertBrowserNetworkIsolation()',
    f => { const scope = f.api.scopeFromOwner(f.writeOwner()); f.setInstalled(false); return () => f.api.namespaceChildArguments(scope) },
    /PLM_BROWSER_ISOLATION_REQUIRED/],
  ['scope owner UID', "  assert.equal(process.getuid?.(), scope.owner.uid, 'PLM_FULL_APP_NAMESPACE_UID_MISMATCH')",
    f => { f.owner.uid = 1001; const scope = f.api.scopeFromOwner(f.writeOwner()); return () => f.api.namespaceChildArguments(scope) },
    /PLM_FULL_APP_NAMESPACE_UID_MISMATCH/],
  ['CLI selected Node identity', "  assert.equal(fs.realpathSync(process.execPath), owner.node, 'PLM_FULL_APP_NAMESPACE_NODE_MISMATCH')",
    f => { f.files.set('/different-synthetic-node20', Buffer.from(f.files.get('/synthetic-node20'))); f.owner.node = '/different-synthetic-node20';
      const config = f.writeOwner(); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_NODE_MISMATCH/],
  ['CLI selected Node bytes', "  assert.equal(hash(executable), owner.nodeSha256, 'PLM_FULL_APP_NAMESPACE_NODE_HASH_MISMATCH')",
    f => { f.owner.nodeSha256 = '0'.repeat(64); const config = f.writeOwner(); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_NODE_HASH_MISMATCH/],
  ['Linux ELF executable', "  assert(executable.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'PLM_FULL_APP_NAMESPACE_ELF_REQUIRED')",
    f => { f.files.set('/synthetic-node20', Buffer.from('not a Linux executable')); f.owner.nodeSha256 = hash(f.files.get('/synthetic-node20'));
      const config = f.writeOwner(); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_ELF_REQUIRED/],
  ['closed source inventory order', "  assert.deepEqual(owner.sources.map(row => row.path), SOURCE_PATHS, 'PLM_FULL_APP_NAMESPACE_SOURCE_INVENTORY_INVALID')",
    f => { f.owner.sources.reverse(); const config = f.writeOwner(); return () => f.api.scopeFromOwner(config) },
    /PLM_FULL_APP_NAMESPACE_SOURCE_INVENTORY_INVALID/],
]
for (const [name, guard, arrange, expected] of negativeContracts) {
  test('actual source rejects ' + name, () => assert.throws(arrange(fixture()), expected))
  test('removing ' + name + ' makes its own contract red', () => {
    const count = source.split(guard).length - 1
    assert(count === 1 || name === 'scope owner UID' && count === 2, 'mutation needle must occur in the intended guards only')
    const mutated = fixture(text => text.replace(guard, ''))
    assert.throws(() => assert.throws(arrange(mutated), expected), error => error.code === 'ERR_ASSERTION')
  })
}
test('wrong canonical root, unknown argv, shifted nonce, owner UID and source inventory fail closed', () => {
  const f = fixture(), config = f.writeOwner()
  assert.throws(() => f.api.scopeFromOwner({ ...config, repoRoot: '/' }), /synthetic missing path/)
  assert.throws(() => f.api.decodeScope(f.repoRoot, '--allow-unisolated=true'), /DESCRIPTOR_INVALID/)
  assert.throws(() => f.api.scopeFromOwner({ ...config, nonce: randomUUID() }), /synthetic missing path/)
  f.owner.uid = 1001
  assert.throws(() => f.api.assertOwnedNamespaceScope(f.api.scopeFromOwner(f.writeOwner())), /UID_MISMATCH/)
  f.owner.sources.reverse()
  assert.throws(() => f.api.scopeFromOwner(f.writeOwner()), /SOURCE_INVENTORY_INVALID/)
})
function assertFixedVerifierChildren(configured) {
  assert.equal(configured.split('...namespaceAuthority.namespaceChildArguments(namespaceScope)').length - 1, 3,
    'PLM_FULL_APP_FIXED_CHILD_NAMESPACE_COUNT_INVALID')
  assert.equal((configured.match(/spawn\(process\.execPath,/gu) ?? []).length, 3,
    'PLM_FULL_APP_FIXED_CHILD_SPAWN_COUNT_INVALID')
  const guarded = [...configured.matchAll(/spawn\(process\.execPath, \[\.\.\.namespaceAuthority\.namespaceChildArguments\(namespaceScope\),\s*'--require', path\.join\(root, 'scripts\/ops\/lib\/stock-preparation-plm-network-guard\.cjs'\),\s*'--import', pathToFileURL\(coreRequire\.resolve\('tsx'\)\)\.href,\s*path\.join\(root, '(packages\/core-backend\/tests\/utils\/[^']+)'\)\],\s*\{ env: childEnv, cwd: scratch, windowsHide: true, stdio: \['pipe', 'pipe', 'pipe'\] \}\)/gu)]
  assert.deepEqual(guarded.map(match => match[1]), [
    'packages/core-backend/tests/utils/stock-preparation-plm-full-app-ui.mts',
    'packages/core-backend/tests/utils/stock-preparation-yida-initialization-full-app-ui.mts',
    'packages/core-backend/tests/utils/stock-preparation-plm-full-app-sockets.mts',
  ], 'PLM_FULL_APP_FIXED_CHILD_GUARDED_ENTRIES_INVALID')
}

test('fixed verifier children require all three original namespace, network, entry and pipe bindings', () => {
  assertFixedVerifierChildren(read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts'))
})

test('fixed verifier topology mutations reject removal or replacement at every individual child', () => {
  const configured = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  const begins = [...configured.matchAll(/spawn\(process\.execPath,/gu)].map(match => match.index)
  assert.equal(begins.length, 3)
  for (const [ordinal, begin] of begins.entries()) {
    const end = begins[ordinal + 1] ?? configured.length
    const section = configured.slice(begin, end)
    const mutate = (before, after) => {
      assert(section.includes(before)); return configured.slice(0, begin) + section.replace(before, after) + configured.slice(end)
    }
    for (const [name, before, after] of [
      ['namespace', '...namespaceAuthority.namespaceChildArguments(namespaceScope),', ''],
      ['network-guard', 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs', 'scripts/ops/lib/foreign.cjs'],
      ['tsx', "coreRequire.resolve('tsx')", "coreRequire.resolve('foreign')"],
      ['owned-environment', 'env: childEnv', 'env: process.env'],
      ['scratch', 'cwd: scratch', 'cwd: root'],
      ['pipes', "stdio: ['pipe', 'pipe', 'pipe']", "stdio: ['inherit', 'pipe', 'pipe']"],
    ]) {
      assert.throws(() => assertFixedVerifierChildren(mutate(before, after)))
      console.log(`YIDA_INIT_TOPOLOGY_MUTATION child-${ordinal} ${name}: actual-source changed binding rejected`)
    }
    const entry = /path\.join\(root, '(packages\/core-backend\/tests\/utils\/[^']+)'\)/u.exec(section)?.[1]
    assert(entry)
    assert.throws(() => assertFixedVerifierChildren(mutate(entry, 'packages/core-backend/tests/utils/foreign.mts')))
    console.log(`YIDA_INIT_TOPOLOGY_MUTATION child-${ordinal} fixed-entry: actual-source changed binding rejected`)
  }
  const lengthGuard = "assert.equal(configured.split('...namespaceAuthority.namespaceChildArguments(namespaceScope)').length - 1, 3,\n    'PLM_FULL_APP_FIXED_CHILD_NAMESPACE_COUNT_INVALID')"
  const checker = assertFixedVerifierChildren.toString()
  assert(checker.includes(lengthGuard))
  const removed = Function('assert', checker.replace(lengthGuard, 'void 0') + '\nreturn assertFixedVerifierChildren')(assert)
  const commentSpoof = configured + '\n// ...namespaceAuthority.namespaceChildArguments(namespaceScope)\n'
  assert.throws(() => assertFixedVerifierChildren(commentSpoof))
  assert.throws(() => assert.throws(() => removed(commentSpoof)), assert.AssertionError)
  console.log('YIDA_INIT_TOPOLOGY_MUTATION exact-three-namespace: original rejects; removed guard rejection contract RED')
  const spawnGuard = "assert.equal((configured.match(/spawn\\(process\\.execPath,/gu) ?? []).length, 3,\n    'PLM_FULL_APP_FIXED_CHILD_SPAWN_COUNT_INVALID')"
  assert(checker.includes(spawnGuard))
  const noSpawnCount = Function('assert', checker.replace(spawnGuard, 'void 0') + '\nreturn assertFixedVerifierChildren')(assert)
  const extraSpawn = configured + '\n// spawn(process.execPath,\n'
  assert.throws(() => assertFixedVerifierChildren(extraSpawn))
  assert.throws(() => assert.throws(() => noSpawnCount(extraSpawn)), assert.AssertionError)
  console.log('YIDA_INIT_TOPOLOGY_MUTATION exact-three-spawns: original rejects; removed guard rejection contract RED')
  const entryGuard = checker.slice(checker.indexOf('assert.deepEqual(guarded.map'), checker.lastIndexOf('\n}'))
  assert(entryGuard.includes('PLM_FULL_APP_FIXED_CHILD_GUARDED_ENTRIES_INVALID'))
  const noEntryBinding = Function('assert', checker.replace(entryGuard, 'void 0') + '\nreturn assertFixedVerifierChildren')(assert)
  const foreignGuard = configured.replace('scripts/ops/lib/stock-preparation-plm-network-guard.cjs', 'scripts/ops/lib/foreign.cjs')
  assert.throws(() => assertFixedVerifierChildren(foreignGuard))
  assert.throws(() => assert.throws(() => noEntryBinding(foreignGuard)), assert.AssertionError)
  console.log('YIDA_INIT_TOPOLOGY_MUTATION fixed-guarded-entry-list: original rejects; removed guard rejection contract RED')
})

test('formal topology is whole runner and fixed PID1, not browser-only host-DB attachment', () => {
  const outer = read('scripts/ops/lib/stock-preparation-plm-namespace.mjs')
  assert.match(outer, /'--net', '--pid', '--fork'/)
  assert.match(outer, /'--mount-proc', '--propagation', 'private', '--kill-child=SIGKILL'/)
  assert.match(outer, /child\.kill\('SIGKILL'\)/)
  assert.match(outer, /native\.verifyBrowserNamespaceLauncher\(scope\.parentNamespace\)/)
  assert.match(outer, /assert\.equal\(process\.pid, 1/)
  assert.match(outer, /scope\.owner\.node, \['--require', scope\.preloadPath/)
  assert.match(outer, /process\.once\('SIGTERM', stop\); process\.once\('SIGINT', stop\)/)
  assert.match(outer, /env, 1080000, 'PLM_FULL_APP_NAMESPACE_RESULT '/)
  assert.match(outer, /cleanEnvironment\(process\.env\), 1050000, 'PLM_FULL_APP_RESULT '/)
  assert.doesNotMatch(outer, /startOwnedPostgres|\.NODE_OPTIONS\s*=|\/usr\/bin\/node/)
  const bootstrap = read('scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py')
  assert.match(bootstrap, /os\.getpid\(\) == 1/)
  assert.match(bootstrap, /'--bounding-set=-all', '--inh-caps=-all',/)
  assert.match(bootstrap, /'--ambient-caps=-all', node, entry/)
  assert.match(bootstrap, /entry = os\.path\.join\(root, 'scripts\/ops\/lib\/stock-preparation-plm-namespace\.mjs'\)/)
  const runner = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  assert(runner.indexOf('assertOwnedNamespaceScope(namespaceScope)') < runner.indexOf('database = await startOwnedPostgres'))
  assert.match(runner, /\[\.\.\.namespaceArgs, \.\.\.argv, \.\.\.verifierArgs\]/)
  assert.match(runner, /createFullAppStageRunner\(\{ repoRoot, scratchDir, namespaceScope \}\)/)
  assert.match(runner, /trackedScope = file => [\s\S]*?scripts\\\/ops\\\//)
  const configured = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assertFixedVerifierChildren(configured)
  assert(configured.indexOf('assertOwnedNamespaceScope(namespaceScope)') < configured.indexOf('loadCore<{ MetaSheetServer'))
})

const supervisorSource = read('scripts/ops/lib/stock-preparation-plm-namespace.mjs')
const controlSource = supervisorSource.slice(supervisorSource.indexOf('export function runOwnedNamespaceChild('),
  supervisorSource.indexOf('export async function launchFullAppNamespace(')).replace('export function', 'function')
function childControl(transform = text => text) {
  const child = new EventEmitter(), host = new EventEmitter(), output = { stdout: [], stderr: [] }, timers = []
  const kills = []
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, unreferenced: false,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(value) { kills.push(value) }, unref() { child.unreferenced = true } })
  for (const stream of ['stdout', 'stderr']) {
    child[stream].destroy = () => { child[stream].destroyed = true }
    host[stream] = { write(bytes) { output[stream].push(Buffer.from(bytes)) } }
  }
  const context = { assert, Buffer, Error, Number, Object, JSON, repository: '/synthetic-repository', process: host,
    spawn(_command, _args, options) { assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']); return child },
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clearTimeout(timer) { timer.cleared = true } }
  runInNewContext(transform(controlSource) + '\nthis.run = runOwnedNamespaceChild;', context, { timeout: 1000 })
  const done = context.run('/owned-wrapper', [], {}, 1000, 'PLM_FULL_APP_NAMESPACE_RESULT ')
  const receipt = Buffer.from('PLM_FULL_APP_NAMESPACE_RESULT ' + JSON.stringify({ passed: true,
    workerReceiptObserved: true, normalChildExit: true, pidInitCapabilitiesZero: true, ordinaryWorker: true }) + '\n')
  return { child, host, output, timers, kills, done, receipt,
    passFrame() { child.stdout.emit('data', receipt) }, close() { child.exitCode = 0; child.emit('close', 0, null) } }
}
test('actual owned supervisor accepts one terminal proof and preserves original binary streams', async () => {
  const f = childControl()
  const before = Buffer.from([0, 255, 10]), error = Buffer.from([255, 0, 13, 10])
  f.child.stdout.emit('data', before); f.child.stderr.emit('data', error)
  f.child.stdout.emit('data', f.receipt.subarray(0, 17)); f.child.stdout.emit('data', f.receipt.subarray(17))
  f.close(); await f.done
  assert.deepEqual(Buffer.concat(f.output.stdout), Buffer.concat([before, f.receipt]))
  assert.deepEqual(Buffer.concat(f.output.stderr), error)
  assert.equal(f.host.listenerCount('SIGTERM'), 0); assert.equal(f.host.listenerCount('SIGINT'), 0)
})
test('actual owned supervisor rejects zero exit without proof, duplicate/malformed/downgraded proof and spawn error', async () => {
  for (const kind of ['missing', 'duplicate', 'malformed', 'downgraded', 'spawn-error', 'stream-error']) {
    const f = childControl()
    if (kind === 'duplicate') { f.passFrame(); f.passFrame() }
    if (kind === 'malformed') f.child.stdout.emit('data', Buffer.from('PLM_FULL_APP_NAMESPACE_RESULT {bad}\n'))
    if (kind === 'downgraded') f.child.stdout.emit('data', Buffer.from(f.receipt.toString().replace('"ordinaryWorker":true', '"ordinaryWorker":false')))
    if (kind === 'spawn-error') { f.passFrame(); f.child.emit('error', new Error('synthetic spawn failure')) }
    if (kind === 'stream-error') { f.passFrame(); f.child.stderr.emit('error', new Error('synthetic stream failure')) }
    f.close(); await assert.rejects(f.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/)
  }
})
test('actual owned supervisor SIGTERM/SIGINT kills its exact wrapper with SIGKILL and never accepts late zero exit', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const f = childControl(); f.passFrame(); f.host.emit(signal)
    assert.deepEqual(f.kills, ['SIGKILL']); assert.equal(f.timers[1].ms, 10000)
    f.close(); await assert.rejects(f.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/)
    assert.equal(f.host.listenerCount(signal), 0)
  }
})
test('actual owned supervisor deadline is fatal and missing close has bounded owned-handle drain', async () => {
  const f = childControl(); f.passFrame(); f.timers[0].fn()
  assert.deepEqual(f.kills, ['SIGKILL']); f.timers[1].fn()
  await assert.rejects(f.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/)
  assert.equal(f.child.unreferenced, true)
  assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.stderr.destroyed, true)
})
test('removing actual stopped or terminal-proof guard makes supervisor contracts red', async () => {
  for (const [needle, replacement, arrange] of [
    ['finish(stopped || spawnFailed', 'finish(spawnFailed', f => { f.passFrame(); f.host.emit('SIGTERM') }],
    [' || !valid)', ')', _f => {}],
  ]) {
    assert.equal(controlSource.split(needle).length - 1, 1)
    const f = childControl(text => text.replace(needle, replacement)); arrange(f); f.close()
    await assert.rejects(() => assert.rejects(f.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/),
      error => error.code === 'ERR_ASSERTION')
  }
})
test('removing actual wrapper kill or bounded drain makes supervisor contract red', async () => {
  const needle = "try { child.kill('SIGKILL') } catch"
  assert.equal(controlSource.split(needle).length - 1, 1)
  const f = childControl(text => text.replace(needle, 'try { } catch'))
  f.host.emit('SIGINT'); f.close(); await assert.rejects(f.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/)
  assert.throws(() => assert.deepEqual(f.kills, ['SIGKILL']), error => error.code === 'ERR_ASSERTION')
  const drain = childControl(text => text.replace('child.stdout.destroy(); child.stderr.destroy(); child.unref();', ''))
  drain.timers[0].fn(); drain.timers[1].fn(); await assert.rejects(drain.done, /PLM_FULL_APP_NAMESPACE_CHILD_FAILED/)
  assert.throws(() => assert.equal(drain.child.unreferenced, true), error => error.code === 'ERR_ASSERTION')
})
