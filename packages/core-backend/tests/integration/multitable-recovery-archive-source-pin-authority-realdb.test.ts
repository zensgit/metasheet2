import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as sourcePinMigration from '../../src/db/migrations/zzzz20260828124000_add_recovery_archive_source_pin_authority'
import { cleanupOrphanMultitableAttachments } from '../../src/multitable/attachment-orphan-retention'
import {
  claimRecoveryArchiveSourcePinIntent,
  RecoveryArchiveSourcePinError,
  verifyRecoveryArchiveSourcePin,
} from '../../src/multitable/recovery-archive-source-pin'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: source-pin authority real-DB step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_source_pin_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_source_pin_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OWNER_KIND = 'archive_builder'
const OWNER_ID = `${PREFIX}_owner`
const KEY_ID = `${PREFIX}_key`
const ANCHOR_OPERATION = randomUUID()
const ANCHOR_SEQ = '9007199254747993'
const SOURCE_VECTOR_HASH = '1'.repeat(64)
const CONTENT_HASH = '2'.repeat(64)
const ROOT_HASH = '3'.repeat(64)
const COVERAGE_HASH = '4'.repeat(64)
const RECEIPT_HASH = '5'.repeat(64)
const FUTURE_LEASE = '2099-01-01T00:00:00.000Z'
const EXPIRED_LEASE = '2000-01-01T00:00:00.000Z'
const SOURCE_VERSION = `${PREFIX}_source_version`
const ARCHIVE_VERSION = `${PREFIX}_archive_version`
const CONTENT_SIZE = '17'

type QueryResult = { rows: unknown[]; rowCount?: number | null }
type Query = (text: string, values?: unknown[]) => Promise<QueryResult>
type DatabaseError = Error & { code?: string; detail?: string; where?: string }

let pool: Pool
let db: Kysely<unknown>

const q: Query = (text, values) => pool.query(text, values)

async function transaction<T>(work: (client: { query: Query }) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work({ query: client.query.bind(client) })
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_database_rejection')
}

function expectValuesFree(error: DatabaseError, forbiddenValues: string[]): void {
  const rendered = [error.message, error.detail, error.where].filter(Boolean).join(' ')
  for (const value of forbiddenValues) expect(rendered).not.toContain(value)
}

async function installIfAbsent(): Promise<void> {
  const result = await q(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='meta_recovery_archive_attachment_refs'
          AND column_name='source_owner_kind'
     ) AS installed`,
  )
  if (!result.rows[0]?.installed) await sourcePinMigration.up(db)
}

async function truncateCatalog(): Promise<void> {
  await q(
    `TRUNCATE TABLE
       meta_recovery_archive_snapshot_reservations,
       meta_recovery_archive_staging_objects,
       meta_recovery_archive_attachment_refs,
       meta_recovery_archive_coverage_items,
       meta_recovery_archives`,
  )
}

async function seedSealedOperation(): Promise<void> {
  await transaction(async ({ query }) => {
    await query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source,
         changed_field_ids, patch, snapshot, seq, operation_id
       ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
                 '{}'::jsonb, $4::bigint, $5::uuid)`,
      [randomUUID(), SHEET, `${PREFIX}_anchor_record`, ANCHOR_SEQ, ANCHOR_OPERATION],
    )
    await query(
      `INSERT INTO meta_record_history_operations (
         sheet_id, operation_id, endpoint_seq, event_count
       ) VALUES ($1, $2::uuid, $3::bigint, 1)`,
      [SHEET, ANCHOR_OPERATION, ANCHOR_SEQ],
    )
  })
}

async function insertArchive(leaseUntil = FUTURE_LEASE): Promise<string> {
  const generationId = randomUUID()
  await q(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, format_version, state, build_status, coverage_status,
       source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, 1, 'building', 'active', 'incomplete',
       $8, $9, $10, $11, 1,
       $12::timestamptz, '2099-12-31T00:00:00.000Z'::timestamptz
     )`,
    [
      generationId,
      WORKSPACE,
      BASE,
      SHEET,
      ANCHOR_OPERATION,
      ANCHOR_SEQ,
      CHECKPOINT,
      SOURCE_VECTOR_HASH,
      KEY_ID,
      OWNER_KIND,
      OWNER_ID,
      leaseUntil,
    ],
  )
  return generationId
}

function owner(generationId: string, attachmentId: string, leaseUntil = FUTURE_LEASE) {
  return {
    generationId,
    attachmentId,
    keyId: KEY_ID,
    ownerKind: OWNER_KIND,
    ownerId: OWNER_ID,
    ownerFence: '1',
    leaseUntil,
  }
}

async function claimIntent(
  generationId: string,
  attachmentId: string,
  leaseUntil = FUTURE_LEASE,
) {
  return transaction(({ query }) => claimRecoveryArchiveSourcePinIntent(
    query,
    owner(generationId, attachmentId, leaseUntil),
  ))
}

async function verifyIntent(generationId: string, attachmentId: string) {
  return transaction(({ query }) => verifyRecoveryArchiveSourcePin(query, {
    ...owner(generationId, attachmentId),
    immutableVersion: SOURCE_VERSION,
    contentSha256: CONTENT_HASH,
    contentSizeBytes: CONTENT_SIZE,
  }))
}

async function insertMutableIntentForExpiredGeneration(
  generationId: string,
  attachmentId: string,
): Promise<void> {
  await q(
    `INSERT INTO meta_recovery_archive_attachment_refs (
       generation_id, attachment_id, reference_class, reference_state,
       availability, source_owner_kind, source_owner_id, source_owner_fence, source_lease_until
     )
     SELECT archive.generation_id, $2, 'source', 'building', 'mutable',
            archive.owner_kind, archive.owner_id, archive.owner_fence, archive.lease_expires_at
       FROM meta_recovery_archives archive
      WHERE archive.generation_id=$1::uuid`,
    [generationId, attachmentId],
  )
}

async function insertAttachment(attachmentId: string): Promise<void> {
  await q(
    `INSERT INTO multitable_attachments (
       id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, size,
       storage_path, storage_provider, metadata, created_at, updated_at, deleted_at
     ) VALUES (
       $1, $2, NULL, NULL, $3, 'attachment', 'application/octet-stream', 1,
       $4, 'local', '{}'::jsonb, '2000-01-01T00:00:00.000Z'::timestamptz,
       '2000-01-01T00:00:00.000Z'::timestamptz, NULL
     )`,
    [attachmentId, SHEET, `${attachmentId}_file`, `${attachmentId}/blob`],
  )
}

async function waitForLeaseExpiry(leaseUntil: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT clock_timestamp() >= $1::timestamptz AS expired`,
      [leaseUntil],
    )
    if (result.rows[0]?.expired === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('recovery_archive_source_pin_lease_expiry_timeout')
}

async function authorityFingerprint(): Promise<string> {
  const result = await q(
    `SELECT pg_catalog.md5(string_agg(component, E'\n' ORDER BY component)) AS fingerprint
       FROM (
         SELECT 'column:' || attribute.attname || ':' ||
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS component
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid='public.meta_recovery_archive_attachment_refs'::regclass
            AND attribute.attname IN (
              'source_owner_kind', 'source_owner_id', 'source_owner_fence',
              'source_lease_until', 'immutable_version', 'content_size_bytes'
            )
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
         UNION ALL
         SELECT 'constraint:' || constraint_row.conname || ':' ||
                pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
           FROM pg_catalog.pg_constraint constraint_row
          WHERE constraint_row.conrelid='public.meta_recovery_archive_attachment_refs'::regclass
            AND constraint_row.conname LIKE 'chk_meta_recovery_archive_attachment_%'
         UNION ALL
         SELECT 'function:' || procedure_row.proname || ':' || pg_catalog.md5(procedure_row.prosrc)
           FROM pg_catalog.pg_proc procedure_row
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public'
            AND procedure_row.proname='meta_recovery_archive_attachment_authority_guard_row'
         UNION ALL
         SELECT 'trigger:' || trigger_row.tgname || ':' || trigger_row.tgtype::text
           FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgrelid='public.meta_recovery_archive_attachment_refs'::regclass
            AND trigger_row.tgname='trg_meta_recovery_archive_attachment_authority_guard_row'
            AND NOT trigger_row.tgisinternal
       ) components`,
  )
  return String(result.rows[0]?.fingerprint ?? '')
}

describeIfRealDbStep('D2 attachment source-pin authority (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installIfAbsent()
    await truncateCatalog()
    await q('INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)', [KEY_ID])
    await q('INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)', [
      BASE,
      `${PREFIX} Base`,
      WORKSPACE,
    ])
    await q('INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1, $2, $3, NULL)', [
      SHEET,
      BASE,
      `${PREFIX} Sheet`,
    ])
    await seedSealedOperation()
    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1, $2, 'active', $3::bigint)`,
      [CHECKPOINT, SHEET, ANCHOR_SEQ],
    )
  })

  afterEach(async () => {
    await q('DELETE FROM multitable_attachments WHERE sheet_id=$1', [SHEET])
    await truncateCatalog()
  })

  afterAll(async () => {
    try {
      await installIfAbsent()
      await truncateCatalog()
      await q('DELETE FROM meta_history_trust_checkpoints WHERE id=$1', [CHECKPOINT]).catch(() => {})
      await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [
        SHEET,
        ANCHOR_OPERATION,
      ]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id=$1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
      await transaction(async ({ query }) => {
        await query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
        await query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
        await query('DELETE FROM meta_recovery_archive_keys WHERE key_id=$1', [KEY_ID])
        await query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
      })
    } finally {
      await db.destroy()
    }
  })

  test('schema authority is exact and empty down/up replay is byte-stable', async () => {
    const before = await authorityFingerprint()
    expect(before).toMatch(/^[0-9a-f]{32}$/)

    await sourcePinMigration.down(db)
    await sourcePinMigration.up(db)

    expect(await authorityFingerprint()).toBe(before)
  })

  test('up fails loud on a partial owned-column drift', async () => {
    await sourcePinMigration.down(db)
    await q(
      `ALTER TABLE meta_recovery_archive_attachment_refs
         ADD COLUMN source_owner_kind integer`,
    )
    const refusal = await errorOf(sourcePinMigration.up(db))
    expect(refusal.message).toBe('recovery_archive_source_pin_object_conflict')
    await q(
      `ALTER TABLE meta_recovery_archive_attachment_refs
         DROP COLUMN source_owner_kind`,
    )
    await sourcePinMigration.up(db)
  })

  test('up fails loud on a wrong same-name function', async () => {
    await sourcePinMigration.down(db)
    await q(
      `CREATE FUNCTION public.meta_recovery_archive_attachment_authority_guard_row()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    )
    const refusal = await errorOf(sourcePinMigration.up(db))
    expect(refusal.message).toBe('recovery_archive_source_pin_object_conflict')
    await q('DROP FUNCTION public.meta_recovery_archive_attachment_authority_guard_row()')
    await sourcePinMigration.up(db)
  })

  test('claim persists only a non-authorizing mutable intent, then exact owner verifies it', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_claim`
    const intent = await claimIntent(generationId, attachmentId)
    expect(intent).toMatchObject({
      availability: 'mutable',
      immutableVersion: null,
      contentSha256: null,
      contentSizeBytes: null,
      ownerFence: '1',
    })

    const nonAuthorizing = await q(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid
          AND attachment_id=$2
          AND availability='available'
          AND immutable_version IS NOT NULL
          AND content_sha256 IS NOT NULL
          AND content_size_bytes IS NOT NULL`,
      [generationId, attachmentId],
    )
    expect(nonAuthorizing.rows).toEqual([{ count: 0 }])

    const verified = await verifyIntent(generationId, attachmentId)
    expect(verified).toMatchObject({
      availability: 'available',
      immutableVersion: SOURCE_VERSION,
      contentSha256: CONTENT_HASH,
      contentSizeBytes: CONTENT_SIZE,
    })

    const immutable = await errorOf(q(
      `UPDATE meta_recovery_archive_attachment_refs
          SET immutable_version=$3
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
      [generationId, attachmentId, `${SOURCE_VERSION}_changed`],
    ))
    expect(immutable.message).toBe('recovery_archive_source_pin_verified_immutable')
  })

  test('helpers reject autocommit before claim or verification can persist', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_autocommit`
    const refusal = await errorOf(claimRecoveryArchiveSourcePinIntent(
      q,
      owner(generationId, attachmentId),
    ))
    expect(refusal).toBeInstanceOf(RecoveryArchiveSourcePinError)
    expect(refusal.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_NOT_IN_TRANSACTION')
    expectValuesFree(refusal, [generationId, attachmentId, OWNER_ID])

    const residue = await q(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [generationId, attachmentId],
    )
    expect(residue.rows).toEqual([{ count: 0 }])

    const verificationAttachmentId = `${attachmentId}_verify`
    await claimIntent(generationId, verificationAttachmentId)
    const verificationRefusal = await errorOf(verifyRecoveryArchiveSourcePin(q, {
      ...owner(generationId, verificationAttachmentId),
      immutableVersion: SOURCE_VERSION,
      contentSha256: CONTENT_HASH,
      contentSizeBytes: CONTENT_SIZE,
    }))
    expect(verificationRefusal).toBeInstanceOf(RecoveryArchiveSourcePinError)
    expect(verificationRefusal.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_NOT_IN_TRANSACTION')
    const stillMutable = await q(
      `SELECT availability FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [generationId, verificationAttachmentId],
    )
    expect(stillMutable.rows).toEqual([{ availability: 'mutable' }])
  })

  test('retiring the exact key closes source-pin admission', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_retiring_key`
    try {
      await q(
        `UPDATE meta_recovery_archive_keys
            SET state='retiring', row_version=row_version + 1
          WHERE key_id=$1`,
        [KEY_ID],
      )
      const refusal = await errorOf(transaction(({ query }) => claimRecoveryArchiveSourcePinIntent(
        query,
        owner(generationId, attachmentId),
      )))
      expect(refusal).toBeInstanceOf(RecoveryArchiveSourcePinError)
      expect(refusal.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED')
      const residue = await q(
        `SELECT count(*)::int AS count FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2`,
        [generationId, attachmentId],
      )
      expect(residue.rows).toEqual([{ count: 0 }])
    } finally {
      await transaction(async ({ query }) => {
        await query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
        await query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
        await query(
          `UPDATE meta_recovery_archive_keys
              SET state='active', row_version=1
            WHERE key_id=$1`,
          [KEY_ID],
        )
        await query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
      })
    }
  })

  test('source-pin admission retains the active-key lock through commit', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_key_lock`
    const pinClient = await pool.connect()
    const retirementClient = await pool.connect()
    try {
      await pinClient.query('BEGIN')
      await claimRecoveryArchiveSourcePinIntent(
        (text, values) => pinClient.query(text, values),
        owner(generationId, attachmentId),
      )

      await retirementClient.query('BEGIN')
      await retirementClient.query(`SET LOCAL lock_timeout = '100ms'`)
      const blocked = await errorOf(retirementClient.query(
        `UPDATE meta_recovery_archive_keys
            SET state='retiring', row_version=row_version + 1
          WHERE key_id=$1`,
        [KEY_ID],
      ))
      expect(blocked.code).toBe('55P03')
      await retirementClient.query('ROLLBACK')
      await pinClient.query('COMMIT')

      const key = await q(
        `SELECT state, row_version::text AS row_version
           FROM meta_recovery_archive_keys WHERE key_id=$1`,
        [KEY_ID],
      )
      expect(key.rows).toEqual([{ state: 'active', row_version: '1' }])
    } catch (error) {
      await retirementClient.query('ROLLBACK').catch(() => {})
      await pinClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      retirementClient.release()
      pinClient.release()
    }
  })

  test('helper normalizes duplicate and malformed claims without echoing values', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_duplicate`
    await claimIntent(generationId, attachmentId)

    const duplicate = await errorOf(transaction(({ query }) => claimRecoveryArchiveSourcePinIntent(
      query,
      owner(generationId, attachmentId),
    )))
    expect(duplicate).toBeInstanceOf(RecoveryArchiveSourcePinError)
    expect(duplicate.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED')
    expectValuesFree(duplicate, [generationId, attachmentId, OWNER_ID])

    const malformedGenerationId = `${PREFIX}_not_a_uuid`
    const malformed = await errorOf(transaction(({ query }) => claimRecoveryArchiveSourcePinIntent(
      query,
      owner(malformedGenerationId, `${PREFIX}_malformed`),
    )))
    expect(malformed).toBeInstanceOf(RecoveryArchiveSourcePinError)
    expect(malformed.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED')
    expectValuesFree(malformed, [malformedGenerationId, OWNER_ID])
  })

  test('stale owner, fence, and lease writes refuse without echoing values', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_stale`
    await claimIntent(generationId, attachmentId)

    for (const stale of [
      { ownerKind: `${OWNER_KIND}_stale` },
      { ownerId: `${OWNER_ID}_stale` },
      { ownerFence: '2' },
      { leaseUntil: '2098-01-01T00:00:00.000Z' },
    ]) {
      const error = await errorOf(transaction(({ query }) => verifyRecoveryArchiveSourcePin(query, {
        ...owner(generationId, attachmentId),
        ...stale,
        immutableVersion: SOURCE_VERSION,
        contentSha256: CONTENT_HASH,
        contentSizeBytes: CONTENT_SIZE,
      })))
      expect(error).toBeInstanceOf(RecoveryArchiveSourcePinError)
      expect(error.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_VERIFICATION_REFUSED')
      expectValuesFree(error, [generationId, attachmentId, OWNER_ID])
    }

    const staleRaw = await errorOf(q(
      `INSERT INTO meta_recovery_archive_attachment_refs (
         generation_id, attachment_id, reference_class, reference_state, availability,
         source_owner_kind, source_owner_id, source_owner_fence, source_lease_until
       ) VALUES ($1::uuid, $2, 'source', 'building', 'mutable', $3, $4, 2, $5::timestamptz)`,
      [generationId, `${attachmentId}_raw`, OWNER_KIND, OWNER_ID, FUTURE_LEASE],
    ))
    expect(staleRaw.message).toBe('recovery_archive_source_pin_owner_invalid')

    const rawUpdateAttachmentId = `${attachmentId}_raw_update`
    await claimIntent(generationId, rawUpdateAttachmentId)
    const staleRawUpdate = await errorOf(q(
      `UPDATE meta_recovery_archive_attachment_refs
          SET source_lease_until='2098-01-01T00:00:00.000Z'::timestamptz
        WHERE generation_id=$1::uuid
          AND attachment_id=$2
          AND reference_class='source'`,
      [generationId, rawUpdateAttachmentId],
    ))
    expect(staleRawUpdate.message).toBe('recovery_archive_source_pin_owner_invalid')

    const expiredGenerationId = await insertArchive(EXPIRED_LEASE)
    const expiredRaw = await errorOf(q(
      `INSERT INTO meta_recovery_archive_attachment_refs (
         generation_id, attachment_id, reference_class, reference_state, availability,
         source_owner_kind, source_owner_id, source_owner_fence, source_lease_until
       )
       SELECT archive.generation_id, $2, 'source', 'building', 'mutable',
              archive.owner_kind, archive.owner_id, archive.owner_fence, archive.lease_expires_at
         FROM meta_recovery_archives archive
        WHERE archive.generation_id=$1::uuid`,
      [expiredGenerationId, `${attachmentId}_expired_raw`],
    ))
    expect(expiredRaw.message).toBe('recovery_archive_source_pin_lease_expired')
    expectValuesFree(expiredRaw, [expiredGenerationId, attachmentId, OWNER_ID])
  })

  test('available posture requires immutable version, lowercase hash, and nonnegative size', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_shape`
    await claimIntent(generationId, attachmentId)
    const refusal = await errorOf(q(
      `UPDATE meta_recovery_archive_attachment_refs
          SET availability='available', content_sha256=$3
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
      [generationId, attachmentId, CONTENT_HASH],
    ))
    expect(refusal.code).toBe('23514')

    await claimIntent(generationId, `${attachmentId}_helper`)
    const invalidHash = await errorOf(transaction(({ query }) => verifyRecoveryArchiveSourcePin(query, {
      ...owner(generationId, `${attachmentId}_helper`),
      immutableVersion: SOURCE_VERSION,
      contentSha256: 'A'.repeat(64),
      contentSizeBytes: CONTENT_SIZE,
    })))
    expect(invalidHash.message).toBe('RECOVERY_ARCHIVE_SOURCE_PIN_INVALID_INPUT')
  })

  test('archive-object authority is distinct, immutable, and source release cannot remove it', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_archive_object`
    await claimIntent(generationId, attachmentId)
    await verifyIntent(generationId, attachmentId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO meta_recovery_archive_attachment_refs (
           generation_id, attachment_id, reference_class, reference_state, availability,
           content_sha256, immutable_version, content_size_bytes
         ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, $5::bigint)`,
        [generationId, attachmentId, CONTENT_HASH, ARCHIVE_VERSION, CONTENT_SIZE],
      )
      await client.query(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
        [generationId, attachmentId],
      )
      await client.query(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_section_hash=$3, coverage_row_count=0,
                manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('source-pin-authority-mac')],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const deleteRefusal = await errorOf(q(
      `DELETE FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='archive_object'`,
      [generationId, attachmentId],
    ))
    expect(deleteRefusal.message).toBe('recovery_archive_attachment_ref_immutable')

    const sourceRelease = await errorOf(q(
      `SELECT meta_recovery_archive_release_abandoned_source_pin(
         $1::uuid, $2, 'archive_cleanup', $3, 2
       )`,
      [generationId, attachmentId, `${PREFIX}_cleanup`],
    ))
    expect(sourceRelease.message).toBe('recovery_archive_attachment_cleanup_release_refused')
    const retained = await q(
      `SELECT immutable_version, content_sha256, content_size_bytes::text
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='archive_object'`,
      [generationId, attachmentId],
    )
    expect(retained.rows).toEqual([{
      immutable_version: ARCHIVE_VERSION,
      content_sha256: CONTENT_HASH,
      content_size_bytes: CONTENT_SIZE,
    }])
  })

  test('expired mutable pin still blocks physical deletion until owner-safe cleanup consumes it', async () => {
    const previousArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    const previousFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    try {
      const expiringLease = new Date(Date.now() + 2_000).toISOString()
      const generationId = await insertArchive(expiringLease)
      const attachmentId = `${PREFIX}_expired`
      const stagingObjectId = randomUUID()
      await insertMutableIntentForExpiredGeneration(generationId, attachmentId)
      await insertAttachment(attachmentId)
      await q(
        `INSERT INTO meta_recovery_archive_staging_objects (
           generation_id, staging_object_id, object_class, attachment_id, object_state, key_id
         ) VALUES ($1::uuid, $2::uuid, 'attachment', $3, 'pending', $4)`,
        [generationId, stagingObjectId, attachmentId, KEY_ID],
      )
      await waitForLeaseExpiry(expiringLease)

      let storageCalls = 0
      const blocked = await cleanupOrphanMultitableAttachments({
        queryFn: q,
        transactionFn: transaction,
        storage: { delete: async () => { storageCalls += 1 } },
      })
      expect(blocked).toEqual({ inspected: 1, deleted: 0, skipped: 1 })
      expect(storageCalls).toBe(0)

      const blindDelete = await errorOf(q(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
        [generationId, attachmentId],
      ))
      expect(blindDelete.message).toBe('recovery_archive_source_pin_owner_invalid')

      await q(
        `UPDATE meta_recovery_archives SET build_status='abandoned'
          WHERE generation_id=$1::uuid`,
        [generationId],
      )
      await q(
        `SELECT meta_recovery_archive_claim_abandoned_cleanup(
           $1::uuid, $2, $3, 1, 'archive_cleanup', $4, $5::timestamptz
         )`,
        [generationId, OWNER_KIND, OWNER_ID, `${PREFIX}_cleanup`, FUTURE_LEASE],
      )
      await q(
        `UPDATE meta_recovery_archive_staging_objects
            SET object_state='absent', terminal_receipt_sha256=$3,
                cleanup_owner_kind='archive_cleanup', cleanup_owner_id=$4, cleanup_owner_fence=2
          WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
        [generationId, stagingObjectId, RECEIPT_HASH, `${PREFIX}_cleanup`],
      )
      await transaction(({ query }) => query(
        `SELECT meta_recovery_archive_release_abandoned_source_pin(
           $1::uuid, $2, 'archive_cleanup', $3, 2
         )`,
        [generationId, attachmentId, `${PREFIX}_cleanup`],
      ))

      const released = await q(
        `SELECT count(*)::int AS count
           FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
        [generationId, attachmentId],
      )
      expect(released.rows).toEqual([{ count: 0 }])
    } finally {
      if (previousArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = previousArchiveFlag
      if (previousFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFenceFlag
    }
  })

  test('down refuses authority-bearing rows without dropping the surface', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_down`
    await claimIntent(generationId, attachmentId)

    const refusal = await errorOf(sourcePinMigration.down(db))
    expect(refusal.message).toBe('recovery_archive_source_pin_authority_nonempty')
    const retained = await q(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [generationId, attachmentId],
    )
    expect(retained.rows).toEqual([{ count: 1 }])
  })
})
