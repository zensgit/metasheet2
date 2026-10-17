import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SCRATCH_OWNER, assertOwnedScratch, assertPlainOwnedTree, startOwnedPostgres } from './lib/stock-preparation-plm-owned-pg.mjs'

const repoRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const temporaryRoot = path.join(repoRoot, 'tmp')
const guard = path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs')

async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(path.join(temporaryRoot, 'stock-preparation-plm-owned-pg-test-'))
  await mkdir(path.join(root, 'tmp'))
  const nonce = randomUUID()
  const scratchDir = path.join(root, 'tmp', `stock-preparation-plm-full-app-${nonce}`)
  await mkdir(scratchDir)
  const marker = { owner: SCRATCH_OWNER, nonce, repoRoot: root, pid: process.pid }
  await writeFile(path.join(scratchDir, 'owner.json'), JSON.stringify(marker), { flag: 'wx' })
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryRoot)
    assert.match(path.basename(root), /^stock-preparation-plm-owned-pg-test-[A-Za-z0-9]+$/u)
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: false })
  })
  return { repoRoot: root, scratchDir, marker }
}

function guardedScript(code, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())))
  return spawnSync(process.execPath, ['--require', guard, '--input-type=commonjs', '--eval', code], {
    cwd: repoRoot, env: { ...env, ...extraEnv }, windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
}

test('scratch ownership accepts only the fresh runner marker in its own repository tmp', async t => {
  const value = await fixture(t)
  assert.deepEqual(await assertOwnedScratch(value), value)
  await assert.rejects(assertOwnedScratch({ ...value, repoRoot: path.dirname(value.repoRoot) }), /OWNER_INVALID/u)
  await assert.rejects(assertOwnedScratch({ ...value, scratchDir: path.dirname(value.scratchDir) }), /OWNER_INVALID/u)
  await assert.rejects(assertOwnedScratch({ ...value, scratchDir: path.relative(repoRoot, value.scratchDir) }), /OWNER_INVALID/u)
})

test('scratch ownership rejects missing, stale, wrong-root, and enlarged markers', async t => {
  const value = await fixture(t)
  const markerFile = path.join(value.scratchDir, 'owner.json')
  for (const marker of [
    { ...value.marker, pid: process.pid + 1 },
    { ...value.marker, nonce: randomUUID() },
    { ...value.marker, repoRoot },
    { ...value.marker, owner: 'unrelated-owner' },
    { ...value.marker, extra: true },
  ]) {
    await writeFile(markerFile, JSON.stringify(marker))
    await assert.rejects(assertOwnedScratch(value), /OWNER_INVALID/u)
  }
  await rm(markerFile)
  await assert.rejects(assertOwnedScratch(value), /OWNER_INVALID/u)
})

test('scratch and cleanup validation reject symlinks or junctions crossing ownership', async t => {
  const value = await fixture(t)
  const target = path.join(value.repoRoot, 'foreign')
  await mkdir(target)
  await writeFile(path.join(target, 'preserve.txt'), 'preserve')
  const link = path.join(value.scratchDir, 'redirect')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(assertPlainOwnedTree(value.scratchDir), /PATH_INVALID/u)
  assert.equal(await readFile(path.join(target, 'preserve.txt'), 'utf8'), 'preserve')
  const redirectedScratch = path.join(value.repoRoot, 'tmp', `stock-preparation-plm-full-app-${randomUUID()}`)
  await symlink(value.scratchDir, redirectedScratch, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(assertOwnedScratch({ ...value, scratchDir: redirectedScratch }), /OWNER_INVALID/u)
})

test('invalid or nonabsolute binary directories never create a PostgreSQL child directory', async t => {
  const value = await fixture(t)
  for (const pgBin of [undefined, 'relative/bin', path.join(value.repoRoot, 'missing')]) {
    await assert.rejects(startOwnedPostgres({ ...value, pgBin, env: {} }), { message: 'PLM_FULL_APP_PG_START_FAILED' })
    assert.deepEqual(await readdir(value.scratchDir), ['owner.json'])
  }
  const bin = path.join(value.repoRoot, 'garbage-bin')
  await mkdir(bin)
  for (const name of ['postgres', 'initdb', 'pg_ctl']) {
    await writeFile(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'invalid executable\n', { mode: 0o600 })
  }
  await assert.rejects(startOwnedPostgres({ ...value, pgBin: bin, env: {} }), { message: 'PLM_FULL_APP_PG_START_FAILED' })
  assert.deepEqual(await readdir(value.scratchDir), ['owner.json'])
})

test('stale ownership fails before inspecting or executing supplied binaries', async t => {
  const value = await fixture(t)
  await writeFile(path.join(value.scratchDir, 'owner.json'), JSON.stringify({ ...value.marker, pid: -1 }))
  await assert.rejects(startOwnedPostgres({ ...value, pgBin: process.execPath, env: process.env }), {
    message: 'PLM_FULL_APP_PG_START_FAILED',
  })
  assert.deepEqual(await readdir(value.scratchDir), ['owner.json'])
})

test('owned stop permits the bounded shutdown checkpoint wait without weakening identity or removal proof', async () => {
  const source = await readFile(new URL('./lib/stock-preparation-plm-owned-pg.mjs', import.meta.url), 'utf8')
  const stop = source.slice(source.indexOf('  function stop() {'))
  assert.match(stop, /\['stop', '-D', data, '-m', 'fast', '-w', '-t', '40'\],\s*env, owned, 45000\)/u)
  const beforeStop = stop.slice(0, stop.indexOf('const stopped ='))
  assert.match(beforeStop, /if \(cleanupUnproven\) throw fixedError\('STOP_NOT_PROVEN'\)/u)
  assert.match(beforeStop, /await verifyOwned\(\)/u)
  assert.match(beforeStop, /await verifyBinaries\(\)/u)
  assert.match(beforeStop, /if \(status\.code !== 0\) throw fixedError\('STOP_NOT_PROVEN'\)/u)
  assert.match(beforeStop, /await verifyIdentity\(\)/u)
  const beforeRemoval = stop.slice(stop.indexOf('const stopped ='), stop.indexOf('await rm(owned'))
  assert.match(beforeRemoval, /if \(stopped\.code !== 0\) throw fixedError\('STOP_FAILED'\)/u)
  assert.match(beforeRemoval, /if \(finalStatus\.code !== 3 \|\| !await absent\(path\.join\(data, 'postmaster\.pid'\)\)\) throw fixedError\('STOP_NOT_PROVEN'\)/u)
  assert.match(beforeRemoval, /await verifyOwned\(\)/u)
  assert.match(beforeRemoval, /await assertPlainOwnedTree\(owned\)/u)
  assert.match(stop, /throw fixedError\('STOP_FAILED_DATA_RETAINED'\)/u)
  assert.doesNotMatch(stop, /process\.kill|taskkill|SIGKILL/u)
})

test('guard rejects invalid database URLs with a fixed diagnostic and no credential echo', () => {
  for (const url of ['not-a-url-private-value', 'postgresql://postgres:private-value@localhost:5432/production']) {
    const result = guardedScript('', { PLM_FULL_APP_DATABASE_URL: url })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /PLM_FULL_APP_INVALID_DISPOSABLE_TARGET/u)
    assert.doesNotMatch(result.stderr, /private-value/u)
  }
})

test('guard treats denied sockets, DNS, UDP, listeners, and environment reads as failures even when caught', () => {
  const result = guardedScript(`
    const actions = [
      () => require('node:net').connect({host:'127.0.0.1',port:5432}),
      () => require('node:net').connect({path:'unowned.pipe'}),
      () => require('node:net').createServer().listen(0,'0.0.0.0'),
      () => require('node:dns').resolve('example.invalid'),
      () => require('node:dgram').createSocket('udp4'),
      () => require('node:fs').readFileSync('.env.production'),
      () => require('node:fs').openSync(Buffer.from('.env.local'),'r'),
    ]
    for (const action of actions) { try { action() } catch {} }
    console.log(JSON.stringify(globalThis.__PLM_FULL_APP_NETWORK_GUARD__.snapshot()))
  `, { PLM_FULL_APP_ALLOW_OWN_HTTP: '1' })
  assert.equal(result.status, 92, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.equal(snapshot.forbiddenConnections, 5)
  assert.equal(snapshot.forbiddenEnvReads, 2)
  assert.equal(snapshot.allowedConnections, 0)
  assert.match(result.stderr, /PLM_FULL_APP_ISOLATION /u)
})

test('guard permits HTTP only on its own live dynamically allocated loopback listener', () => {
  const result = guardedScript(`
    const http = require('node:http')
    const server = http.createServer((_, response) => response.end('synthetic'))
    server.listen(0,'127.0.0.1',async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port)
        if (await response.text() !== 'synthetic') throw new Error('BAD_RESPONSE')
        console.log(JSON.stringify(globalThis.__PLM_FULL_APP_NETWORK_GUARD__.snapshot()))
      } finally { server.closeAllConnections(); server.close() }
    })
  `, { PLM_FULL_APP_ALLOW_OWN_HTTP: '1' })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.equal(snapshot.forbiddenConnections, 0)
  assert.equal(snapshot.forbiddenEnvReads, 0)
  assert.equal(snapshot.allowedConnections, 1)
})

test('guard revokes its HTTP allowance when its listener closes', () => {
  const result = guardedScript(`
    const server = require('node:net').createServer()
    server.listen(0,'127.0.0.1',() => {
      const port = server.address().port
      server.close(() => {
        try { require('node:net').connect({host:'127.0.0.1',port}) } catch {}
        console.log(JSON.stringify(globalThis.__PLM_FULL_APP_NETWORK_GUARD__.snapshot()))
      })
    })
  `, { PLM_FULL_APP_ALLOW_OWN_HTTP: '1' })
  assert.equal(result.status, 92, result.stderr)
  assert.equal(JSON.parse(result.stdout).forbiddenConnections, 1)
})

test('guard requires explicit own-HTTP authorization for a child parent listener', () => {
  const result = guardedScript('', { PLM_FULL_APP_PARENT_HTTP_PORT: '12345' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PLM_FULL_APP_INVALID_PARENT_HTTP_PORT/u)
})
