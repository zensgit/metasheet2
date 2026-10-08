import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg'
import { createFreshWriterFixture, FRESH_WRITER_INITIAL_MIGRATIONS, FRESH_WRITER_REMAINING_MIGRATIONS } from './recovery-archive-fresh-writer-admission-fixture'
import { LocalStorageProvider } from '../../src/services/StorageService'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'

export const recordEntries = ['REST_CREATE', 'REST_PATCH', 'REST_BULK_ATOMIC', 'REST_BULK_PARTIAL', 'REST_DELETE', 'SDK_CREATE', 'SDK_PATCH', 'SDK_DELETE_D1', 'SDK_DELETE_D2'] as const
export type RecordEntry = typeof recordEntries[number]
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
export async function reached(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RECORDS_ENTRY_BARRIER_NOT_REACHED')), 5000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
type Depth = { active: boolean; parent: Depth | undefined }
type Hook = (phase: 'claim' | 'operation', sql: string, params: unknown[] | undefined, client: PoolClient) => Promise<void>
const additions = [
  'zzzz20260826124000_create_recovery_archive_crypto_registry',
  'zzzz20260827120000_add_recovery_archive_coverage_binding',
  'zzzz20260918130000_create_recovery_archive_prepared_captures',
  'zzzz20260919130000_extend_archive_nonce_object_identity',
  'zzzz20261001120000_add_archive_abandoned_object_bindings',
  'zzzz20261007120000_amend_recovery_archive_cleanup_anchor',
]

/** Own native scratch scope; hooks run only AFTER the original fulfilled SQL, never substitute it. */
export async function createRecordsEntryFixture(admin: Pool, caseCode: string) {
  const parent = process.env.TM_RECORDS_ENTRY_TEST_ROOT ? resolve(process.env.TM_RECORDS_ENTRY_TEST_ROOT) : await realpath(tmpdir())
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('RECORDS_ENTRY_PARENT_INVALID')
  if (process.env.TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT && !process.env.TM_RECORDS_ENTRY_TEST_ROOT) throw new Error('RECORDS_ENTRY_EVIDENCE_PARENT_REQUIRED')
  const root = await mkdtemp(join(parent, 'tm-records-entry-')), rootStat = await lstat(root)
  if (rootStat.uid !== process.getuid?.()) throw new Error('RECORDS_ENTRY_ROOT_OWNER_INVALID')
  const evidenceParent = resolve(process.env.TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT ?? join(root, 'evidence'))
  if (process.env.TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT) {
    const stat = await lstat(evidenceParent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(evidenceParent) !== evidenceParent || !evidenceParent.startsWith(`${parent}/`)) throw new Error('RECORDS_ENTRY_EVIDENCE_ROOT_INVALID')
  } else await mkdir(evidenceParent, { mode: 0o700 })
  const evidence = await mkdtemp(join(evidenceParent, 'case-'))
  let sequence = 0
  const save = (code: string, value: unknown) => writeFile(join(evidence, `${String(++sequence).padStart(3, '0')}-${code}.json`), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  const caseId = randomUUID(), attemptToken = process.env.TM_RECORDS_ENTRY_TEST_ATTEMPT_TOKEN ?? randomUUID()
  if (process.env.TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT && !process.env.TM_RECORDS_ENTRY_TEST_ATTEMPT_TOKEN) throw new Error('RECORDS_ENTRY_ATTEMPT_TOKEN_REQUIRED')
  type DatabaseIdentity = { name: string; oid: string; owner: string; system_identifier: string }
  let created: DatabaseIdentity | undefined
  const identitySql = `SELECT d.datname AS name,d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,c.system_identifier::text AS system_identifier
    FROM pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=$1`
  async function identity(name: string) {
    const result = await admin.query<DatabaseIdentity>(identitySql, [name])
    if (result.rows.length !== 1) throw new Error('RECORDS_ENTRY_DATABASE_IDENTITY_UNAVAILABLE')
    return result.rows[0]!
  }
  // Only this fixture's fresh DB administration: never let inherited teardown fall back to FORCE.
  const ownedAdmin = new Proxy(admin, { get(target, property) {
    if (property === 'query') return async (input: string | QueryConfig, params?: unknown[]) => {
      const sql = typeof input === 'string' ? input : input.text
      if (/\bpg_terminate_backend\s*\(/i.test(sql) || /\bDROP\s+DATABASE\b[\s\S]*\bFORCE\b/i.test(sql)) throw new Error('RECORDS_ENTRY_FORCED_CLEANUP_FORBIDDEN')
      const creating = /^CREATE DATABASE "(tm_retention_stage_[a-f0-9]{12}_db)"$/.exec(sql)
      const managing = /^(?:ALTER DATABASE|DROP DATABASE IF EXISTS) "(tm_retention_stage_[a-f0-9]{12}_db)"/.exec(sql)
      if (creating) {
        if (created) throw new Error('RECORDS_ENTRY_SECOND_DATABASE_FORBIDDEN')
        const cluster = (await target.query('SELECT system_identifier::text FROM pg_control_system()')).rows
        await save('CREATE_INTENT', { caseId, caseCode, attemptToken, name: creating[1], cluster })
      }
      if (managing) {
        if (!created || managing[1] !== created.name || digest(await identity(created.name)) !== digest(created)) throw new Error('RECORDS_ENTRY_DATABASE_IDENTITY_CHANGED')
        if (/^DROP DATABASE/.test(sql)) {
          const clients = (await target.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [created.name])).rows
          if (clients.length !== 1 || clients[0].n !== 0) throw new Error('RECORDS_ENTRY_DATABASE_NOT_DRAINED')
        }
      }
      const result = typeof input === 'string' ? await target.query(input, params) : await target.query(input)
      if (creating) {
        created = await identity(creating[1]!)
        await save('CREATED', { caseId, caseCode, attemptToken, databaseIdentity: created })
      }
      if (managing && /^DROP DATABASE/.test(sql)) {
        const absence = await target.query('SELECT 1 FROM pg_database WHERE datname=$1', [created!.name])
        if (absence.rows.length !== 0) throw new Error('RECORDS_ENTRY_DATABASE_DROP_NOT_CONFIRMED')
        await save('DATABASE_DISPOSED', { code: 'OWNED_DATABASE_NONFORCED_DISPOSED', caseId, caseCode, attemptToken, databaseIdentity: created, clients: 0, absent: true })
      }
      return result
    }
    const value: unknown = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  let session: ReturnType<typeof createLocalCustodySession> | undefined
  let fixtureDispose: (() => Promise<void>) | undefined
  try {
    const fixture = await createFreshWriterFixture(ownedAdmin)
    fixtureDispose = fixture.dispose
    const databaseIdentity = (await fixture.query(`SELECT current_database() AS name,d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,c.system_identifier::text AS system_identifier
      FROM pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=current_database()`)).rows
    await save('INITIALIZED', { caseId, caseCode, attemptToken, databaseIdentity, root, inputBase: 'da8ac88b58fd3ff15f655611fd9d6feea2d43b74' })
    await fixture.completeMigrations()
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
    for (const name of additions) await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    const appliedMigrations = [...FRESH_WRITER_INITIAL_MIGRATIONS, ...FRESH_WRITER_REMAINING_MIGRATIONS, ...additions]
    await save('MIGRATIONS_READY', { code: 'CANONICAL_MIGRATIONS_READY', migrations: appliedMigrations.length, appliedMigrations })
    const sourceRoot = join(root, 'source'), archivePath = join(root, 'archive')
    await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(archivePath, { mode: 0o700 })
    const storage = new LocalStorageProvider(sourceRoot), bytes = Buffer.from('synthetic-records-source-20261008')
    const sha = createHash('sha256').update(bytes).digest('hex'), fileId = randomUUID(), key = `${fileId}/sha256-${sha}`
    await storage.uploadByKey(key, bytes)
    const immutable = await storage.readContentAddressedBounded(key, bytes.length)
    if (immutable.contentSha256 !== sha || immutable.sizeBytes !== bytes.length || immutable.immutableVersion !== `sha256:${sha}` || !immutable.bytes.equals(bytes)) throw new Error('RECORDS_ENTRY_SOURCE_INVALID')
    await fixture.query('UPDATE multitable_attachments SET storage_file_id=$2,storage_path=$3,size=$4,created_by=$5 WHERE id=$1', [fixture.attachmentId, fileId, key, bytes.length, fixture.identity.actorId])
    const fields = { title: `${fixture.sheetId}_title`, note: `${fixture.sheetId}_note`, number: `${fixture.sheetId}_number`, link: `${fixture.sheetId}_link` }
    for (const [index, [name, id]] of Object.entries(fields).entries()) {
      const type = name === 'number' ? 'autoNumber' : name === 'link' ? 'link' : 'string'
      await fixture.query('INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5::jsonb,$6)', [id, fixture.sheetId, name, type, JSON.stringify(name === 'link' ? { foreignSheetId: fixture.sheetId } : {}), index])
    }
    const contexts = new AsyncLocalStorage<Depth>()
    const transactionDepthProbe = Object.freeze({ currentTransactionDepth: () => {
      let context = contexts.getStore(), depth = 0
      while (context) { if (context.active) depth++; context = context.parent }
      return depth
    } })
    const nativeCalls: Array<{ phase: 'claim' | 'operation'; sql: string; params: unknown[] | undefined; rowCount: number | null; transactionDepth: number }> = []
    const control: { hook?: Hook; clients: number; activeTransactions: number; claimPid: number; operationPid: number; commits: number } = { clients: 0, activeTransactions: 0, claimPid: 0, operationPid: 0, commits: 0 }
    async function connect(phase: 'claim' | 'operation') {
      const client = await fixture.pool.connect(); control.clients++
      if (phase === 'claim') control.claimPid = Reflect.get(client, 'processID') as number
      else control.operationPid = Reflect.get(client, 'processID') as number
      let active = false, released = false
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return async (input: string | QueryConfig, params?: unknown[]) => {
          const sql = typeof input === 'string' ? input : input.text
          const result = typeof input === 'string' ? await target.query(input, params) : await target.query(input)
          if (/^BEGIN\b/i.test(sql) && !active) { active = true; control.activeTransactions++; const context = contexts.getStore(); if (context) context.active = true }
          if (/^(COMMIT|ROLLBACK)\b/i.test(sql) && active) { active = false; control.activeTransactions--; const context = contexts.getStore(); if (context) context.active = false; if (/^COMMIT/i.test(sql) && phase === 'operation') control.commits++ }
          nativeCalls.push({ phase, sql, params: typeof input === 'string' ? params : input.values, rowCount: result.rowCount, transactionDepth: transactionDepthProbe.currentTransactionDepth() })
          await control.hook?.(phase, sql, typeof input === 'string' ? params : input.values, target)
          return result
        }
        if (property === 'release') return (discard?: boolean) => {
          if (released) throw new Error('RECORDS_ENTRY_DOUBLE_RELEASE')
          released = true; control.clients--; if (active) { active = false; control.activeTransactions-- }; const context = contexts.getStore(); if (context) context.active = false; target.release(discard)
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    async function transaction<T>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; __rawClient: PoolClient }) => Promise<T>) {
      const client = await connect('operation'), context = { active: true, parent: contexts.getStore() }
      return contexts.run(context, async () => {
        try { await client.query('BEGIN'); const result = await work({ query: client.query.bind(client), __rawClient: client }); await client.query('COMMIT'); return result }
        catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original error; disposal verifies clients */ }; throw error }
        finally { context.active = false; client.release() }
      })
    }
    const nativePool = { options: fixture.pool.options, connect: (() => connect('claim')) as Pool['connect'] }
    const database = { query: fixture.query, transaction: <T>(work: (query: QueryFn) => Promise<T>) => transaction(({ query }) => work(query)), transactionDepthProbe, nativePool }
    const adapter = { query: fixture.query, transaction, transactionDepthProbe, getInternalPool: () => nativePool }
    const secret = randomBytes(32), custodyId = randomUUID()
    const backup = createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth: transactionDepthProbe })
    session = createLocalCustodySession(transactionDepthProbe); session.unlock({ custodyId, recoverySecret: secret, backup })
    const keyCustody = session.admitForArchive(custodyId)
    await fixture.query('INSERT INTO meta_recovery_archive_keys(key_id) VALUES($1)', [keyCustody.keyId])
    await writeFile(join(root, 'custody-backup'), backup, { mode: 0o600 }); await writeFile(join(root, 'custody-secret'), secret, { mode: 0o600 }); secret.fill(0)
    const providerOptions = { basePath: archivePath, storeId: randomUUID(), maxObjectBytes: 8 * 1024 * 1024, transactionDepth: transactionDepthProbe }
    await provisionRecoveryArchiveFileRoot(providerOptions)
    const objectStore = await createRecoveryArchiveFileStoreProvider(providerOptions)
    async function physical() {
      const path = join(sourceRoot, key), directory = await lstat(dirname(path))
      if (directory.isSymbolicLink() || directory.uid !== rootStat.uid || await realpath(dirname(path)) !== dirname(path)) throw new Error('RECORDS_ENTRY_SOURCE_PARENT_INVALID')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== rootStat.uid || stat.nlink !== 1) throw new Error('RECORDS_ENTRY_SOURCE_FILE_INVALID')
        return { size: stat.size, inode: String(stat.ino), device: String(stat.dev), sha256: createHash('sha256').update(await handle.readFile()).digest('hex') }
      } finally { await handle.close() }
    }
    async function snapshot() {
      const tables = (await fixture.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname::text COLLATE "C"`)).rows as Array<{ relname: string }>
      const rows: Record<string, Array<{ row: string }>> = {}
      for (const { relname } of tables) {
        if (!/^[a-z0-9_]+$/.test(relname)) throw new Error('RECORDS_ENTRY_SNAPSHOT_IDENTIFIER_INVALID')
        rows[relname] = (await fixture.query(`SELECT to_jsonb(t)::text AS row FROM public."${relname}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows
      }
      // Nontransactional allocator state is deliberately separate; table rollback cannot conceal nextval.
      const chainSequence = (await fixture.query('SELECT last_value::text,is_called FROM public.meta_record_chain_seq')).rows
      return { rows, chainSequence, physical: await physical() }
    }
    async function claim(authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>, leaseSeconds = 60) {
      return contexts.run({ active: false, parent: contexts.getStore() }, async () => {
        const run = bindRecoveryArchiveOwnedClaim(nativePool, authorize, { keyId: keyCustody.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 8 * 1024 * 1024, timeoutMs: 10000 })
        const result = await run({ ...fixture.identity, requestId: randomUUID() })
        if (!result.claim) throw new Error('RECORDS_ENTRY_CLAIM_MISSING')
        const binding = readRecoveryArchiveCommittedClaim(result.claim)
        await save('GENUINE_CLAIM', binding)
        if (binding.sourcePinIds.length !== 1 || binding.sourcePinIds[0] !== fixture.attachmentId) throw new Error('RECORDS_ENTRY_PIN_SET_INVALID')
        return binding
      })
    }
    async function leaseState() {
      return (await fixture.query('SELECT recovery_writer_lease_until>clock_timestamp() AS live,recovery_writer_lease_until<clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows
    }
    async function cleanup(generationId: string) {
      return contexts.run({ active: false, parent: contexts.getStore() }, async () => {
        const { createRecoveryArchiveOwnedCleanup } = await import('../../src/routes/univer-meta')
        const command = createRecoveryArchiveOwnedCleanup({
          pool: nativePool, limits: { maxBytes: 8 * 1024 * 1024, timeoutMs: 1000 },
          policy: { keyId: keyCustody.keyId, keyRowVersion: '1', leaseSeconds: 3, expiresAfterSeconds: 3600 },
          provider: objectStore, transactionDepth: transactionDepthProbe,
        })
        const { actorId, baseId, sheetId, workspaceId } = fixture.identity
        try { return await command({ identity: { actorId, baseId, sheetId, workspaceId }, generationId }) }
        finally { await command.drain() }
      })
    }
    async function expire() {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        if ((await fixture.query('SELECT recovery_writer_lease_until<clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows[0].expired === true) { await save('SQL_CLOCK_EXPIRED', { expired: true }); return }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('RECORDS_ENTRY_REAL_LEASE_NOT_EXPIRED')
    }
    async function waitForBlocking(blocker: number) {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        const waiters = (await fixture.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [blocker])).rows
        if (waiters.length === 1) { await save('NATIVE_FENCE_WAITER', { blocker, waiters }); return }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('RECORDS_ENTRY_NATIVE_WAITER_NOT_OBSERVED')
    }
    return { ...fixture, root, sourceRoot, evidence, fields, save, snapshot, claim, cleanup, leaseState, expire, waitForBlocking, nativeCalls, control, adapter, database, transactionDepthProbe, keyCustody, objectStore,
      async dispose() {
        if (control.clients !== 0 || control.activeTransactions !== 0) throw new Error('RECORDS_ENTRY_NATIVE_NOT_DRAINED')
        session?.lock()
        try { await fixture.dispose(); await save('DISPOSED', { code: 'OWNED_SCRATCH_NONFORCED_DISPOSED' }) }
        catch (error) { await save('DISPOSE_REFUSED', { code: 'OWNED_SCRATCH_DISPOSE_REFUSED' }); throw error }
        if (!process.env.TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT) {
          const current = await lstat(root)
          if (current.isSymbolicLink() || current.uid !== rootStat.uid || current.ino !== rootStat.ino || current.dev !== rootStat.dev || await realpath(root) !== root) throw new Error('RECORDS_ENTRY_ROOT_CHANGED')
          await rm(root, { recursive: true })
        }
      },
    }
  } catch (error) { await save('INITIALIZATION_REFUSED', { code: 'RECORDS_ENTRY_INITIALIZATION_REFUSED' }); session?.lock(); await fixtureDispose?.(); throw error }
}
export type RecordsEntryFixture = Awaited<ReturnType<typeof createRecordsEntryFixture>>
