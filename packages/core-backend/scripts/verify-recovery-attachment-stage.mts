import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { Client, Pool } from 'pg'
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely'

const require = createRequire(import.meta.url)
const migration = require('../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages.ts') as typeof import('../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages')
const { createArchiveAttachmentStageLedger } = require('../src/multitable/recovery-archive-attachment-stage-ledger.ts') as typeof import('../src/multitable/recovery-archive-attachment-stage-ledger')
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
let created = false
let db: Kysely<unknown> | undefined
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
  assert.equal((await sql<{ n: number }>`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_stages`.execute(db)).rows[0]?.n, 2)
  console.log('PASS: stage ledger replay, empty rollback, drift, concurrency, identity conflict, authority and nonempty rollback')
} finally {
  await db?.destroy()
  if (created) {
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)
    await admin.query(`DROP DATABASE "${database}"`)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [database])).rows[0].n, 0)
    console.log('CLEAN: stage database and connections=0')
  }
  await admin.end()
}
