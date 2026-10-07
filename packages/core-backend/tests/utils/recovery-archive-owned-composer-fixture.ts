import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { createFreshWriterFixture } from './recovery-archive-fresh-writer-admission-fixture'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { LocalStorageProvider } from '../../src/services/StorageService'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'
import { createLocalRecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchivePreparedUploadInput } from '../../src/multitable/recovery-archive-prepared-upload'

export async function createOwnedComposerFixture(admin: Pool) {
  const fixture = await createFreshWriterFixture(admin)
  try {
  await fixture.completeMigrations()
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
  await db.transaction().execute((await import('../../src/db/migrations/zzzz20260826124000_create_recovery_archive_crypto_registry')).up)
  await db.transaction().execute((await import('../../src/db/migrations/zzzz20260827120000_add_recovery_archive_coverage_binding')).up)
  await db.transaction().execute((await import('../../src/db/migrations/zzzz20260918130000_create_recovery_archive_prepared_captures')).up)
  await db.transaction().execute((await import('../../src/db/migrations/zzzz20260919130000_extend_archive_nonce_object_identity')).up)
  console.log('actualOwnedComposerMigrationUps=59 originalG4Ups=55 additionalCryptoCoveragePreparedAndNonceUps=4')
  let depth = 0
  const control: { external?: (phase: string) => Promise<void>; query?: (sql: string, params: unknown[] | undefined, client: PoolClient, execute: () => Promise<QueryResult>) => Promise<QueryResult>; defaultRR: boolean; inheritedRR: boolean } = { defaultRR: false, inheritedRR: false }
  const nativeCalls: Array<{ sql: string; depth: number; isolation?: string }> = []
  const claimCommitBeforeRR: boolean[] = []
  const nativePool: Pick<Pool, 'connect' | 'options'> = { options: fixture.pool.options,
    connect: (async () => {
      const client = await fixture.pool.connect()
      let active = false
      if (control.defaultRR) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      if (control.inheritedRR) { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await client.query('SELECT 1'); active = true; depth++ }
      return { query: async (sql: string, params?: unknown[]) => {
        const execute = async () => {
          if (/^BEGIN.*REPEATABLE READ/i.test(sql)) {
            const prior = (await fixture.query(`SELECT s.recovery_writer_state='archiving'
              AND EXISTS(SELECT 1 FROM meta_recovery_archives a WHERE a.sheet_id=s.id AND a.state='building' AND a.build_status='active' AND a.owner_id=s.recovery_writer_owner_id) AS committed
              FROM meta_sheets s WHERE s.id=$1`, [fixture.sheetId])).rows[0]
            claimCommitBeforeRR.push(prior.committed === true)
          }
          const result = await client.query(sql, params)
          if (/^BEGIN\b/i.test(sql) && !active) { active = true; depth++ }
          if (/^(COMMIT|ROLLBACK)\b/i.test(sql) && active) { active = false; depth-- }
          nativeCalls.push({ sql, depth })
          return result
        }
        return control.query ? control.query(sql, params, client, execute) : execute()
      }, release: (discard?: boolean) => { if (active) { active = false; depth-- }; client.release(discard) } }
    }) as Pool['connect'] }
  const transactionDepth = { currentTransactionDepth: () => depth }
  const transaction: RecoveryArchivePreparedUploadInput['transaction'] = (work) => fixture.transaction(async (client) => {
    depth++
    try { return await work(client.query) } finally { depth-- }
  })
  const parent = resolve('../../artifacts/tm-owned-generation-composer-20261007/native-pg/runtime')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'attempt-'))
  const archivePath = join(root, 'archive'), sourcePath = join(root, 'source')
  await mkdir(archivePath, { mode: 0o700 }); await mkdir(sourcePath, { mode: 0o700 })
  const storage = new LocalStorageProvider(sourcePath)
  const attachments = [
    { id: fixture.attachmentId, deleted: false, bytes: Buffer.from('synthetic-live-attachment-20261007') },
    { id: `${fixture.sheetId}_deleted_attachment`, deleted: true, bytes: Buffer.from('synthetic-deleted-attachment-20261007') },
  ]
  const attachmentKeys: Array<{ key: string; bytes: Buffer }> = []
  for (const attachment of attachments) {
    const fileId = randomUUID(), digest = createHash('sha256').update(attachment.bytes).digest('hex')
    const key = `${fileId}/sha256-${digest}`
    await storage.uploadByKey(key, attachment.bytes)
    attachmentKeys.push({ key, bytes: attachment.bytes })
    if (attachment.deleted) await fixture.query(`INSERT INTO multitable_attachments(id,sheet_id,storage_file_id,filename,mime_type,size,storage_path,storage_provider,deleted_at)
      VALUES($1,$2,$3,'Synthetic','application/octet-stream',$4,$5,'local',clock_timestamp())`, [attachment.id, fixture.sheetId, fileId, attachment.bytes.length, key])
    else await fixture.query('UPDATE multitable_attachments SET storage_file_id=$2,size=$3,storage_path=$4 WHERE id=$1', [attachment.id, fileId, attachment.bytes.length, key])
  }
  const fieldId = `${fixture.sheetId}_field`, recordId = `${fixture.sheetId}_record`
  await fixture.query("INSERT INTO meta_fields(id,sheet_id,name,type,property,\"order\") VALUES($1,$2,'Synthetic','string','{}',1)", [fieldId, fixture.sheetId])
  await fixture.query("INSERT INTO meta_records(id,sheet_id,data,version) VALUES($1,$2,jsonb_build_object($3::text,'synthetic-original'),1)", [recordId, fixture.sheetId, fieldId])
  const custodyId = randomUUID(), secret = randomBytes(32)
  const backup = createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth })
  const session = createLocalCustodySession(transactionDepth)
  session.unlock({ custodyId, recoverySecret: secret, backup })
  const keyCustody = session.admitForArchive(custodyId)
  await fixture.query('INSERT INTO meta_recovery_archive_keys(key_id) VALUES($1)', [keyCustody.keyId])
  await writeFile(join(root, 'custody-backup'), backup, { mode: 0o600 })
  await writeFile(join(root, 'custody-secret'), secret, { mode: 0o600 }); secret.fill(0)
  const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: archivePath })
  const observations: Array<{ phase: string; depth: number; block: unknown; exactOwner: boolean; history: number; prepared: number; nonces: number }> = []
  const initialHistory = await historyCount()
  async function historyCount() {
    const row = (await fixture.query(`SELECT ((SELECT count(*) FROM meta_record_history_operations WHERE sheet_id=$1)
      +(SELECT count(*) FROM meta_sheet_section_revisions WHERE sheet_id=$1)
      +(SELECT count(*) FROM meta_record_history_snapshot_members WHERE sheet_id=$1))::int AS n`, [fixture.sheetId])).rows[0]
    return row.n as number
  }
  async function observe(phase: string) {
    const row = (await fixture.query(`SELECT recovery_writer_state,
      EXISTS(SELECT 1 FROM meta_recovery_archives a WHERE a.sheet_id=s.id AND a.owner_id=s.recovery_writer_owner_id
        AND s.recovery_writer_owner_kind='archive_generation' AND a.owner_kind='archive_builder' AND a.state='building' AND a.build_status='active'
        AND a.lease_expires_at=s.recovery_writer_lease_until AND s.recovery_writer_owner_fence>0) AS exact_owner,
      (SELECT count(*)::int FROM meta_recovery_archive_prepared_captures p JOIN meta_recovery_archives a USING(generation_id) WHERE a.sheet_id=$1) AS prepared,
      (SELECT count(*)::int FROM meta_recovery_archive_nonce_reservations n JOIN meta_recovery_archives a USING(generation_id) WHERE a.sheet_id=$1) AS nonces
      FROM meta_sheets s WHERE id=$1`, [fixture.sheetId])).rows[0]
    observations.push({ phase, depth, block: row.recovery_writer_state, exactOwner: row.exact_owner === true, history: await historyCount(), prepared: row.prepared, nonces: row.nonces })
  }
  const objectStore: RecoveryArchiveObjectStoreProvider = {
    put: async (input) => { await observe('put'); await control.external?.('put'); return provider.put(input) },
    head: async (input) => { await observe('head'); await control.external?.('head'); return provider.head(input) },
    get: async (input) => { await observe('get'); return provider.get(input) },
    pin: async (input) => { await observe('pin'); return provider.pin(input) },
    deleteExpired: async (input) => { await observe('deleteExpired'); return provider.deleteExpired(input) },
  }
  const readContentAddressed = async (key: string) => { await observe('attachment-read'); await control.external?.('attachment-read'); return storage.readContentAddressed(key) }
  const stagedPlaintexts: Buffer[] = []
  const readContentAddressedBounded = async (key: string, maxBytes: number) => {
    await observe('attachment-read'); await control.external?.('attachment-read')
    const result = await storage.readContentAddressedBounded(key, maxBytes)
    stagedPlaintexts.push(result.bytes)
    return result
  }
  const guards = (await fixture.query('SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname', [RECOVERY_AUTHORITY_TRIGGERS.map(([, trigger]) => trigger)])).rows
  return { ...fixture, transaction, nativePool, nativeCalls, claimCommitBeforeRR, control, transactionDepth, storage, attachments, attachmentKeys, fieldId, recordId, root,
    runtime: { keyCustody, objectStore, transactionDepth }, provider, observations, initialHistory, historyCount, observe, guards,
    readContentAddressed, readContentAddressedBounded, stagedPlaintexts, limits: { maxBytes: 8 * 1024 * 1024, timeoutMs: 10000 }, policy: { keyId: keyCustody.keyId, keyRowVersion: '1', leaseSeconds: 120, expiresAfterSeconds: 3600 },
    async dispose() { session.lock(); await fixture.dispose() },
  }
  } catch (error) { await fixture.dispose(); throw error }
}
export type OwnedComposerFixture = Awaited<ReturnType<typeof createOwnedComposerFixture>>
