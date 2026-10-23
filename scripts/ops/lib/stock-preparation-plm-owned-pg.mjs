import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

// No service, existing cluster, environment file, or caller-provided DB URL is
// used. The explicit binary directory is a trusted input; hashes detect changes
// during this invocation, not the provenance of an arbitrary PostgreSQL build.
export const SCRATCH_OWNER = 'PLM_FULL_APP_SCRATCH'
const PG_OWNER = 'PLM_FULL_APP_POSTGRES'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const scratchPattern = new RegExp(`^stock-preparation-plm-full-app-(${UUID})$`, 'u')
const fixedError = code => new Error(`PLM_FULL_APP_PG_${code}`)
const samePath = (left, right) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return typeof left === 'string' && typeof right === 'string' && normalize(left) === normalize(right)
}

async function plainPath(target, directory = false) {
  const info = await lstat(target)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || !samePath(await realpath(target), target)) throw fixedError('PATH_INVALID')
}

async function smallFile(file, maximum = 16384) {
  await plainPath(file)
  if ((await lstat(file)).size > maximum) throw fixedError('IDENTITY_INVALID')
  return readFile(file, 'utf8')
}

async function sha256(file) {
  await plainPath(file)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function absent(file) {
  try { await lstat(file); return false } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw fixedError('PATH_INVALID')
  }
}

// The runner creates this marker before calling us. A stale marker, another
// runner's directory, or a symlink/junction is never an owned scratch root.
export async function assertOwnedScratch({ repoRoot, scratchDir }) {
  try {
    if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)
      || typeof scratchDir !== 'string' || !path.isAbsolute(scratchDir)) throw fixedError('OWNER_INVALID')
    const root = path.resolve(repoRoot)
    const scratch = path.resolve(scratchDir)
    const match = scratchPattern.exec(path.basename(scratch))
    if (!match || !samePath(path.dirname(scratch), path.join(root, 'tmp'))) throw fixedError('OWNER_INVALID')
    await plainPath(root, true)
    await plainPath(path.join(root, 'tmp'), true)
    await plainPath(scratch, true)
    const marker = JSON.parse(await smallFile(path.join(scratch, 'owner.json')))
    const expected = { owner: SCRATCH_OWNER, nonce: match[1], repoRoot: root, pid: process.pid }
    if (JSON.stringify(marker) !== JSON.stringify(expected)) throw fixedError('OWNER_INVALID')
    return { repoRoot: root, scratchDir: scratch, marker: expected }
  } catch { throw fixedError('OWNER_INVALID') }
}

// Exposed so negative tests can exercise the same pre-removal check as stop().
// This does not defend against a local administrator racing filesystem checks.
export async function assertPlainOwnedTree(directory) {
  let checked = 0
  async function walk(target) {
    if (++checked > 20000) throw fixedError('CLEANUP_LIMIT')
    const info = await lstat(target)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
      || !samePath(await realpath(target), target)) throw fixedError('PATH_INVALID')
    if (info.isDirectory()) for (const name of await readdir(target)) await walk(path.join(target, name))
  }
  await walk(directory)
}

// Kill only the direct CLI helper on timeout, never a saved postmaster PID or
// a process tree. A timed-out command makes subsequent cleanup unproven.
function command(executable, args, env, cwd, milliseconds, captureVersion = false) {
  return new Promise((resolve, reject) => {
    let stdout = '', timedOut = false, outputExceeded = false
    const child = spawn(executable, args, { env, cwd, windowsHide: true,
      stdio: captureVersion ? ['ignore', 'pipe', 'ignore'] : 'ignore' })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      reject(fixedError('COMMAND_TIMED_OUT'))
    }, milliseconds)
    child.stdout?.on('data', chunk => {
      if (stdout.length + chunk.length > 4096) { outputExceeded = true; child.kill(); return }
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => { clearTimeout(timer); reject(fixedError('COMMAND_FAILED')) })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(fixedError('COMMAND_TIMED_OUT'))
      else if (outputExceeded) reject(fixedError('COMMAND_FAILED'))
      else resolve({ code, stdout })
    })
  })
}

async function reservePort() {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(fixedError('PORT_FAILED')) }, 5000)
    server.once('error', () => { clearTimeout(timer); reject(fixedError('PORT_FAILED')) })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        clearTimeout(timer)
        if (error || !address || typeof address === 'string') reject(fixedError('PORT_FAILED'))
        else resolve(address.port)
      })
    })
  })
}

export async function startOwnedPostgres({ repoRoot, scratchDir, pgBin, env: suppliedEnv } = {}) {
  // Use only OS plumbing; PG*, NODE_OPTIONS, credentials, and preload settings
  // are deliberately not inherited by any PostgreSQL CLI command.
  const env = Object.fromEntries(Object.entries(suppliedEnv ?? {}).filter(([key, value]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())
    && typeof value === 'string'))
  let root, scratch, owned, data, marker, port, identity, version, serverVersion, stopPromise
  let removed = false, startAttempted = false, cleanupUnproven = false
  const nonce = randomBytes(32).toString('hex')
  const password = randomBytes(32).toString('hex')
  const binaries = {}
  const hashes = {}
  try {
    const checked = await assertOwnedScratch({ repoRoot, scratchDir })
    root = checked.repoRoot
    scratch = checked.scratchDir
    if (typeof pgBin !== 'string' || !path.isAbsolute(pgBin)) throw fixedError('BINARY_INVALID')
    const bin = path.resolve(pgBin)
    await plainPath(bin, true)
    for (const name of ['postgres', 'initdb', 'pg_ctl']) {
      binaries[name] = path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
      hashes[name] = await sha256(binaries[name])
    }
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = [bin, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
    for (const name of Object.keys(binaries)) {
      await verifyBinaries()
      const result = await command(binaries[name], ['--version'], env, bin, 5000, true)
      const match = new RegExp(`^${name} \\(PostgreSQL\\) (\\d+)\\.(\\d+)(?:[ \\t]+\\([^\\r\\n]*\\))?\\s*$`, 'u').exec(result.stdout)
      if (result.code !== 0 || !match || Number(match[1]) < 14
        || Number(match[1]) > 999 || Number(match[2]) > 9999) throw fixedError('VERSION_INVALID')
      const foundVersion = `${match[1]}.${match[2]}`
      if (version && foundVersion !== version) throw fixedError('VERSION_INVALID')
      version = foundVersion
      serverVersion = String(Number(match[1]) * 10000 + Number(match[2]))
    }
    await assertOwnedScratch({ repoRoot: root, scratchDir: scratch })
    owned = await mkdtemp(path.join(scratch, 'pg-'))
    data = path.join(owned, 'data')
    marker = path.join(owned, 'owner.json')
    await writeFile(marker, JSON.stringify(ownerValue()), { flag: 'wx', mode: 0o600 })
    const passwordFile = path.join(owned, 'password.txt')
    await writeFile(passwordFile, password + '\n', { flag: 'wx', mode: 0o600 })
    await verifyOwned()
    await verifyBinaries()
    const initialized = await command(binaries.initdb, ['-D', data, '--pwfile', passwordFile,
      '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C', '-U', 'postgres'],
    env, owned, 30000)
    if (initialized.code !== 0) throw fixedError('INIT_FAILED')
    await unlink(passwordFile)
    port = await reservePort()
    await verifyOwned()
    await verifyBinaries()
    startAttempted = true
    const started = await command(binaries.pg_ctl, ['start', '-D', data, '-l', path.join(owned, 'server.log'),
      '-w', '-t', '20', '-o', `-c listen_addresses=127.0.0.1 -p ${port} -c unix_socket_directories= -c timezone=UTC -c log_timezone=UTC`],
    env, owned, 25000)
    if (started.code !== 0) throw fixedError('START_FAILED')
    await saveIdentity()
    const requireCore = createRequire(path.join(root, 'packages/core-backend/package.json'))
    // Select the pure protocol client explicitly: the pg package entry point
    // otherwise honors ambient NODE_PG_FORCE_NATIVE before config is applied.
    const Client = requireCore('pg/lib/client')
    const parameters = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres',
      ssl: false, options: '', application_name: 'plm-full-app-bootstrap', client_encoding: 'UTF8',
      binary: false, replication: undefined, keepAlive: false, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000, lock_timeout: 1000 }
    const client = new Client(parameters)
    let clientFailed = false
    client.on('error', () => { clientFailed = true })
    // pg uses truthy fallbacks for options/binary/replication. Normalize both
    // parameter and cached Client fields before connecting to the owned socket.
    Object.assign(client.connectionParameters, parameters, { isDomainSocket: false })
    Object.assign(client, { host: parameters.host, port, user: parameters.user, password,
      database: parameters.database, ssl: false, binary: false, replication: undefined })
    try {
      await verifyIdentity()
      await client.connect()
      const result = await client.query(`SELECT current_setting('data_directory') AS data_directory,
        current_setting('listen_addresses') AS listen_addresses, current_setting('port') AS port,
        current_setting('server_version_num') AS server_version_num,
        current_setting('unix_socket_directories') AS unix_socket_directories,
        current_setting('TimeZone') AS timezone, current_setting('log_timezone') AS log_timezone`)
      const row = result.rows[0]
      if (result.rows.length !== 1 || typeof row?.data_directory !== 'string' || !samePath(row.data_directory, data)
        || row.listen_addresses !== '127.0.0.1' || Number(row.port) !== port || row.server_version_num !== serverVersion
        || row.unix_socket_directories !== '' || row.timezone !== 'UTC' || row.log_timezone !== 'UTC') {
        throw fixedError('SERVER_IDENTITY_INVALID')
      }
      await verifyIdentity()
      if (clientFailed) throw fixedError('CLIENT_FAILED')
      await client.query('CREATE DATABASE plm_full_app_synthetic')
      if (clientFailed) throw fixedError('CLIENT_FAILED')
    } finally { await client.end() }
    const result = { version, stop }
    // Prevent accidental JSON/string logging of the credential-bearing URL.
    Object.defineProperty(result, 'url', { value: `postgresql://postgres:${password}@127.0.0.1:${port}/plm_full_app_synthetic` })
    return Object.freeze(result)
  } catch (error) {
    if (error?.message === 'PLM_FULL_APP_PG_COMMAND_TIMED_OUT') cleanupUnproven = true
    if (owned) {
      try { await stop() } catch { throw fixedError('START_FAILED_DATA_RETAINED') }
    }
    throw fixedError('START_FAILED')
  }

  function ownerValue() {
    return { owner: PG_OWNER, nonce, data, version, hashes, ...(identity ? { identity } : {}) }
  }
  async function verifyBinaries() {
    for (const [name, executable] of Object.entries(binaries)) {
      if (await sha256(executable) !== hashes[name]) throw fixedError('BINARY_INVALID')
    }
  }
  async function verifyOwned() {
    await assertOwnedScratch({ repoRoot: root, scratchDir: scratch })
    if (!owned || !samePath(path.dirname(owned), scratch) || !/^pg-[A-Za-z0-9]+$/u.test(path.basename(owned))) {
      throw fixedError('OWNER_INVALID')
    }
    await plainPath(owned, true)
    const value = JSON.parse(await smallFile(marker))
    if (JSON.stringify(value) !== JSON.stringify(ownerValue())) throw fixedError('OWNER_INVALID')
  }
  async function readIdentity() {
    await plainPath(data, true)
    const lines = (await smallFile(path.join(data, 'postmaster.pid'))).trimEnd().split(/\r?\n/u)
    const pid = Number(lines[0])
    if (!Number.isSafeInteger(pid) || pid <= 0 || !samePath(lines[1] ?? '', data)
      || !/^[1-9][0-9]*$/u.test(lines[2] ?? '') || Number(lines[3]) !== port
      || lines[4] !== '' || lines[5] !== '127.0.0.1' || lines[7] !== 'ready') throw fixedError('IDENTITY_INVALID')
    const options = await smallFile(path.join(data, 'postmaster.opts'))
    const tokens = Array.from(options.matchAll(/"([^"]*)"|([^\s]+)/gu), match => match[1] ?? match[2])
    const dataFlag = tokens.indexOf('-D')
    if (!samePath(tokens[0] ?? '', binaries.postgres) || dataFlag < 1 || tokens.lastIndexOf('-D') !== dataFlag
      || !samePath(tokens[dataFlag + 1] ?? '', data)) throw fixedError('IDENTITY_INVALID')
    return { pid, startedAt: lines[2], data, executable: binaries.postgres,
      optionsSha256: createHash('sha256').update(options).digest('hex') }
  }
  async function saveIdentity() {
    await verifyOwned()
    identity = await readIdentity()
    await writeFile(marker, JSON.stringify(ownerValue()), { mode: 0o600 })
  }
  async function verifyIdentity() {
    await verifyOwned()
    if (!identity || JSON.stringify(await readIdentity()) !== JSON.stringify(identity)) throw fixedError('IDENTITY_INVALID')
  }
  function stop() {
    if (removed) return Promise.resolve()
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      try {
        if (cleanupUnproven) throw fixedError('STOP_NOT_PROVEN')
        await verifyOwned()
        await verifyBinaries()
        if (startAttempted) {
          if (!identity && !await absent(path.join(data, 'postmaster.pid'))) await saveIdentity()
          const status = await command(binaries.pg_ctl, ['status', '-D', data], env, owned, 5000)
          if (status.code !== 0) throw fixedError('STOP_NOT_PROVEN')
          await verifyIdentity()
          // A fully migrated synthetic cluster may need more than ten seconds to
          // finish its shutdown checkpoint. Keep both waits bounded below a minute.
          const stopped = await command(binaries.pg_ctl, ['stop', '-D', data, '-m', 'fast', '-w', '-t', '40'],
            env, owned, 45000)
          if (stopped.code !== 0) throw fixedError('STOP_FAILED')
          const finalStatus = await command(binaries.pg_ctl, ['status', '-D', data], env, owned, 5000)
          if (finalStatus.code !== 3 || !await absent(path.join(data, 'postmaster.pid'))) throw fixedError('STOP_NOT_PROVEN')
        }
        await verifyOwned()
        await assertPlainOwnedTree(owned)
        await rm(owned, { recursive: true, force: false })
        removed = true
      } catch (error) {
        if (error?.message === 'PLM_FULL_APP_PG_COMMAND_TIMED_OUT') cleanupUnproven = true
        throw fixedError('STOP_FAILED_DATA_RETAINED')
      }
    })().catch(error => { stopPromise = undefined; throw error })
    return stopPromise
  }
}
