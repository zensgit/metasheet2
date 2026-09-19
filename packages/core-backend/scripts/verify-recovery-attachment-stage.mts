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
  assert.equal((await sql<{ n: number }>`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_stages`.execute(db)).rows[0]?.n, 1)
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
