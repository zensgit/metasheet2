#!/usr/bin/env node
/**
 * Disposable socket PostgreSQL for the managed-companion suite.
 * Refuses every root that is not /tmp/plm-managed-consumer-pg-<16 hex nonce>
 * with a matching .plm-managed-owned marker. Removes a directory only after
 * Only pg_ctl status exit 3 proves the postmaster is stopped. Exit 0 means
 * running. Any other status, signal, timeout, or spawn error fails and leaves
 * the owned directory in place.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PREFIX = '/tmp/plm-managed-consumer-pg-'
const MARKER = '.plm-managed-owned'
const KIND = 'plm-managed-companion-socket'
const USER = 'plm_test'
const DATABASE = 'plm_managed'
const SCRIPT = fileURLToPath(import.meta.url)

function localeEnv() {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' }
}

function emit(proof) {
  process.stdout.write(JSON.stringify(proof) + '\n')
  process.exit(proof.ok ? 0 : 1)
}

function fail(error, extra = {}) {
  emit({ ok: false, error, locale: 'C', ...extra })
}

function discoverBin() {
  const explicit = process.env.PG_BIN
  if (explicit) {
    const pgCtl = path.join(explicit, 'pg_ctl')
    const initdb = path.join(explicit, 'initdb')
    try {
      if (!lstatSync(pgCtl).isFile() || !lstatSync(initdb).isFile()) throw new Error('not files')
    } catch {
      fail('PG_BIN does not contain pg_ctl and initdb', { pgBin: explicit })
    }
    return explicit
  }
  const candidates = [
    '/usr/lib/postgresql/16/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/lib/postgresql/15/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
  ]
  for (const candidate of candidates) {
    try {
      if (lstatSync(path.join(candidate, 'pg_ctl')).isFile() && lstatSync(path.join(candidate, 'initdb')).isFile()) {
        return candidate
      }
    } catch {
      // try the next explicit install location
    }
  }
  fail('PostgreSQL bin not found; set PG_BIN to a directory that contains pg_ctl and initdb')
}

function parseOptions(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) fail('unexpected argument', { argument: key })
    const name = key.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('missing value', { option: key })
    if (name !== 'root' && name !== 'nonce') fail('unknown option', { option: key })
    options[name] = value
    index += 1
  }
  return options
}

function assertReal(target, label) {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    fail(label + ' is not readable', { target })
  }
  if (stat.isSymbolicLink()) fail('refusing symlink', { target })
  return stat
}

function loadOwned(options) {
  if (!options.root || !options.nonce) fail('root and nonce are required')
  if (!/^[0-9a-f]{16}$/.test(options.nonce)) fail('nonce must be 16 hex characters')
  const root = path.resolve(options.root)
  const expected = PREFIX + options.nonce
  if (root !== expected) fail('root is not the nonce-owned directory', { root, expected })
  const rootStat = assertReal(root, 'owned root')
  if (!rootStat || !rootStat.isDirectory()) fail('owned root is not a real directory', { root })
  const markerPath = path.join(root, MARKER)
  const markerStat = assertReal(markerPath, 'ownership marker')
  if (!markerStat || !markerStat.isFile()) fail('ownership marker is missing', { root })
  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    fail('ownership marker is unreadable', { root })
  }
  if (marker.kind !== KIND || marker.nonce !== options.nonce) {
    fail('ownership marker does not match the nonce', { root })
  }
  const socket = path.join(root, 's')
  const data = path.join(path.dirname(socket), 'data')
  if (data !== path.join(root, 'data')) fail('data directory is not the owned socket sibling', { data, socket })
  for (const target of [data, socket]) {
    const stat = assertReal(target, target)
    if (stat && !stat.isDirectory()) fail('owned path is not a directory', { target })
  }
  return {
    root,
    nonce: options.nonce,
    data,
    socket,
    log: path.join(root, 'pg.log'),
    markerMatched: true,
  }
}

function runTool(bin, name, args, timeout = 90000) {
  const result = spawnSync(path.join(bin, name), args, {
    env: localeEnv(),
    encoding: 'utf8',
    timeout,
  })
  if (result.error) {
    throw new Error(name + ' failed to spawn: ' + result.error.message)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').slice(-1500)
    throw new Error(name + ' exited ' + result.status + (detail ? ': ' + detail : ''))
  }
  return result
}

function classifyPgCtlStatus(result) {
  if (!result || result.error || result.signal || result.status === null || result.status === undefined) {
    const signal = result && result.signal ? ' signal ' + result.signal : ''
    const message = result && result.error && result.error.message ? ': ' + result.error.message : ''
    throw new Error('pg_ctl status did not finish' + signal + message + '; retaining owned directory')
  }
  if (result.status === 0) return 'running'
  if (result.status === 3) return 'stopped'
  const detail = String(result.stderr || result.stdout || '').slice(-500)
  throw new Error(
    'pg_ctl status exited ' + result.status + ' which does not prove the postmaster is stopped'
    + (detail ? ': ' + detail : '')
    + '; retaining owned directory',
  )
}

function pgCtlStatus(bin, data) {
  return classifyPgCtlStatus(spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, 'status'], {
    env: localeEnv(),
    encoding: 'utf8',
    timeout: 20000,
  }))
}

function postgresRunning(bin, data) {
  return pgCtlStatus(bin, data) === 'running'
}

function stopPostmaster(bin, owned) {
  const dataStat = assertReal(owned.data, 'data')
  if (!dataStat) return false
  if (pgCtlStatus(bin, owned.data) === 'stopped') return true
  runTool(bin, 'pg_ctl', ['-D', owned.data, '-m', 'fast', '-w', 'stop'], 60000)
  if (pgCtlStatus(bin, owned.data) !== 'stopped') {
    throw new Error('postmaster stop was not proved by pg_ctl status 3; retaining owned directory')
  }
  return true
}

function socketOptions(socket) {
  return `-h '' -k ${socket} -p 5432`
}

function showServerEncoding(bin, socket) {
  const selected = runTool(bin, 'psql', [
    '-h', socket, '-p', '5432', '-U', USER, '-d', DATABASE, '-v', 'ON_ERROR_STOP=1', '-tAc', 'SHOW server_encoding',
  ])
  return selected.stdout.trim()
}

function baseProof(command, owned, running, removed) {
  return {
    ok: true,
    command,
    nonce: owned.nonce,
    root: owned.root,
    data: owned.data,
    socket: owned.socket,
    postgresStopped: !running,
    postgresRunning: running,
    directoryRemoved: removed,
    locale: 'C',
    markerMatched: true,
  }
}

function abandonFresh(bin, owned) {
  try {
    if (assertReal(owned.data, 'data')) stopPostmaster(bin, owned)
    const marker = assertReal(path.join(owned.root, MARKER), 'marker')
    if (!marker) return
    const body = JSON.parse(readFileSync(path.join(owned.root, MARKER), 'utf8'))
    if (body.nonce !== owned.nonce || body.kind !== KIND) return
    if (assertReal(owned.data, 'data') && pgCtlStatus(bin, owned.data) !== 'stopped') return
    if (path.resolve(owned.root) !== PREFIX + owned.nonce) return
    rmSync(owned.root, { recursive: true, force: false })
  } catch {
    // A failed start must not delete a cluster it cannot prove stopped.
  }
}

function commandStart() {
  const bin = discoverBin()
  const nonce = randomBytes(8).toString('hex')
  const root = PREFIX + nonce
  const owned = { nonce, root, data: path.join(root, 'data'), socket: path.join(root, 's'), log: path.join(root, 'pg.log') }
  mkdirSync(root, { mode: 0o700 })
  try {
    if (!assertReal(root, 'root')?.isDirectory()) fail('owned root was not created', { root, nonce })
    mkdirSync(owned.socket, { mode: 0o700 })
    writeFileSync(path.join(root, MARKER), JSON.stringify({ nonce, kind: KIND }) + '\n', { mode: 0o600, flag: 'wx' })
    runTool(bin, 'initdb', ['-D', owned.data, '-U', USER, '--auth=trust', '--encoding=UTF8', '--locale=C', '--no-instructions'])
    runTool(bin, 'pg_ctl', ['-D', owned.data, '-l', owned.log, '-o', socketOptions(owned.socket), '-w', 'start'])
    if (!postgresRunning(bin, owned.data)) throw new Error('postmaster not running after start')
    runTool(bin, 'createdb', ['-h', owned.socket, '-p', '5432', '-U', USER, DATABASE])
    const serverEncoding = showServerEncoding(bin, owned.socket)
    if (serverEncoding !== 'UTF8') throw new Error('server_encoding is ' + serverEncoding)
    const dsn = `postgresql://${USER}@localhost/${DATABASE}?host=${owned.socket}&port=5432`
    emit({ ...baseProof('start', owned, true, false), dsn, pgBin: bin, serverEncoding })
  } catch (error) {
    abandonFresh(bin, owned)
    fail(error instanceof Error ? error.message : String(error), { command: 'start', root, nonce, pgBin: bin })
  }
}

function commandOwned(command, options) {
  const bin = discoverBin()
  const owned = loadOwned(options)
  try {
    if (command === 'stop') {
      const dataStat = assertReal(owned.data, 'data')
      if (!dataStat?.isDirectory()) fail('data directory is missing', { root: owned.root, nonce: owned.nonce })
      stopPostmaster(bin, owned)
      if (pgCtlStatus(bin, owned.data) !== 'stopped') {
        fail('postmaster stop was not proved by pg_ctl status 3', {
          root: owned.root,
          nonce: owned.nonce,
          directoryRemoved: false,
          postgresStopped: false,
        })
      }
      emit({ ...baseProof('stop', owned, false, false), pgBin: bin })
    }
    if (command === 'boot') {
      const dataStat = assertReal(owned.data, 'data')
      if (!dataStat?.isDirectory()) fail('data directory is missing', { root: owned.root, nonce: owned.nonce })
      if (postgresRunning(bin, owned.data)) fail('refusing to boot a postmaster that is already running', { root: owned.root })
      runTool(bin, 'pg_ctl', ['-D', owned.data, '-l', owned.log, '-o', socketOptions(owned.socket), '-w', 'start'])
      if (!postgresRunning(bin, owned.data)) fail('postmaster not running after boot', { root: owned.root, nonce: owned.nonce })
      const serverEncoding = showServerEncoding(bin, owned.socket)
      if (serverEncoding !== 'UTF8') {
        fail('server_encoding is ' + serverEncoding, { root: owned.root, nonce: owned.nonce, serverEncoding })
      }
      emit({ ...baseProof('boot', owned, true, false), pgBin: bin, serverEncoding })
    }
    if (command === 'cleanup') {
      if (assertReal(owned.data, 'data')) {
        stopPostmaster(bin, owned)
        if (pgCtlStatus(bin, owned.data) !== 'stopped') {
          fail('refusing to remove a directory without pg_ctl status 3', {
            root: owned.root,
            nonce: owned.nonce,
            directoryRemoved: false,
            postgresStopped: false,
          })
        }
      }
      const confirmed = loadOwned(options)
      if (confirmed.root !== owned.root || confirmed.nonce !== owned.nonce) {
        fail('ownership changed before remove', { root: owned.root })
      }
      rmSync(owned.root, { recursive: true, force: false })
      if (assertReal(owned.root, 'root')) fail('owned directory still present after remove', { root: owned.root })
      emit({ ...baseProof('cleanup', owned, false, true), pgBin: bin })
    }
    fail('unknown owned command', { command })
  } catch (error) {
    if (error && error.ok === false) throw error
    fail(error instanceof Error ? error.message : String(error), {
      command,
      root: owned.root,
      nonce: owned.nonce,
      directoryRemoved: false,
    })
  }
}

function invoke(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: localeEnv(),
    encoding: 'utf8',
    timeout: 120000,
  })
  let proof = null
  try {
    proof = JSON.parse(String(result.stdout || '').trim())
  } catch {
    proof = null
  }
  return { status: result.status, proof, stderr: result.stderr || '', error: result.error }
}

function assertStatusClassifier() {
  if (classifyPgCtlStatus({ status: 0, stderr: '', stdout: '' }) !== 'running') {
    throw new Error('pg_ctl status 0 was not classified as running')
  }
  if (classifyPgCtlStatus({ status: 3, stderr: 'no server running', stdout: '' }) !== 'stopped') {
    throw new Error('pg_ctl status 3 was not classified as stopped')
  }
  const rejected = [
    { status: 1, stderr: 'could not open PID file' },
    { status: 4, stderr: 'is not a database cluster directory' },
    { status: null, signal: 'SIGTERM' },
    { status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
    { status: null },
  ]
  for (const sample of rejected) {
    let threw = false
    try {
      classifyPgCtlStatus(sample)
    } catch (error) {
      threw = true
      if (!String(error instanceof Error ? error.message : error).includes('retaining owned directory')) {
        throw new Error('pg_ctl status refusal omitted directory retention')
      }
    }
    if (!threw) throw new Error('unexpected pg_ctl status was classified as stopped')
  }
}

function assertUnexpectedStatusRetainsDirectory() {
  const nonce = randomBytes(8).toString('hex')
  const root = PREFIX + nonce
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(path.join(root, 'data'), { mode: 0o700 })
  mkdirSync(path.join(root, 's'), { mode: 0o700 })
  writeFileSync(path.join(root, MARKER), JSON.stringify({ nonce, kind: KIND }) + '\n', { mode: 0o600, flag: 'wx' })
  const refused = invoke(['cleanup', '--root', root, '--nonce', nonce])
  const errorText = String(refused.proof?.error || '')
  const retained = refused.status !== 0
    && refused.proof?.ok === false
    && refused.proof?.directoryRemoved !== true
    && errorText.includes('does not prove the postmaster is stopped')
    && assertReal(root, 'negative')?.isDirectory()
    && assertReal(path.join(root, 'data'), 'negative data')?.isDirectory()
    && assertReal(path.join(root, MARKER), 'negative marker')?.isFile()
  if (!retained) {
    throw new Error('unexpected pg_ctl status removed or accepted the owned directory: ' + errorText)
  }
  rmSync(root, { recursive: true, force: false })
  if (assertReal(root, 'negative')) throw new Error('negative status fixture still present after the retention proof')
}

function commandSelfCheck() {
  const bin = discoverBin()
  let claimed = null
  function die(message, extra = {}) {
    if (claimed?.root && claimed?.nonce) invoke(['cleanup', '--root', claimed.root, '--nonce', claimed.nonce])
    fail(message, extra)
  }
  try {
  assertStatusClassifier()
  const started = invoke(['start'])
  if (started.proof?.root && started.proof?.nonce) claimed = { root: started.proof.root, nonce: started.proof.nonce }
  if (started.status !== 0 || !started.proof?.ok || started.proof.locale !== 'C' || started.proof.postgresRunning !== true || started.proof.serverEncoding !== 'UTF8') {
    die('self-check start failed', { detail: started.proof || started.stderr || String(started.error) })
  }
  const owned = loadOwned({ root: started.proof.root, nonce: started.proof.nonce })
  const selected = runTool(bin, 'psql', ['-h', owned.socket, '-p', '5432', '-U', USER, '-d', DATABASE, '-v', 'ON_ERROR_STOP=1', '-tAc', 'SELECT 1'])
  if (selected.stdout.trim() !== '1') die('self-check select failed', { root: owned.root })
  if (showServerEncoding(bin, owned.socket) !== 'UTF8') die('self-check start SHOW server_encoding was not UTF8', { root: owned.root })
  const stopped = invoke(['stop', '--root', owned.root, '--nonce', owned.nonce])
  if (stopped.status !== 0 || stopped.proof?.postgresStopped !== true || stopped.proof?.directoryRemoved !== false || stopped.proof?.socket !== owned.socket || stopped.proof?.data !== owned.data) {
    die('self-check stop failed', { detail: stopped.proof, root: owned.root, nonce: owned.nonce })
  }
  if (!assertReal(owned.root, 'root')?.isDirectory()) die('stop removed the owned directory', { root: owned.root })
  const booted = invoke(['boot', '--root', owned.root, '--nonce', owned.nonce])
  if (booted.status !== 0 || booted.proof?.postgresRunning !== true || booted.proof?.locale !== 'C' || booted.proof?.serverEncoding !== 'UTF8' || booted.proof?.data !== owned.data || booted.proof?.socket !== owned.socket) {
    die('self-check boot failed', { detail: booted.proof, root: owned.root, nonce: owned.nonce })
  }
  const again = runTool(bin, 'psql', ['-h', owned.socket, '-p', '5432', '-U', USER, '-d', DATABASE, '-v', 'ON_ERROR_STOP=1', '-tAc', 'SELECT 1'])
  if (again.stdout.trim() !== '1') die('self-check select after restart failed', { root: owned.root })
  if (showServerEncoding(bin, owned.socket) !== 'UTF8') die('self-check boot SHOW server_encoding was not UTF8', { root: owned.root })
  let wrongNonce = randomBytes(8).toString('hex')
  if (wrongNonce === owned.nonce) wrongNonce = '0123456789abcdef'
  const refused = invoke(['stop', '--root', owned.root, '--nonce', wrongNonce])
  if (refused.status === 0 || refused.proof?.ok !== false) die('wrong nonce was not refused', { root: owned.root })
  if (!postgresRunning(bin, owned.data)) die('wrong nonce disturbed the running postmaster', { root: owned.root })
  const decoyNonce = wrongNonce === owned.nonce ? 'fedcba9876543210' : wrongNonce
  const decoy = PREFIX + decoyNonce
  mkdirSync(decoy, { mode: 0o700 })
  writeFileSync(path.join(decoy, MARKER), JSON.stringify({ nonce: owned.nonce, kind: KIND }) + '\n', { mode: 0o600 })
  const decoyCleanup = invoke(['cleanup', '--root', decoy, '--nonce', decoyNonce])
  const decoyPreserved = decoyCleanup.status !== 0 && decoyCleanup.proof?.ok === false && assertReal(decoy, 'decoy')?.isDirectory()
  if (!decoyPreserved) die('decoy directory was not preserved', { decoy, detail: decoyCleanup.proof })
  const cleaned = invoke(['cleanup', '--root', owned.root, '--nonce', owned.nonce])
  if (cleaned.status !== 0 || cleaned.proof?.directoryRemoved !== true || cleaned.proof?.postgresStopped !== true || cleaned.proof?.markerMatched !== true) {
    die('self-check cleanup failed', { detail: cleaned.proof, root: owned.root, nonce: owned.nonce })
  }
  if (assertReal(owned.root, 'root')) die('owned directory still present', { root: owned.root })
  if (!assertReal(decoy, 'decoy')?.isDirectory()) die('cleanup removed the decoy directory', { decoy })
  const decoyMarker = JSON.parse(readFileSync(path.join(decoy, MARKER), 'utf8'))
  if (decoyMarker.nonce === decoyNonce) die('refusing to remove a decoy that carries its own nonce', { decoy })
  rmSync(decoy, { recursive: true, force: false })
  if (assertReal(decoy, 'decoy')) fail('self-check decoy still present', { decoy })
  assertUnexpectedStatusRetainsDirectory()
  emit({
    ok: true,
    command: 'self-check',
    nonce: owned.nonce,
    root: owned.root,
    data: owned.data,
    socket: owned.socket,
    postgresStopped: true,
    postgresRunning: false,
    directoryRemoved: true,
    locale: 'C',
    markerMatched: true,
    pgBin: bin,
    wrongNonceRefused: true,
    decoyPreserved: true,
    decoyRemovedAfterProof: true,
    selectAfterRestart: true,
    status3ProvesStopped: true,
    unexpectedStatusRetained: true,
  })
  } catch (error) {
    die(error instanceof Error ? error.message : String(error), { command: 'self-check' })
  }
}

const argv = process.argv.slice(2)
const command = argv[0]
if (!command || command.startsWith('--')) fail('command required')
const options = parseOptions(argv.slice(1))
if (command === 'start') {
  if (options.root || options.nonce) fail('start does not accept an existing root')
  commandStart()
} else if (command === 'self-check') {
  if (options.root || options.nonce) fail('self-check does not accept an existing root')
  commandSelfCheck()
} else if (command === 'stop' || command === 'boot' || command === 'cleanup') {
  commandOwned(command, options)
} else {
  fail('unknown command', { command })
}
