import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { createFreshWriterFixture } from './recovery-archive-fresh-writer-admission-fixture'
import { LocalStorageProvider } from '../../src/services/StorageService'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { canonicalSheetFenceKey, fenceWriterEntry } from '../../src/multitable/canonical-sheet-fence'
import { mintOperation, sealOperation } from '../../src/multitable/operation-ledger'
import { recordRecordRevision } from '../../src/multitable/record-history-service'
import { deleteAttachmentBinary } from '../../src/multitable/attachment-service'
import { cleanupOrphanMultitableAttachments, sweepMultitableAttachmentBlobPurge } from '../../src/multitable/attachment-orphan-retention'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { query as postgresQuery } from '../../src/db/pg'

export const deletionKinds = ['http', 'direct', 'orphan', 'blob'] as const
export type DeletionKind = typeof deletionKinds[number]
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Hook = (phase: 'claim' | 'operation', sql: string, params: unknown[] | undefined, client: PoolClient) => Promise<void>
const additions = [
  'zzzz20260826124000_create_recovery_archive_crypto_registry',
  'zzzz20260827120000_add_recovery_archive_coverage_binding',
  'zzzz20260918130000_create_recovery_archive_prepared_captures',
  'zzzz20260919130000_extend_archive_nonce_object_identity',
  'zzzz20261001120000_add_archive_abandoned_object_bindings',
  'zzzz20261007120000_amend_recovery_archive_cleanup_anchor',
]

export function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
export async function reached(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SOURCE_DELETION_BARRIER_NOT_REACHED')), 5000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

/** Only original native pg execution and original local filesystem IO; hooks observe fulfilled calls. */
export async function createSourceDeletionFixture(admin: Pool, caseCode: string) {
  const parent = process.env.TM_SOURCE_ATTACHMENT_TEST_ROOT ? resolve(process.env.TM_SOURCE_ATTACHMENT_TEST_ROOT) : await realpath(tmpdir())
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('SOURCE_DELETION_PARENT_INVALID')
  if (process.env.TM_SOURCE_ATTACHMENT_TEST_EVIDENCE_ROOT && !process.env.TM_SOURCE_ATTACHMENT_TEST_ROOT) throw new Error('SOURCE_DELETION_EVIDENCE_PARENT_REQUIRED')
  const root = await mkdtemp(join(parent, 'tm-source-delete-'))
  const rootStat = await lstat(root)
  if (rootStat.uid !== process.getuid?.()) throw new Error('SOURCE_DELETION_ROOT_OWNER_INVALID')
  const evidenceParent = resolve(process.env.TM_SOURCE_ATTACHMENT_TEST_EVIDENCE_ROOT ?? join(root, 'evidence'))
  if (process.env.TM_SOURCE_ATTACHMENT_TEST_EVIDENCE_ROOT) {
    const stat = await lstat(evidenceParent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(evidenceParent) !== evidenceParent || !evidenceParent.startsWith(`${parent}/`)) throw new Error('SOURCE_DELETION_EVIDENCE_ROOT_INVALID')
  } else await mkdir(evidenceParent, { mode: 0o700 })
  const evidence = await mkdtemp(join(evidenceParent, 'case-'))
  let sequence = 0
  const save = (code: string, value: unknown) => writeFile(join(evidence, `${String(++sequence).padStart(3, '0')}-${code}.json`), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  const fixture = await createFreshWriterFixture(admin)
  try {
    const databaseIdentity = (await fixture.query(`SELECT current_database() AS name,d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,c.system_identifier::text AS system_identifier
      FROM pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=current_database()`)).rows
    await save('INITIALIZED', { caseCode, databaseIdentity, root, inputBase: 'ad0db6b22c911e782c6ac18cae0676a523d1f65b' })
    await fixture.completeMigrations()
    const migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
    for (const name of additions) await migrationDb.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    await save('MIGRATIONS_READY', { code: 'CANONICAL_MIGRATIONS_READY', migrations: 61 })
    const sourceRoot = join(root, 'source'); await mkdir(sourceRoot, { mode: 0o700 })
    const storage = new LocalStorageProvider(sourceRoot)
    const bytes = Buffer.from('synthetic-source-attachment-deletion-20261008')
    const sha = createHash('sha256').update(bytes).digest('hex'), fileId = randomUUID(), key = `${fileId}/sha256-${sha}`
    await storage.uploadByKey(key, bytes)
    const immutable = await storage.readContentAddressedBounded(key, bytes.length)
    if (immutable.contentSha256 !== sha || immutable.sizeBytes !== bytes.length || immutable.immutableVersion !== `sha256:${sha}` || !immutable.bytes.equals(bytes)) throw new Error('SOURCE_DELETION_IMMUTABLE_SOURCE_INVALID')
    const fieldId = `${fixture.sheetId}_files`, noteId = `${fixture.sheetId}_note`, recordId = `${fixture.sheetId}_record`
    await fixture.query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$3,'Files','attachment','{}',1),($2,$3,'Note','string','{}',2)`, [fieldId, noteId, fixture.sheetId])
    const data = { [fieldId]: [fixture.attachmentId], [noteId]: 'retained' }
    await fixture.query('INSERT INTO meta_records(id,sheet_id,data,version,created_by) VALUES($1,$2,$3::jsonb,1,$4)', [recordId, fixture.sheetId, JSON.stringify(data), fixture.identity.actorId])
    await fixture.query(`UPDATE multitable_attachments SET record_id=$2,field_id=$3,storage_file_id=$4,storage_path=$5,size=$6,created_by=$7 WHERE id=$1`, [fixture.attachmentId, recordId, fieldId, fileId, key, bytes.length, fixture.identity.actorId])
    const control: { hook?: Hook; deleteHook?: () => Promise<void>; depth: number; operationDepth: number; providerDepths: number[]; claimPid: number; operationPid: number; commits: number } = { depth: 0, operationDepth: 0, providerDepths: [], claimPid: 0, operationPid: 0, commits: 0 }
    async function connect(phase: 'claim' | 'operation') {
      const client = await fixture.pool.connect()
      if (phase === 'claim') control.claimPid = Reflect.get(client, 'processID') as number
      else control.operationPid = Reflect.get(client, 'processID') as number
      let active = false
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          const result = await target.query(sql, params)
          if (/^BEGIN\b/i.test(sql) && !active) { active = true; control.depth++; if (phase === 'operation') control.operationDepth++ }
          if (/^(COMMIT|ROLLBACK)\b/i.test(sql) && active) { active = false; control.depth--; if (phase === 'operation') control.operationDepth--; if (/^COMMIT/i.test(sql) && phase === 'operation') control.commits++ }
          await control.hook?.(phase, sql, params, target)
          return result
        }
        if (property === 'release') return (discard?: boolean) => { if (active) { active = false; control.depth--; if (phase === 'operation') control.operationDepth-- }; target.release(discard) }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    const nativePool = { options: fixture.pool.options, connect: (() => connect('claim')) as Pool['connect'] }
    async function transaction<T>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; __rawClient: PoolClient }) => Promise<T>) {
      const client = await connect('operation')
      try { await client.query('BEGIN'); const value = await work({ query: client.query.bind(client), __rawClient: client }); await client.query('COMMIT'); return value }
      catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    await transaction(async ({ query }) => {
      await fenceWriterEntry(query, fixture.sheetId)
      const ledger = await mintOperation(query, fixture.sheetId)
      await recordRecordRevision(query, { sheetId: fixture.sheetId, recordId, version: 1, action: 'create', source: 'rest', actorId: fixture.identity.actorId, snapshot: data, ledger })
      await sealOperation(query, ledger)
    })
    control.commits = 0
    const originalDelete = storage.deleteByKey.bind(storage)
    storage.deleteByKey = async (path) => { control.providerDepths.push(control.operationDepth); await control.deleteHook?.(); return originalDelete(path) }
    async function physical() {
      const path = join(sourceRoot, key)
      try {
        const directory = await lstat(dirname(path))
        if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || await realpath(dirname(path)) !== dirname(path)) throw new Error('SOURCE_DELETION_FILE_PARENT_INVALID')
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error('SOURCE_DELETION_FILE_INVALID')
          return { exists: true, size: stat.size, inode: String(stat.ino), device: String(stat.dev), sha256: createHash('sha256').update(await handle.readFile()).digest('hex') }
        } finally { await handle.close() }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }; throw error }
    }
    async function snapshot() {
      const tables = (await fixture.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname::text COLLATE "C"`)).rows as Array<{ relname: string }>
      const rows: Record<string, unknown> = {}
      for (const { relname } of tables) {
        if (!/^[a-z0-9_]+$/.test(relname)) throw new Error('SOURCE_DELETION_SNAPSHOT_IDENTIFIER_INVALID')
        rows[relname] = (await fixture.query(`SELECT to_jsonb(t)::text AS row FROM public."${relname}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows
      }
      return { rows, physical: await physical() }
    }
    async function claim(authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>, leaseSeconds = 60) {
      const run = bindRecoveryArchiveOwnedClaim(nativePool, authorize, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 1024 * 1024, timeoutMs: 10000 })
      const result = await run({ ...fixture.identity, requestId: randomUUID() })
      if (!result.claim) throw new Error('SOURCE_DELETION_CLAIM_MISSING')
      const binding = readRecoveryArchiveCommittedClaim(result.claim)
      await save('GENUINE_CLAIM', binding)
      if (binding.sourcePinIds.length !== 1 || binding.sourcePinIds[0] !== fixture.attachmentId) throw new Error('SOURCE_DELETION_PIN_SET_INVALID')
      return binding
    }
    async function eligible(kind: DeletionKind) {
      if (kind === 'orphan') await fixture.query("UPDATE multitable_attachments SET record_id=NULL,created_at=clock_timestamp()-interval '48 hours' WHERE id=$1", [fixture.attachmentId])
      if (kind === 'direct' || kind === 'blob') await fixture.query("UPDATE multitable_attachments SET deleted_at=clock_timestamp()-interval '48 hours' WHERE id=$1", [fixture.attachmentId])
    }
    const queryFn = fixture.query as typeof postgresQuery
    async function run(kind: Exclude<DeletionKind, 'http'>, defaultStorage = false) {
      if (kind === 'direct') return deleteAttachmentBinary({ transaction, storage, storageFileId: fileId, storagePath: key, query: fixture.query, attachmentId: fixture.attachmentId })
      if (kind === 'orphan') return cleanupOrphanMultitableAttachments({ queryFn, transactionFn: transaction, retentionHours: 1, batchSize: 1, ...(defaultStorage ? {} : { storage: { delete: (_id: string, path: string) => storage.deleteByKey(path) } }) })
      return sweepMultitableAttachmentBlobPurge({ queryFn, transactionFn: transaction, graceHours: 1, batchSize: 1, ...(defaultStorage ? {} : { storage }) })
    }
    async function waitForBlocking(blocker: number) {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        const waiters = (await fixture.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [blocker])).rows
        if (waiters.length === 1) { await save('NATIVE_FENCE_WAITER', { blocker, waiters }); return }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('SOURCE_DELETION_NATIVE_WAITER_NOT_OBSERVED')
    }
    async function expire() {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        if ((await fixture.query('SELECT recovery_writer_lease_until<clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows[0].expired === true) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('SOURCE_DELETION_REAL_LEASE_NOT_EXPIRED')
    }
    return { ...fixture, root, sourceRoot, evidence, save, snapshot, physical, storage, key, sha, bytes, fileId, fieldId, noteId, recordId, data, control, transaction, nativePool, claim, eligible, run, expire, waitForBlocking, fenceKey: canonicalSheetFenceKey(fixture.sheetId),
      async dispose() {
        if (control.depth !== 0) throw new Error('SOURCE_DELETION_NATIVE_TRANSACTION_NOT_DRAINED')
        try { await fixture.dispose(); await save('DISPOSED', { code: 'OWNED_SCRATCH_NONFORCED_DISPOSED' }) }
        catch (error) { await save('DISPOSE_REFUSED', { code: 'OWNED_SCRATCH_DISPOSE_REFUSED' }); throw error }
        if (!process.env.TM_SOURCE_ATTACHMENT_TEST_EVIDENCE_ROOT) {
          const current = await lstat(root)
          if (current.isSymbolicLink() || current.uid !== rootStat.uid || current.ino !== rootStat.ino || current.dev !== rootStat.dev || await realpath(root) !== root) throw new Error('SOURCE_DELETION_ROOT_CHANGED')
          await rm(root, { recursive: true })
        }
      },
    }
  } catch (error) { await save('INITIALIZATION_REFUSED', { code: 'SOURCE_DELETION_INITIALIZATION_REFUSED' }); await fixture.dispose(); throw error }
}
export type SourceDeletionFixture = Awaited<ReturnType<typeof createSourceDeletionFixture>>
