import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HELP, assertSyntheticTrialPlatform, cleanSyntheticTrialEnvironment, parseSyntheticTrialArguments, runSyntheticTrial } from './run-stock-preparation-yida-synthetic-trial.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireCore = createRequire(path.join(repository, 'packages/core-backend/package.json'))
const ts = requireCore('typescript')
const publicSource = readFileSync(new URL('./run-stock-preparation-yida-synthetic-trial.mjs', import.meta.url), 'utf8')
const typedSource = readFileSync(path.join(repository, 'packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts'), 'utf8')
const valid = ['--pg-bin=/usr/lib/postgresql/16/bin', '--ttl-seconds=300']

// Only selected actual pure function declarations are compiled as data. Neither
// typed entry nor tsx is imported, and no FS write, signal, child, PG or host runs.
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
