/** Local synthetic YiDa trial. Not a production or full-isolation acceptance CLI.
 * The trusted parent owns native PG start/stop; it is NOT under the CJS guard.
 * Build/migration/host/preview children all preload the unchanged Node guard.
 * No browser is launched, no real material is supplied, no existing DB is used.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Server } from 'node:http'
import type { Pool } from 'pg'
import type { PreviewServer } from '../../../apps/web/node_modules/vite'
import type { Queryable } from '../src/multitable/automation-durable-dispatcher.ts'
import type { provisionYidaInitializationAnchor } from '../src/integration/yida-initialization-bootstrap.ts'

const entry = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(entry), '../../..')
const requireCore = createRequire(path.join(repository, 'packages/core-backend/package.json'))
const guardPath = path.join(repository, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs')
const prefix = 'YIDA_SYNTHETIC_TRIAL '
const fail = () => new Error('YIDA_SYNTHETIC_TRIAL_FAILED')
const emit = (stage: 'READY' | 'STOPPED' | 'FAILED') => console.log(prefix + JSON.stringify({ stage }))
const plain = async (value: string) => { assert.equal(await realpath(value), value); return value }
const relative = (value: string) => path.relative(repository, value).replaceAll('\\', '/')
const clean = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(source).filter(([key, value]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME'].includes(key.toUpperCase())
  && typeof value === 'string'))

interface Guard { databaseAllowed: boolean; snapshot(): { forbiddenConnections: number; forbiddenEnvReads: number } }
interface Host { start(): Promise<void>; stop(reason: string): Promise<void>; getAddress(): ReturnType<Server['address']> }
interface MainPool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T>
  getInternalPool(): Pool & { ended: boolean }
}
type Build = { outDir: string; wrapperConfig?: string; receiptSha256: string; emittedFiles: unknown[] }
type OwnedPg = { readonly url: string; stop(): Promise<void> }
function assertOwnedPgUrl<T extends object>(database: T): asserts database is T & { readonly url: string } {
  // Actual ownedPG deliberately defines this readonly non-enumerable own value;
  // JS inference misses it. Check the real descriptor, never invent a URL/getter.
  const descriptor = Object.getOwnPropertyDescriptor(database, 'url')
  assert(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    && descriptor.enumerable === false && descriptor.writable === false && descriptor.configurable === false)
}

/** Installed once, before setup's first await, and retained through cleanup. */
function parentCancellation() {
  let cancelled = false, ready = false, preReadyCancelled = false
  const stops = new Set<() => void>()
  const cancel = () => {
    if (!cancelled) { cancelled = true; preReadyCancelled = !ready }
    for (const stop of stops) stop()
  }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  return {
    requestStop: cancel,
    checkpoint() { assert(!cancelled, 'YIDA_SYNTHETIC_TRIAL_CANCELLED') },
    markReady() { assert(!cancelled && !ready, 'YIDA_SYNTHETIC_TRIAL_CANCELLED'); ready = true },
    wasCancelledBeforeReady() { return preReadyCancelled },
    bind(stop: () => void) { stops.add(stop); if (cancelled) stop(); return () => { stops.delete(stop) } },
    dispose() { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) },
  }
}
type Cancellation = ReturnType<typeof parentCancellation>
type HandoffIdentity = { owner: 'YIDA_INTERACTIVE_HANDOFF'; nonce: string; parentPid: number; dev: number; ino: number }
const handoffName = 'trial.private.json', handoffOwnerName = 'trial-handoff-owner.private.json'
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
async function handoffScratch(scratch: string, parentPid: number) {
  await plain(repository); await plain(path.join(repository, 'tmp')); await plain(scratch)
  assert.equal(path.dirname(scratch), path.join(repository, 'tmp'))
  assert(/^stock-preparation-plm-full-app-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(path.basename(scratch)))
  const markerPath = path.join(scratch, 'owner.json'), info = await lstat(markerPath)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1); await plain(markerPath)
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(marker).sort(), ['nonce', 'owner', 'pid', 'repoRoot'])
  assert(marker.owner === 'PLM_FULL_APP_SCRATCH' && marker.repoRoot === repository && marker.pid === parentPid
    && path.basename(scratch) === 'stock-preparation-plm-full-app-' + marker.nonce)
  return marker.nonce as string
}
async function createOwnedHandoff(scratch: string): Promise<HandoffIdentity> {
  const nonce = await handoffScratch(scratch, process.pid)
  const file = await open(path.join(scratch, handoffName), 'wx', 0o600)
  try {
    const info = await file.stat()
    assert(info.isFile() && info.nlink === 1 && Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino))
    return { owner: 'YIDA_INTERACTIVE_HANDOFF', nonce, parentPid: process.pid, dev: info.dev, ino: info.ino }
  } finally { await file.close() }
}
async function readHandoffIdentity(scratch: string): Promise<HandoffIdentity> {
  const nonce = await handoffScratch(scratch, process.ppid), ownerPath = path.join(scratch, handoffOwnerName)
  const info = await lstat(ownerPath)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0); await plain(ownerPath)
  const identity = JSON.parse(await readFile(ownerPath, 'utf8')) as HandoffIdentity
  assert.deepEqual(Object.keys(identity).sort(), ['dev', 'ino', 'nonce', 'owner', 'parentPid'])
  assert(identity.owner === 'YIDA_INTERACTIVE_HANDOFF' && identity.nonce === nonce && identity.parentPid === process.ppid
    && Number.isSafeInteger(identity.dev) && Number.isSafeInteger(identity.ino))
  return identity
}
async function assertExactHandoff(scratch: string, identity: HandoffIdentity) {
  assert.equal(await handoffScratch(scratch, identity.parentPid), identity.nonce)
  const file = path.join(scratch, handoffName), info = await lstat(file)
  assertHandoffFileInfo(info, identity)
  await plain(file)
}
function assertHandoffFileInfo(info: Stats, identity: HandoffIdentity) {
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0
    && info.dev === identity.dev && info.ino === identity.ino)
}
async function removeOwnedHandoff(scratch: string, identity: HandoffIdentity) {
  // An absent owner marker or scratch is NOT an absent handoff success.
  assert.equal(await handoffScratch(scratch, identity.parentPid), identity.nonce)
  const file = path.join(scratch, handoffName)
  let info: Stats
  try { info = await lstat(file) } catch (error) { if (absent(error)) return; throw error }
  assertHandoffFileInfo(info, identity)
  try {
    await plain(file)
    // One fixed owner-created regular file, never a directory or a path input.
    await unlink(file)
  } catch (error) { if (!absent(error)) throw error }
}

/** Only a direct owned child is observed. Unknown runtime output stays in private
 * 0600 files; it is never echoed to a terminal or interpreted as an error code. */
async function child(args: string[], env: NodeJS.ProcessEnv, cwd: string, scratch: string, label: string,
  milliseconds: number, cancellation: Cancellation, interactive = false, readyLifetimeMs = 0,
  custody?: { started(): void; closed(): Promise<void> }): Promise<{ output: string; ready: boolean }> {
  cancellation.checkpoint()
  const stdout = await open(path.join(scratch, label + '.stdout.private.log'), 'wx', 0o600)
  const stderr = await open(path.join(scratch, label + '.stderr.private.log'), 'wx', 0o600)
  let proc: ChildProcess | undefined
  let result: { output: string; ready: boolean } | undefined, failed = false, original: unknown
  const retainFailure = (error: unknown) => { if (!failed) { failed = true; original = error } }
  try {
    result = await new Promise<{ output: string; ready: boolean }>((resolve, reject) => {
      cancellation.checkpoint()
      proc = spawn(process.execPath, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      custody?.started()
      let output = '', markerBuffer = '', ready = false, stopped = false, invalid = false, observed = 0
      let stopRequested = false, closed = false, drain: ReturnType<typeof setTimeout> | undefined
      let readyDeadline: ReturnType<typeof setTimeout> | undefined
      const requestStop = () => {
        if (stopRequested || closed) return
        stopRequested = true
        // Normal protocol stop first. A forced kill is a failure, never clean stop.
        try { proc?.stdin?.write('stop\n') } catch { invalid = true }
        drain = setTimeout(() => { invalid = true; proc?.kill('SIGKILL') }, 50000)
      }
      const onInput = (bytes: Buffer) => { if (bytes.toString('utf8').trim() === 'stop') cancellation.requestStop() }
      const timeout = setTimeout(() => { invalid = true; requestStop() }, milliseconds)
      const writes: Promise<unknown>[] = []
      const marker = (line: string) => {
        if (!line.startsWith(prefix)) return
        try {
          const value = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
          assert.deepEqual(Object.keys(value), ['stage'])
          assert(['READY', 'STOPPED', 'FAILED'].includes(String(value.stage)))
          if (value.stage === 'READY') {
            assert(interactive && !ready && readyLifetimeMs >= 60000 && readyLifetimeMs <= 900000)
            assert(!stopRequested && !invalid, 'YIDA_SYNTHETIC_TRIAL_LATE_READY')
            cancellation.markReady()
            ready = true; clearTimeout(timeout)
            // Independent parent lifetime: even a stuck worker cleanup must not
            // hold this owner forever after its own UI TTL has elapsed.
            readyDeadline = setTimeout(requestStop, readyLifetimeMs + 1000)
            console.log(prefix + JSON.stringify({ stage: 'READY', defaultOff: true, handoff: relative(path.join(scratch, 'trial.private.json')),
              bootstrapParentNodeGuardAttested: false, browserNetworkAttested: false }))
          } else if (value.stage === 'STOPPED') { assert(ready && !stopped); stopped = true }
          else { invalid = true }
        } catch { invalid = true; requestStop() }
      }
      proc.stdout?.on('data', (bytes: Buffer) => {
        writes.push(stdout.write(bytes).catch(() => { invalid = true; requestStop() })); observed += bytes.length
        if (observed > 8 * 1024 * 1024) { invalid = true; requestStop(); return }
        if (!interactive) output += bytes.toString('utf8')
        else {
          markerBuffer += bytes.toString('utf8')
          const lines = markerBuffer.split(/\r?\n/u); markerBuffer = lines.pop() ?? ''
          if (markerBuffer.length > 65536) { invalid = true; requestStop() }
          for (const line of lines) marker(line)
        }
      })
      proc.stderr?.on('data', (bytes: Buffer) => {
        writes.push(stderr.write(bytes).catch(() => { invalid = true; requestStop() })); observed += bytes.length
        if (observed > 8 * 1024 * 1024) { invalid = true; requestStop() }
      })
      const unbind = cancellation.bind(requestStop)
      if (interactive) { process.stdin.on('data', onInput); process.stdin.resume() }
      proc.once('error', () => { invalid = true })
      proc.stdin?.once('error', () => { invalid = true; requestStop() })
      proc.once('close', (code, signal) => {
        closed = true
        clearTimeout(timeout); if (drain) clearTimeout(drain); if (readyDeadline) clearTimeout(readyDeadline)
        unbind()
        process.stdin.removeListener('data', onInput); if (interactive) process.stdin.pause()
        if (markerBuffer) marker(markerBuffer)
        void (async () => {
          let failed = code !== 0 || signal !== null || invalid || cancellation.wasCancelledBeforeReady()
            || interactive && (!ready || !stopped)
          let original: unknown = failed ? fail() : undefined
          try { await Promise.all(writes) } catch (error) { if (!failed) { failed = true; original = error } }
          // This callback is reachable ONLY from the direct child's real close.
          try { await custody?.closed() } catch (error) { if (!failed) { failed = true; original = error } }
          if (failed) reject(original); else resolve({ output, ready })
        })()
      })
    })
  } catch (error) { retainFailure(error) }
  finally {
    try { await stdout.close() } catch (error) { retainFailure(error) }
    try { await stderr.close() } catch (error) { retainFailure(error) }
  }
  if (failed) throw original
  assert(result); return result
}

async function parent(pgBin: string, ttlSeconds: number) {
  const cancellation = parentCancellation()
  try { await ownedParent(pgBin, ttlSeconds, cancellation) }
  finally { cancellation.dispose() }
}
async function ownedParent(pgBin: string, ttlSeconds: number, cancellation: Cancellation) {
  cancellation.checkpoint()
  assert.equal(process.platform, 'linux', 'YIDA_SYNTHETIC_TRIAL_LINUX_PRIVATE_FILE_REQUIRED')
  assert((process.getuid?.() ?? 0) > 0 && (process.getgid?.() ?? 0) > 0)
  const root = await plain(repository)
  await plain(path.join(root, 'tmp')); await plain(pgBin)
  // There is deliberately no DATABASE_URL/config/env-file/old-scratch argument.
  const env = clean(process.env)
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  const nonce = randomUUID(), scratch = path.join(root, 'tmp', 'stock-preparation-plm-full-app-' + nonce)
  await mkdir(scratch, { mode: 0o700 })
  await writeFile(path.join(scratch, 'owner.json'), JSON.stringify({ owner: 'PLM_FULL_APP_SCRATCH', nonce, repoRoot: root, pid: process.pid }),
    { flag: 'wx', mode: 0o600 })
  const { verifyBuildReceipt } = await import('../../../scripts/ops/lib/stock-preparation-plm-builds.mjs') as {
    verifyBuildReceipt(scratch: string, kind: string): Build
  }
  const { startOwnedPostgres } = await import('../../../scripts/ops/lib/stock-preparation-plm-owned-pg.mjs')
  let database: OwnedPg | undefined, workerClosed = false, core: Build | undefined, web: Build | undefined
  let startedDatabase: Awaited<ReturnType<typeof startOwnedPostgres>> | undefined
  let handoffIdentity: HandoffIdentity | undefined, hostWorkerActive = false, failed = false, original: unknown
  const retainFailure = (error: unknown) => { if (!failed) { failed = true; original = error } }
  try {
    // Real build producers, fresh receipts, no compilation-option replacement.
    for (const kind of ['core', 'web']) await child(['--max-old-space-size=6144', '--require', guardPath,
      path.join(root, 'scripts/ops/lib/stock-preparation-plm-builds.mjs'), kind, scratch], env, root, scratch, 'build-' + kind, 300000, cancellation)
    cancellation.checkpoint()
    core = verifyBuildReceipt(scratch, 'core'); web = verifyBuildReceipt(scratch, 'web')
    await writeFile(path.join(scratch, 'synthetic-config.json'), '{}\n', { flag: 'wx', mode: 0o600 })
    // Trusted native lifecycle bootstrap: exact existing ownedPG implementation,
    // generated password/port/database, owned-path checks, live PG identity check.
    // Its internal initial pg client is NOT covered by the child CJS Node guard.
    cancellation.checkpoint()
    startedDatabase = await startOwnedPostgres({ repoRoot: root, scratchDir: scratch, pgBin, env })
    assertOwnedPgUrl(startedDatabase)
    database = startedDatabase
    // The existing ownedPG helper drains its in-flight setup, then this latch
    // refuses all later work; finally must stop the exact returned owned PG.
    cancellation.checkpoint()
    const runtime = { ...env, NODE_ENV: 'production', SECRET_PROVIDER: 'env', ALLOW_SECRET_FALLBACK: 'false',
      DATABASE_URL: database.url, PLM_FULL_APP_DATABASE_URL: database.url,
      DB_SSL: 'false', DB_POOL_MIN: '0', DB_POOL_MAX: '5', TSX_DISABLE_CACHE: '1',
      PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE: '1', PLM_FULL_APP_ALLOW_OWN_HTTP: '1',
      PLM_FULL_APP_SCRATCH: scratch, PLM_FULL_APP_CORE_ROOT: path.join(root, core.outDir),
      CONFIG_FILE: path.join(scratch, 'synthetic-config.json'), JWT_SECRET: randomBytes(48).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'), ENCRYPTION_SALT: randomBytes(32).toString('hex'),
      RBAC_TOKEN_TRUST: 'false', RBAC_BYPASS: 'false', RBAC_OPTIONAL: '0', ALLOW_UNSAFE_ADMIN: 'false',
      ENABLE_FALLBACK_TEST: 'false', ENABLE_MESSAGE_DEDUP: 'false', ENABLE_BPMN_RUNTIME: 'false', ENABLE_BPMN_TIMER_POLLER: 'false',
      DISABLE_WORKFLOW: 'true', DISABLE_EVENT_BUS: 'true', FEATURE_CACHE: 'false', FEATURE_CACHE_REDIS: 'false',
      ENABLE_PLM: 'false', ELEARNING_ENABLED: 'false', DINGTALK_TODO_MIRROR_ENABLED: 'false',
      AUTOMATION_DURABLE_DELIVERY_ENABLED: 'false', APPROVAL_SLA_SCHEDULER_DISABLED: '1', APPROVAL_PROJECTION_SWEEP_DISABLED: '1',
      WEBHOOK_RETRY_SCHEDULER_DISABLED: '1', MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1', DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1',
      DINGTALK_DELIVERY_RETENTION_DISABLED: '1', OPERATION_AUDIT_RETENTION_ENABLED: 'false', MULTITABLE_ATTACHMENT_CLEANUP_ENABLED: 'false',
      AUDIT_LOG_PARTITION_ENSURE: 'off', MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: 'false',
      INTEGRATION_YIDA_OWNER_SEND_ENABLED: 'false', MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED: 'false',
      MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED: 'false', MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED: 'false' }
    const common = ['--require', guardPath, '--import', pathToFileURL(requireCore.resolve('tsx')).href]
    const migrate = (flag: string) => child([...common, path.join(root, 'packages/core-backend/src/db/migrate.ts'), '--' + flag],
      runtime, path.join(root, 'packages/core-backend'), scratch, 'migration-' + flag, 300000, cancellation)
    const before = await migrate('list')
    assert.match(before.output, /^Applied: 0\r?$/mu)
    const migrationCount = Number(before.output.match(/^Pending: ([0-9]+)\r?$/mu)?.[1])
    assert(Number.isSafeInteger(migrationCount) && migrationCount > 0)
    const applied = await migrate('latest')
    assert.equal((applied.output.match(/was executed successfully/gu) ?? []).length, migrationCount)
    // Worker compares the complete actual provider inventory to the ledger too.
    cancellation.checkpoint()
    handoffIdentity = await createOwnedHandoff(scratch)
    await writeFile(path.join(scratch, handoffOwnerName), JSON.stringify(handoffIdentity) + '\n', { flag: 'wx', mode: 0o600 })
    await child([...common, entry, '--worker', scratch, String(ttlSeconds), String(migrationCount)], runtime,
      scratch, scratch, 'interactive-host', 300000, cancellation, true, ttlSeconds * 1000, {
        started() { assert(!hostWorkerActive); hostWorkerActive = true },
        async closed() {
          assert(hostWorkerActive); hostWorkerActive = false
          assert(handoffIdentity); await removeOwnedHandoff(scratch, handoffIdentity)
        },
      })
    workerClosed = true
  } catch (error) { retainFailure(error) }
  finally {
    // Always recheck build input/output bytes. Retain diagnostics; never remove
    // a borrowed directory, use a saved PID, or turn failed teardown into success.
    try {
      if (core) assert.equal(verifyBuildReceipt(scratch, 'core').receiptSha256, core.receiptSha256)
      if (web) assert.equal(verifyBuildReceipt(scratch, 'web').receiptSha256, web.receiptSha256)
    } catch (error) { retainFailure(error) }
    // Preserve ownership before URL narrowing: even a descriptor assertion
    // failure must stop the exact returned native lifecycle object.
    try { if (startedDatabase) await startedDatabase.stop() } catch (error) { retainFailure(error) }
    // No other host worker exists: sequential direct-child custody is released
    // only by real close. A never-spawned empty file is also owned by this parent.
    try {
      assert(!hostWorkerActive)
      if (handoffIdentity) await removeOwnedHandoff(scratch, handoffIdentity)
    } catch (error) { retainFailure(error) }
    if (cancellation.wasCancelledBeforeReady() || database && !workerClosed) retainFailure(fail())
  }
  if (failed) throw original
  console.log(prefix + JSON.stringify({ stage: 'STOPPED', ownedDatabaseRemoved: true, prototype: false, localSyntheticTrial: true, acceptancePassed: false }))
}

async function worker(scratch: string, ttlSeconds: number, migrationCount: number) {
  // The parent's stop protocol is observed during setup too, not only after
  // READY; a cancelled setup cannot advertise a late private READY marker.
  const cancellation = parentCancellation()
  const input = (bytes: Buffer) => { if (bytes.toString('utf8').trim() === 'stop') cancellation.requestStop() }
  process.stdin.on('data', input); process.stdin.resume()
  try { await ownedWorker(scratch, ttlSeconds, migrationCount, cancellation) }
  finally { process.stdin.removeListener('data', input); process.stdin.pause(); cancellation.dispose() }
}
async function ownedWorker(scratch: string, ttlSeconds: number, migrationCount: number, cancellation: Cancellation) {
  cancellation.checkpoint()
  const root = await plain(repository)
  assert.equal(await plain(scratch), process.cwd())
  assert.equal(path.dirname(scratch), path.join(root, 'tmp'))
  const marker = JSON.parse(await readFile(path.join(scratch, 'owner.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(marker).sort(), ['nonce', 'owner', 'pid', 'repoRoot'])
  assert.equal(marker.pid, process.ppid); assert.equal(marker.repoRoot, root); assert.equal(marker.owner, 'PLM_FULL_APP_SCRATCH')
  assert.equal(path.basename(scratch), 'stock-preparation-plm-full-app-' + marker.nonce)
  const guard = (globalThis as unknown as { __PLM_FULL_APP_NETWORK_GUARD__?: Guard }).__PLM_FULL_APP_NETWORK_GUARD__
  assert(guard?.databaseAllowed)
  assert.equal(process.env.DATABASE_URL, process.env.PLM_FULL_APP_DATABASE_URL)
  const database = new URL(process.env.DATABASE_URL!)
  assert(database.protocol === 'postgresql:' && database.hostname === '127.0.0.1'
    && database.pathname === '/plm_full_app_synthetic' && database.username === 'postgres'
    && /^[0-9a-f]{64}$/u.test(database.password) && !database.search && !database.hash)
  assert.equal(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED, 'false')
  const { configuredCoreModulePath, seedConfiguredFixture, configureThroughOwnerHttp } =
    await import('../tests/utils/stock-preparation-plm-full-app-fixture.ts')
  const load = <T,>(module: string): T => requireCore(configuredCoreModulePath(root, module)) as T
  const { verifyBuildReceipt } = await import('../../../scripts/ops/lib/stock-preparation-plm-builds.mjs') as {
    verifyBuildReceipt(scratch: string, kind: string): Build
  }
  const core = verifyBuildReceipt(scratch, 'core'), web = verifyBuildReceipt(scratch, 'web')
  const { MetaSheetServer } = load<{ MetaSheetServer: new (options: { port: number; host: string; pluginDirs: string[]; manageProcessSignals: boolean }) => Host }>('index.ts')
  const { poolManager } = load<{ poolManager: { get(): MainPool } }>('integration/db/connection-pool.ts')
  const pool = poolManager.get(), query = pool.query.bind(pool)
  const { createCoreBackendMigrationProvider } = load<{ createCoreBackendMigrationProvider(): { getMigrations(): Promise<Record<string, unknown>> } }>('db/migration-provider.ts')
  const names = Object.keys(await createCoreBackendMigrationProvider().getMigrations()).sort()
  assert.equal(names.length, migrationCount)
  const ledger = (await query('SELECT name FROM kysely_migration')).rows.map(row => {
    assert.equal(typeof row.name, 'string', 'APP_CONFIGURED_MIGRATION_NAME_REQUIRED')
    return row.name as string
  }).sort()
  const { assertRequiredMainMigrationInventory } = await import('../tests/utils/stock-preparation-main-migration-contract.ts')
  assertRequiredMainMigrationInventory(names, ledger)
  assert.deepEqual(ledger, names)
  // This login exists only in this run's freshly owned synthetic database.
  // Keep principal IDs and the password fresh; the email need not be a secret.
  const owner = randomUUID(), tenant = randomUUID(), identifier = 'trial@example.invalid'
  let password = randomBytes(24).toString('base64url'), token = ''
  const bcrypt = requireCore('bcryptjs') as typeof import('bcryptjs')
  await query(`INSERT INTO users (id,email,name,password_hash,role,permissions,is_active,must_change_password,activation_status,local_password_set)
    VALUES ($1,$2,'Synthetic interactive owner',$3,'admin','[]'::jsonb,true,false,'activated',true)`, [owner, identifier, await bcrypt.hash(password, 10)])
  await query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [owner, tenant])
  await query("INSERT INTO user_roles (user_id,role_id) VALUES ($1,'admin')", [owner])
  const fixture = await seedConfiguredFixture(root, scratch, query, owner, tenant)
  const host = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(root, 'plugins/plugin-integration-core')], manageProcessSignals: false })
  let preview: PreviewServer | undefined, failed = false, original: unknown
  const retainFailure = (error: unknown) => { if (!failed) { failed = true; original = error } }
  const handoff = path.join(scratch, 'trial.private.json')
  const handoffIdentity = await readHandoffIdentity(scratch)
  try {
    cancellation.checkpoint()
    await host.start()
    const address = host.getAddress(); assert(address && typeof address !== 'string' && address.port > 0)
    const origin = `http://127.0.0.1:${address.port}`
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }), signal: AbortSignal.timeout(10000) })
    assert.equal(login.status, 200)
    const session = await login.json() as { success: boolean; data: { token: string; user: { id: string; tenantId: string } } }
    assert(session.success && session.data.user.id === owner && session.data.user.tenantId === tenant && session.data.token)
    token = session.data.token
    const catalog = await fetch(origin + '/api/plugins', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })
    assert.equal(catalog.status, 200)
    const plugins = await catalog.json() as { list: Array<{ name: string; status: string; error?: unknown }>; summary: { failed: number } }
    assert(plugins.list.length === 1 && plugins.list[0].name === fixture.pluginName && plugins.list[0].status === 'active'
      && !plugins.list[0].error && plugins.summary.failed === 0)
    await configureThroughOwnerHttp({ root, origin, token, databaseUrl: database.href, fixture, query })
    assert(fixture.target.fieldIdMap.projectNo && fixture.target.fieldIdMap.active)
    await query('INSERT INTO meta_records (id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)', [randomUUID(), fixture.target.sheetId,
      JSON.stringify({ [fixture.target.fieldIdMap.projectNo]: 'SYN-YIDA-PREVIEW', [fixture.target.fieldIdMap.active]: false })])
    const { provisionYidaInitializationAnchor: provision } = load<{ provisionYidaInitializationAnchor: typeof provisionYidaInitializationAnchor }>('integration/yida-initialization-bootstrap.ts')
    const anchor = await provision({ database: { transaction: work => pool.transaction(async trx => {
      await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); return work(trx)
    }) } }, { ownerId: owner, tenantId: tenant })
    assert(anchor.ownerId === owner && anchor.tenantId === tenant && anchor.workspaceId === null)
    assert.equal((await query('SELECT count(*)::int AS count FROM integration_yida_initialization_anchor')).rows[0].count, 1)
    assert.equal((await query('SELECT count(*)::int AS count FROM integration_yida_initializations')).rows[0].count, 0)
    const boardResponse = await fetch(origin + '/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/board?' + new URLSearchParams({ tenantId: tenant }),
      { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })
    assert.equal(boardResponse.status, 200)
    const board = await boardResponse.json() as { ok: boolean; data: { projectNo: string; tenantId: string; pulledRowCount: number; activePulledRowCount: number; pullTargetReady: boolean } }
    assert(board.ok && board.data.projectNo === 'SYN-YIDA-PREVIEW' && board.data.tenantId === tenant
      && board.data.pulledRowCount === 1 && board.data.activePulledRowCount === 0 && board.data.pullTargetReady)
    const emptyEnv = path.join(scratch, 'interactive-empty-env'), cacheDir = path.join(scratch, 'interactive-vite-cache')
    await mkdir(emptyEnv, { mode: 0o700 }); await mkdir(cacheDir, { mode: 0o700 })
    for (const key of Object.keys(process.env)) if (/^VITE_/iu.test(key)) delete process.env[key]
    process.env.METASHEET_ENV_DIR = emptyEnv
    const requireWeb = createRequire(path.join(root, 'apps/web/package.json'))
    const vitePackage = requireWeb('vite/package.json') as { exports: { '.': { import: { default: string } } } }
    const viteEntry = path.resolve(path.dirname(requireWeb.resolve('vite/package.json')), vitePackage.exports['.'].import.default)
    const { preview: startPreview } = await import(pathToFileURL(viteEntry).href) as typeof import('../../../apps/web/node_modules/vite')
    cancellation.checkpoint()
    preview = await startPreview({ root: path.join(root, 'apps/web'), base: '/', mode: 'production',
      configFile: path.join(root, web.wrapperConfig!), envFile: false, envDir: emptyEnv, cacheDir,
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' }, build: { outDir: path.join(root, web.outDir) },
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false, cors: false,
        proxy: { '/api': { target: origin, changeOrigin: false, ws: true }, '/socket.io': { target: origin, changeOrigin: false, ws: true } } } })
    const ui = preview.httpServer?.address(); assert(ui && typeof ui !== 'string' && ui.port > 0)
    cancellation.checkpoint()
    assert.equal(guard.snapshot().forbiddenConnections, 0); assert.equal(guard.snapshot().forbiddenEnvReads, 0)
    await assertExactHandoff(scratch, handoffIdentity)
    const privateFile = await open(handoff, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const info = await privateFile.stat()
      assertHandoffFileInfo(info, handoffIdentity)
      await privateFile.truncate(0)
      await privateFile.writeFile(JSON.stringify({ prototype: false, localSyntheticTrial: true, syntheticOnly: true, defaultOff: true,
        loginUrl: `http://127.0.0.1:${ui.port}/login`, identifier, password, projectNo: 'SYN-YIDA-PREVIEW', ttlSeconds,
        material: { appKey: 'synthetic-interactive-app-key', appSecret: 'synthetic-interactive-app-secret',
          systemToken: 'synthetic-interactive-system-token', userId: 'synthetic-interactive-operator' },
        reviewRef: 'synthetic-interactive-review', organizationId: 'synthetic-interactive-organization',
        instructions: 'Login, open Stock Preparation project board and SYN-YIDA-PREVIEW. Open YiDa preview, select protocol, load primary synthetic example, run local preview, open local initialization, manual GET, enter only the synthetic material/review/organization here, acknowledge, explicit POST, manual GET. No sends.' }) + '\n',
      'utf8')
    } finally { await privateFile.close() }
    cancellation.markReady(); token = ''; emit('READY')
    await new Promise<void>(resolve => {
      let completed = false
      let unbind = () => {}
      const finish = () => { if (completed) return; completed = true; clearTimeout(timer); unbind(); resolve() }
      const timer = setTimeout(finish, ttlSeconds * 1000)
      unbind = cancellation.bind(finish)
    })
  } catch (error) { retainFailure(error) }
  finally {
    token = ''; password = ''
    try {
      try { await preview?.close() } catch (error) { retainFailure(error) }
      try { await host.stop('YIDA_SYNTHETIC_TRIAL_LOCAL_STOP') } catch (error) { retainFailure(error) }
      try {
        assert(pool.getInternalPool().ended && host.getAddress() === null)
        assert.equal(verifyBuildReceipt(scratch, 'core').receiptSha256, core.receiptSha256)
        assert.equal(verifyBuildReceipt(scratch, 'web').receiptSha256, web.receiptSha256)
        assert.equal(guard.snapshot().forbiddenConnections, 0); assert.equal(guard.snapshot().forbiddenEnvReads, 0)
      } catch (error) { retainFailure(error) }
    } finally {
      // Independent of every shutdown/receipt assertion above, even on failure.
      try { await removeOwnedHandoff(scratch, handoffIdentity) } catch (error) { retainFailure(error) }
    }
  }
  if (failed) throw original
  emit('STOPPED')
}

// Internal worker is parent-owned scratch + parent PID only. No DB URL argument,
// existing cluster option, general external-system option, namespace spoof, or browser.
try {
  if (process.argv[2] === '--worker') {
    assert.equal(process.argv.length, 6)
    const ttl = Number(process.argv[4]), migrations = Number(process.argv[5])
    assert(Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 900 && Number.isSafeInteger(migrations) && migrations > 0)
    await worker(path.resolve(process.argv[3]), ttl, migrations)
  } else {
    assert.equal(process.argv.length, 4)
    assert(process.argv[2].startsWith('--pg-bin=') && process.argv[3].startsWith('--ttl-seconds='))
    const pgBin = process.argv[2].slice('--pg-bin='.length), ttl = Number(process.argv[3].slice('--ttl-seconds='.length))
    assert(path.isAbsolute(pgBin) && Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 900)
    await parent(pgBin, ttl)
  }
} catch { emit('FAILED'); process.exitCode = 1 }
