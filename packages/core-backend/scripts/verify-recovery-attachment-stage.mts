import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, Pool } from 'pg'
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely'

const require = createRequire(import.meta.url)
const migration = require('../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages.ts') as typeof import('../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages')
const { createArchiveAttachmentStageLedger, retireExpiredArchiveAttachmentStage } = require('../src/multitable/recovery-archive-attachment-stage-ledger.ts') as typeof import('../src/multitable/recovery-archive-attachment-stage-ledger')
const { LocalStorageProvider, StorageServiceImpl } = require('../src/services/StorageService.ts') as typeof import('../src/services/StorageService')
const { createRecoveryArchiveApplication } = require('../src/multitable/recovery-archive-application.ts') as typeof import('../src/multitable/recovery-archive-application')
const { stampClaimedAttachmentPurge } = require('../src/multitable/attachment-purge-claim.ts') as typeof import('../src/multitable/attachment-purge-claim')
const { applyVerifiedArchiveAttachmentMetadata, hashArchiveAttachmentMetadata } = require('../src/multitable/recovery-archive-attachment-apply.ts') as typeof import('../src/multitable/recovery-archive-attachment-apply')
assert.equal(process.env.NODE_ENV, 'test')
const url = new URL(process.env.TM_MANUAL_TEST_ADMIN_URL ?? 'http://invalid')
assert.equal(url.protocol, 'postgresql:')
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.username, 'tm_manual')
assert.equal(url.password + url.search + url.hash, '')
assert.equal(url.pathname, '/postgres')
assert.ok(Number(url.port) >= 1024 && !['5432', '5433', '5435'].includes(url.port))
const pgdata = await realpath(process.env.TM_MANUAL_TEST_PGDATA ?? '/invalid')
assert.equal(basename(pgdata), 'pgdata')
assert.match(basename(dirname(pgdata)), /^tm-manual-checkpoint-cluster-[a-zA-Z0-9]+$/)
assert.equal(dirname(dirname(pgdata)), await realpath(tmpdir()))
const connection = { host: '127.0.0.1', port: Number(url.port), user: 'tm_manual' }
const database = `tm_attachment_stage_${randomUUID().replaceAll('-', '')}`
const admin = new Client({ ...connection, database: 'postgres' })
async function awaitOwnedBackendExit(attempts = 101): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const count = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n
    if (count === 0) return
    if (attempt + 1 < attempts) await sleep(50)
  }
  throw new Error('ATTACHMENT_STAGE_BACKEND_DRAIN_TIMEOUT')
}
let created = false
let db: Kysely<unknown> | undefined
const storageRoot = await mkdtemp(join(await realpath(tmpdir()), 'tm-attachment-stage-storage-'))
try {
  await admin.connect()
  assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory), pgdata)
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ ...connection, database, max: 3 }) }) })
  await sql`CREATE TABLE multitable_attachments (id text PRIMARY KEY,storage_path text,
    deleted_at timestamptz,blob_purge_claimed_at timestamptz,blob_purged_at timestamptz)`.execute(db)
  const purgeQuery = async (text: string, params?: unknown[]) => ({ rows: (await db!.executeQuery(CompiledQuery.raw(text, params))).rows })
  await sql`INSERT INTO multitable_attachments VALUES ('attachment','old/object',NULL,now(),NULL)`.execute(db)
  assert.equal(await stampClaimedAttachmentPurge(purgeQuery, 'attachment', 'old/object'), false)
  await sql`UPDATE multitable_attachments SET storage_path='restored/object',deleted_at=now()`.execute(db)
  assert.equal(await stampClaimedAttachmentPurge(purgeQuery, 'attachment', 'old/object'), false)
  assert.equal((await sql<{ value: unknown }>`SELECT blob_purged_at AS value FROM multitable_attachments`.execute(db)).rows[0]?.value, null)
  assert.equal(await stampClaimedAttachmentPurge(purgeQuery, 'attachment', 'restored/object'), true)
  assert.equal(await stampClaimedAttachmentPurge(purgeQuery, 'attachment', 'restored/object'), false)
  console.log('PASS: late purge completion cannot stamp a restored or replacement attachment object')
  // Minimal owning-table fixture: this gate proves the new ledger, not the complete migration stream.
  await sql`CREATE TABLE public.meta_recovery_archives (
    generation_id uuid PRIMARY KEY,workspace_id text,base_id text,sheet_id text,
    state text,build_status text,coverage_status text,expires_at timestamptz)`.execute(db)
  for (const operation of [migration.up, migration.up, migration.down, migration.down, migration.up]) {
    await db.transaction().execute(operation)
  }
  for (const tamper of [
    `ALTER TABLE meta_recovery_archive_attachment_stages ALTER COLUMN field_id DROP NOT NULL`,
    `ALTER TABLE meta_recovery_archive_attachment_stages ALTER COLUMN token_expires_at DROP NOT NULL`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DISABLE TRIGGER trg_mraas_row`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DISABLE TRIGGER trg_mraas_truncate`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DISABLE TRIGGER trg_mraas_apply_receipt`,
    `ALTER TABLE meta_recovery_archive_attachment_stages ALTER COLUMN applied_operation_id TYPE text USING applied_operation_id::text`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DROP CONSTRAINT meta_recovery_archive_attachment_stages_object_id_key`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DROP CONSTRAINT meta_recovery_archive_attachment_stages_pkey,
      ADD PRIMARY KEY(actor_id,token_hash,attachment_id) DEFERRABLE INITIALLY DEFERRED`,
    `ALTER TABLE meta_recovery_archive_attachment_stages DROP CONSTRAINT meta_recovery_archive_attachment_stages_check,
      ADD CONSTRAINT meta_recovery_archive_attachment_stages_check CHECK(true)`,
    `CREATE OR REPLACE FUNCTION meta_recovery_archive_attachment_stage_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$`,
  ]) {
    const rollback = new Error('ROLLBACK_MUTATION')
    await assert.rejects(db.transaction().execute(async tx => {
      await sql.raw(tamper).execute(tx)
      await assert.rejects(migration.up(tx))
      throw rollback
    }), error => error === rollback)
    await db.transaction().execute(migration.up)
  }
  const generationId = randomUUID()
  await sql`INSERT INTO meta_recovery_archives VALUES (${generationId}::uuid,'w','b','s',
    'verified','finalized','complete',clock_timestamp()+interval '1 hour')`.execute(db)
  const actorId = randomUUID()
  const identity = { generationId, workspaceId: 'w', baseId: 'b', sheetId: 's',
    recordId: 'r', fieldId: 'f', attachmentId: 'att-original', sourceVersion: 'sha256:' + 'a'.repeat(64),
    plaintextSha256: 'a'.repeat(64), sizeBytes: '4' }
  let allowed = true
  const ledger = createArchiveAttachmentStageLedger({ actorId, tokenHash: 'b'.repeat(64),
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    authorize: async () => allowed,
    transaction: work => db!.transaction().execute(tx => work(async (text, params) => ({
      rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows,
    }))),
  })
  const [first, concurrent] = await Promise.all([ledger.reserve(identity), ledger.reserve(identity)])
  assert.equal(first.objectId, concurrent.objectId)
  assert.equal(first.state, 'reserved')
  await assert.rejects(ledger.reserve({ ...identity, plaintextSha256: 'c'.repeat(64) }))
  await assert.rejects(ledger.verified(randomUUID(), identity))
  await ledger.verified(first.objectId, identity)
  await ledger.verified(first.objectId, identity)
  assert.deepEqual(await ledger.reserve(identity), { ...first, state: 'verified' })
  await db.destroy()
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ ...connection, database, max: 3 }) }) })
  assert.deepEqual(await ledger.reserve(identity), { ...first, state: 'verified' })
  allowed = false
  await assert.rejects(ledger.reserve(identity))
  await assert.rejects(ledger.verified(first.objectId, identity))
  allowed = true
  // Owning metadata fixture: exercise transactional participant, not public restore/token/history admission.
  await sql`CREATE TABLE meta_records (id text PRIMARY KEY,sheet_id text NOT NULL)`.execute(db)
  await sql`CREATE TABLE meta_fields (id text PRIMARY KEY,sheet_id text NOT NULL,type text NOT NULL)`.execute(db)
  await sql`INSERT INTO meta_records VALUES ('r','s')`.execute(db)
  await sql`INSERT INTO meta_fields VALUES ('f','s','attachment')`.execute(db)
  await sql`ALTER TABLE multitable_attachments ADD COLUMN sheet_id text,ADD COLUMN record_id text,
    ADD COLUMN field_id text,ADD COLUMN storage_file_id text,ADD COLUMN filename text,
    ADD COLUMN original_name text,ADD COLUMN mime_type text,ADD COLUMN size bigint,
    ADD COLUMN storage_provider text,ADD COLUMN updated_at timestamptz`.execute(db)
  await sql`INSERT INTO multitable_attachments (id,storage_path,deleted_at,blob_purge_claimed_at,
    blob_purged_at,sheet_id,record_id,field_id,storage_file_id,filename,original_name,mime_type,size,storage_provider)
    VALUES ('att-original','old/source',now(),now(),now(),'s','r','f','old-file',
      'retained.bin','original.bin','application/octet-stream',4,'local')`.execute(db)
  const metadata = (await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
    FROM multitable_attachments a WHERE id='att-original'`.execute(db)).rows[0]!.metadata
  const applyInput = { actorId, tokenHash: 'b'.repeat(64), objectId: first.objectId, identity,
    expectedMetadataHash: hashArchiveAttachmentMetadata(metadata),
    transactionDepth: { currentTransactionDepth: () => 1 }, authorize: async () => allowed }
  const apply = (overrides: Partial<typeof applyInput> = {}) => db!.transaction().execute(async tx => {
    const query = async (text: string, params?: unknown[]) => ({ rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows })
    await applyVerifiedArchiveAttachmentMetadata(query, { ...applyInput, ...overrides })
  })
  allowed = false
  await assert.rejects(apply(), { message: 'ARCHIVE_ATTACHMENT_RESTORE_APPLY_REFUSED' })
  allowed = true
  await assert.rejects(apply({ transactionDepth: { currentTransactionDepth: () => 0 } }))
  await assert.rejects(apply({ actorId: randomUUID() }))
  await assert.rejects(apply({ tokenHash: 'c'.repeat(64) }))
  await assert.rejects(apply({ objectId: randomUUID() }))
  await assert.rejects(apply({ identity: { ...identity, fieldId: 'other' } }))
  await assert.rejects(apply({ expectedMetadataHash: 'd'.repeat(64) }))
  const pendingActor = randomUUID()
  const pending = createArchiveAttachmentStageLedger({ actorId: pendingActor, tokenHash: 'b'.repeat(64),
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    authorize: async () => true,
    transaction: work => db!.transaction().execute(tx => work(async (text, params) => ({
      rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows,
    }))),
  })
  const reservedOnly = await pending.reserve(identity)
  await assert.rejects(apply({ actorId: pendingActor, objectId: reservedOnly.objectId }))
  const rollback = new Error('OWNED_APPLY_ROLLBACK')
  for (const tamper of [
    `DELETE FROM meta_records WHERE id='r'`,
    `UPDATE meta_fields SET type='text' WHERE id='f'`,
    `UPDATE multitable_attachments SET filename='changed.bin' WHERE id='att-original'`,
    `UPDATE multitable_attachments SET storage_provider='other' WHERE id='att-original'`,
  ]) await assert.rejects(db.transaction().execute(async tx => {
    await sql.raw(tamper).execute(tx)
    await assert.rejects(applyVerifiedArchiveAttachmentMetadata(async (text, params) => ({
      rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows,
    }), applyInput))
    throw rollback
  }), error => error === rollback)
  await assert.rejects(db.transaction().execute(async tx => {
    await applyVerifiedArchiveAttachmentMetadata(async (text, params) => ({
      rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows,
    }), applyInput)
    const updated = (await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
      FROM multitable_attachments a WHERE id='att-original'`.execute(tx)).rows[0]!.metadata
    assert.deepEqual(updated, { ...metadata, storage_file_id: first.objectId,
      storage_path: `${first.objectId}/sha256-${identity.plaintextSha256}`,
      deleted_at: null, blob_purged_at: null, blob_purge_claimed_at: null, updated_at: updated.updated_at })
    assert.ok(updated.updated_at)
    // Simulate a later reference/history write failure in the enclosing transaction.
    throw rollback
  }), error => error === rollback)
  assert.deepEqual((await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
    FROM multitable_attachments a WHERE id='att-original'`.execute(db)).rows[0]!.metadata, metadata)
  await apply()
  assert.equal((await sql<{ path: string }>`SELECT storage_path AS path FROM multitable_attachments
    WHERE id='att-original'`.execute(db)).rows[0]!.path, `${first.objectId}/sha256-${identity.plaintextSha256}`)
  await assert.rejects(apply()) // A stale pre-apply metadata fingerprint cannot be replayed independently.
  console.log('PASS: verified stage metadata apply, current scope/auth/drift rejection and enclosing transaction rollback')
  const transaction = <T,>(work: (query: typeof purgeQuery) => Promise<T>) => db!.transaction().execute(tx => work(async (text, params) => ({
    rows: (await tx.executeQuery(CompiledQuery.raw(text, params))).rows,
  })))
  const expiresAt = new Date(Date.now() + 1500).toISOString()
  const cleanupLedger = createArchiveAttachmentStageLedger({ actorId: randomUUID(), tokenHash: 'e'.repeat(64),
    tokenExpiresAt: expiresAt, authorize: async () => true, transaction })
  const bytes = Buffer.from('test')
  const cleanupIdentity = { ...identity, plaintextSha256: createHash('sha256').update(bytes).digest('hex') }
  const uploaded = await cleanupLedger.reserve({ ...cleanupIdentity, attachmentId: 'expired-upload' })
  const untouched = await cleanupLedger.reserve({ ...cleanupIdentity, attachmentId: 'expired-unstarted' })
  const late = await cleanupLedger.reserve({ ...cleanupIdentity, attachmentId: 'expired-late' })
  const storage = new LocalStorageProvider(storageRoot)
  const cleanupStorage = StorageServiceImpl.resolveLocalRecoveryCleanup(new StorageServiceImpl(storage))
  assert.ok(cleanupStorage)
  const key = (objectId: string) => `${objectId}/sha256-${cleanupIdentity.plaintextSha256}`
  await storage.reserveRecoveryAttachment(key(uploaded.objectId), uploaded.ownershipKey)
  await storage.uploadByKey(key(uploaded.objectId), bytes)
  await cleanupLedger.verified(uploaded.objectId, { ...cleanupIdentity, attachmentId: 'expired-upload' })
  await storage.reserveRecoveryAttachment(key(late.objectId), late.ownershipKey)
  const delayed = await open(join(storageRoot, key(late.objectId)), 'wx')
  let storageCalls = 0
  let throwAfterRetire = true
  const unrelated = (): never => { throw new Error('UNEXPECTED_CLEANUP_DEPENDENCY') }
  const cleanupApplication = createRecoveryArchiveApplication(() => ({
    keyCustody: { produceGenerationDek: unrelated, unwrapGenerationDek: unrelated, deriveDekFingerprint: unrelated,
      macManifestRoot: unrelated, verifyManifestRootMac: unrelated },
    objectStore: { put: unrelated, get: unrelated, head: unrelated, deleteExpired: unrelated, pin: unrelated },
    auditedReplayHorizonMs: 0, asyncResumeHorizonMs: 1, workerIntervalMs: 1,
    worker: { recheckAuthority: unrelated, processDerivedWork: unrelated, leaseMs: 1, replayHorizonMs: 0,
      apply: { preliminaryFullRead: unrelated, stabilizeAuthorization: unrelated,
        finalLockedFullRead: unrelated, evaluatePlanAuthorization: unrelated } },
    attachmentCleanupStorage: { retireRecoveryAttachment: async (path, owner) => {
      const objectId = path.split('/')[0]!
      storageCalls++
      assert.ok(['abandoned', 'cleaned'].includes((await sql<{ state: string }>`SELECT state FROM meta_recovery_archive_attachment_stages
        WHERE object_id=${objectId}::uuid`.execute(db!)).rows[0]?.state ?? ''))
      await cleanupStorage.retireRecoveryAttachment(path, owner)
      if (throwAfterRetire) throw new Error('SYNTHETIC_POST_RETIRE_FAILURE')
    } },
  }), () => ({ transaction, query: purgeQuery, transactionDepthProbe: { currentTransactionDepth: () => 0 } }),
  { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' })
  const retire = (objectId: string) => cleanupApplication.retireExpiredAttachmentStage(objectId)
  try {
    await assert.rejects(retire(uploaded.objectId))
    assert.equal(storageCalls, 0)
    await assert.rejects(sql`UPDATE meta_recovery_archive_attachment_stages
      SET state='abandoned',abandoned_at=clock_timestamp() WHERE object_id=${uploaded.objectId}::uuid`.execute(db))
    await sql`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ${expiresAt}::timestamptz-clock_timestamp()))+0.02)`.execute(db)
    // The original metadata remains an authority reference, irrespective of logical deletion.
    await sql`UPDATE multitable_attachments SET storage_file_id=${uploaded.objectId}
      WHERE id='att-original'`.execute(db)
    await assert.rejects(retire(uploaded.objectId))
    assert.equal(storageCalls, 0)
    await sql`UPDATE multitable_attachments SET storage_file_id=${first.objectId}
      WHERE id='att-original'`.execute(db)
    await assert.rejects(retire(uploaded.objectId))
    assert.equal(storageCalls, 1)
    const failed = (await sql<{ state: string; cleaned_at: unknown }>`SELECT state,cleaned_at
      FROM meta_recovery_archive_attachment_stages WHERE object_id=${uploaded.objectId}::uuid`.execute(db)).rows[0]
    assert.deepEqual(failed, { state: 'abandoned', cleaned_at: null })
    await assert.rejects(cleanupLedger.verified(uploaded.objectId, { ...cleanupIdentity, attachmentId: 'expired-upload' }))
    throwAfterRetire = false
    await retire(uploaded.objectId)
    const afterRetry = storageCalls
    const terminalBeforeRetry = (await sql`SELECT * FROM meta_recovery_archive_attachment_stages
      WHERE object_id=${uploaded.objectId}::uuid`.execute(db)).rows
    const lateMarker = await mkdtemp(join(storageRoot, '.recovery-reserve-'))
    await writeFile(join(lateMarker, '.recovery-restore-owner'), JSON.stringify({ version: 1,
      key: key(uploaded.objectId), owner: uploaded.ownershipKey }))
    const unknownMarker = await mkdtemp(join(storageRoot, '.recovery-reserve-'))
    await writeFile(join(unknownMarker, '.recovery-restore-owner'), 'incomplete-proof')
    await retire(uploaded.objectId)
    await assert.rejects(lstat(lateMarker), { code: 'ENOENT' })
    assert.equal((await lstat(unknownMarker)).isDirectory(), true)
    assert.equal(storageCalls, afterRetry + 1)
    assert.deepEqual((await sql`SELECT * FROM meta_recovery_archive_attachment_stages
      WHERE object_id=${uploaded.objectId}::uuid`.execute(db)).rows, terminalBeforeRetry)
    const beforeReferencedReplay = storageCalls
    await sql`UPDATE multitable_attachments SET storage_file_id=${uploaded.objectId}
      WHERE id='att-original'`.execute(db)
    await assert.rejects(retire(uploaded.objectId))
    assert.equal(storageCalls, beforeReferencedReplay)
    await sql`UPDATE multitable_attachments SET storage_file_id=${first.objectId}
      WHERE id='att-original'`.execute(db)
    console.log('PASS: terminal cleanup replay reconciles proven late markers, preserves unknown proof and immutable terminal row, and refuses current references before storage')
    await retire(untouched.objectId)
    await retire(late.objectId)
    await delayed.writeFile(bytes)
    await delayed.sync()
    assert.equal((await lstat(join(storageRoot, key(late.objectId)))).isDirectory(), true)
    await assert.rejects(open(join(storageRoot, key(late.objectId)), 'wx'), { code: 'EEXIST' })
    for (const row of [uploaded, untouched, late]) {
      assert.equal((await sql<{ state: string }>`SELECT state FROM meta_recovery_archive_attachment_stages
        WHERE object_id=${row.objectId}::uuid`.execute(db)).rows[0]?.state, 'cleaned')
      await assert.rejects(sql`UPDATE meta_recovery_archive_attachment_stages SET state='verified',
        abandoned_at=NULL,cleaned_at=NULL,verified_at=clock_timestamp() WHERE object_id=${row.objectId}::uuid`.execute(db))
    }
    console.log('PASS: expired-only abandonment commits before storage; live references refuse; post-retirement failure retries; unstarted and late writer cleanup cannot reopen apply')
  } finally { await cleanupApplication.stopWorker(); cleanupApplication.releaseCustody(); await delayed.close() }
  await assert.rejects(retire(uploaded.objectId), { message: 'RECOVERY_ARCHIVE_ATTACHMENT_CLEANUP_REFUSED' })
  console.log('PASS: explicitly composed cleanup uses real ledger/local storage and refuses after application stop; no worker or unrelated provider called')
  // Real row-lock arbitration: an apply admitted before expiry commits while cleanup waits.
  await sql`ALTER TABLE meta_records ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(db)
  await sql`UPDATE meta_records SET data='{"f":["att-original","att-race"]}'::jsonb WHERE id='r'`.execute(db)
  await sql`CREATE TABLE meta_recovery_archive_sync_receipts
    (token_sha256 text,sheet_id text,operation_id uuid,archive_generation_id uuid)`.execute(db)
  await sql`CREATE TABLE meta_recovery_token_burns
    (token_sha256 text,actor_id text,sheet_id text,burn_kind text,sync_operation_id uuid,archive_generation_id uuid)`.execute(db)
  await sql`INSERT INTO multitable_attachments (id,storage_path,sheet_id,record_id,field_id,
    storage_file_id,filename,original_name,mime_type,size,storage_provider)
    VALUES ('att-race','race/old','s','r','f','race-old','retained.bin','original.bin',
      'application/octet-stream',4,'local')`.execute(db)
  const raceActor = randomUUID(), raceOperation = randomUUID(), raceToken = '9'.repeat(64)
  const raceExpiry = new Date(Date.now() + 1500).toISOString()
  const raceIdentity = { ...cleanupIdentity, attachmentId: 'att-race' }
  const raceLedger = createArchiveAttachmentStageLedger({ actorId: raceActor, tokenHash: raceToken,
    tokenExpiresAt: raceExpiry, authorize: async () => true, transaction })
  const raceObject = await raceLedger.reserve(raceIdentity)
  await raceLedger.verified(raceObject.objectId, raceIdentity)
  const raceMetadata = (await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
    FROM multitable_attachments a WHERE id='att-race'`.execute(db)).rows[0]!.metadata
  let admit!: () => void, release!: () => void
  const admitted = new Promise<void>(resolve => { admit = resolve })
  const commit = new Promise<void>(resolve => { release = resolve })
  let writerPid = 0, cleanupPid = 0, unexpectedStorage = 0
  const writer = transaction(async query => {
    await applyVerifiedArchiveAttachmentMetadata(query, { ...applyInput, actorId: raceActor,
      tokenHash: raceToken, objectId: raceObject.objectId, identity: raceIdentity,
      expectedMetadataHash: hashArchiveAttachmentMetadata(raceMetadata), adoptionOperationId: raceOperation })
    await query(`INSERT INTO meta_recovery_archive_sync_receipts VALUES ($1,'s',$2::uuid,$3::uuid)`,
      [raceToken, raceOperation, generationId])
    await query(`INSERT INTO meta_recovery_token_burns VALUES ($1,$2,'s','sync',$3::uuid,$4::uuid)`,
      [raceToken, raceActor, raceOperation, generationId])
    writerPid = Number(((await query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
    admit()
    await commit
  }).then(() => ({ ok: true }), error => { admit(); return { error } })
  let cleaner: Promise<unknown> | undefined
  try {
    await admitted
    assert.ok(writerPid > 0)
    await sql`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ${raceExpiry}::timestamptz-clock_timestamp()))+0.02)`.execute(db)
    cleaner = retireExpiredArchiveAttachmentStage({ objectId: raceObject.objectId,
      transaction: work => transaction(async query => {
        cleanupPid = Number(((await query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
        return work(query)
      }), transactionDepth: { currentTransactionDepth: () => 0 },
      storage: { retireRecoveryAttachment: async () => { unexpectedStorage++ } },
    }).then(() => ({ ok: true }), error => ({ error }))
    let blocked = false
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      if (cleanupPid) blocked = (await sql<{ blocked: boolean }>`SELECT ${writerPid}::int = ANY(pg_blocking_pids(${cleanupPid})) AS blocked`.execute(db)).rows[0]?.blocked === true
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(blocked, true)
    release()
    assert.deepEqual(await writer, { ok: true })
    const cleanupResult = await cleaner as { error?: unknown }
    assert.ok(cleanupResult.error)
    assert.equal(unexpectedStorage, 0)
    assert.equal((await sql<{ state: string }>`SELECT state FROM meta_recovery_archive_attachment_stages
      WHERE object_id=${raceObject.objectId}::uuid`.execute(db)).rows[0]?.state, 'applied')
    console.log('PASS: cleanup waits on in-flight apply across token expiry; committed adoption wins with zero storage cleanup')
  } finally { release(); await writer; await cleaner }
  // Reverse ordering: cleanup has committed its claim, but physical retirement has not run.
  const cleanupFirstActor = randomUUID(), cleanupFirstToken = 'a'.repeat(64)
  const cleanupFirstExpiry = new Date(Date.now() + 1500).toISOString()
  const cleanupFirstLedger = createArchiveAttachmentStageLedger({ actorId: cleanupFirstActor,
    tokenHash: cleanupFirstToken, tokenExpiresAt: cleanupFirstExpiry,
    authorize: async () => true, transaction })
  const cleanupFirstObject = await cleanupFirstLedger.reserve(raceIdentity)
  await cleanupFirstLedger.verified(cleanupFirstObject.objectId, raceIdentity)
  await storage.reserveRecoveryAttachment(key(cleanupFirstObject.objectId), cleanupFirstObject.ownershipKey)
  await storage.uploadByKey(key(cleanupFirstObject.objectId), bytes)
  const beforeLateApply = (await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
    FROM multitable_attachments a WHERE id='att-race'`.execute(db)).rows[0]!.metadata
  await sql`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ${cleanupFirstExpiry}::timestamptz-clock_timestamp()))+0.02)`.execute(db)
  let lateApplyAttempts = 0
  await retireExpiredArchiveAttachmentStage({ objectId: cleanupFirstObject.objectId, transaction,
    transactionDepth: { currentTransactionDepth: () => 0 },
    storage: { retireRecoveryAttachment: async (path, owner) => {
      assert.equal((await sql<{ state: string }>`SELECT state FROM meta_recovery_archive_attachment_stages
        WHERE object_id=${cleanupFirstObject.objectId}::uuid`.execute(db!)).rows[0]?.state, 'abandoned')
      lateApplyAttempts++
      await assert.rejects(transaction(query => applyVerifiedArchiveAttachmentMetadata(query, {
        ...applyInput, actorId: cleanupFirstActor, tokenHash: cleanupFirstToken,
        objectId: cleanupFirstObject.objectId, identity: raceIdentity,
        expectedMetadataHash: hashArchiveAttachmentMetadata(beforeLateApply), adoptionOperationId: randomUUID(),
      })), { message: 'ARCHIVE_ATTACHMENT_RESTORE_APPLY_REFUSED' })
      assert.deepEqual((await sql<{ metadata: Record<string, unknown> }>`SELECT to_jsonb(a) AS metadata
        FROM multitable_attachments a WHERE id='att-race'`.execute(db!)).rows[0]!.metadata, beforeLateApply)
      await cleanupStorage.retireRecoveryAttachment(path, owner)
    } },
  })
  assert.equal(lateApplyAttempts, 1)
  assert.equal((await sql<{ state: string }>`SELECT state FROM meta_recovery_archive_attachment_stages
    WHERE object_id=${cleanupFirstObject.objectId}::uuid`.execute(db)).rows[0]?.state, 'cleaned')
  console.log('PASS: cleanup claim commits before a separate canonical adoption attempt; late adoption refuses without metadata effects before physical retirement')
  for (const destructive of [
    `DELETE FROM meta_recovery_archive_attachment_stages`,
    `TRUNCATE meta_recovery_archive_attachment_stages`,
    `UPDATE meta_recovery_archive_attachment_stages SET state='reserved',verified_at=NULL`,
    `UPDATE meta_recovery_archive_attachment_stages SET field_id='other'`,
  ]) await assert.rejects(sql.raw(destructive).execute(db))
  await assert.rejects(db.transaction().execute(migration.down), { message: 'ARCHIVE_ATTACHMENT_RESTORE_STAGE_DOWN_IN_USE' })
  await sql`UPDATE meta_recovery_archives SET expires_at=clock_timestamp()-interval '1 second'`.execute(db)
  await assert.rejects(ledger.reserve(identity))
  await assert.rejects(ledger.verified(first.objectId, identity))
  assert.equal((await sql<{ n: number }>`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_stages`.execute(db)).rows[0]?.n, 7)
  console.log('PASS: stage ledger replay, empty rollback, drift, concurrency, identity conflict, authority and nonempty rollback')
  await db.destroy()
  db = undefined
  await awaitOwnedBackendExit()
  const held = new Client({ ...connection, database })
  try {
    await held.connect()
    await assert.rejects(awaitOwnedBackendExit(2), { message: 'ATTACHMENT_STAGE_BACKEND_DRAIN_TIMEOUT' })
  } finally {
    await held.end()
  }
  console.log('PASS: backend drain refuses a held connection without terminating it')
} finally {
  await db?.destroy()
  if (created) {
    // Pool.end() can resolve before PostgreSQL observes every client disconnect.
    await awaitOwnedBackendExit()
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)
    await admin.query(`DROP DATABASE "${database}"`)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [database])).rows[0].n, 0)
    console.log('CLEAN: stage database and connections=0')
  }
  await admin.end()
  await rm(storageRoot, { recursive: true })
}
