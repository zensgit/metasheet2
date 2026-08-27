import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as stagingCleanupMigration from '../../src/db/migrations/zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol'
import * as sourcePinAuthorityMigration from '../../src/db/migrations/zzzz20260828124000_add_recovery_archive_source_pin_authority'
import {
  cleanupOrphanMultitableAttachments,
  sweepMultitableAttachmentBlobPurge,
} from '../../src/multitable/attachment-orphan-retention'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2b real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_stale_pin_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2b_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OWNER = `${PREFIX}_builder`
const CLEANER = 'archive_cleanup'
const CLEANER_ID = `${PREFIX}_cleanup_owner`
const ATTACKER_ID = `${PREFIX}_attacker`
const KEY_ID = `${PREFIX}_key`
const ANCHOR_OPERATION = randomUUID()
const ANCHOR_SEQ = '9007199254746993'
const SOURCE_VECTOR_HASH = '1'.repeat(64)
const ATTACHMENT_HASH = '2'.repeat(64)
const RECEIPT_HASH = '3'.repeat(64)
const EXPIRED_LEASE = '2000-01-01T00:00:00.000Z'
const FUTURE_LEASE = '2099-01-01T00:00:00.000Z'

type TransactionQuery = (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

async function transaction<T>(work: (client: { query: TransactionQuery }) => Promise<T>): Promise<T> {
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

type DatabaseError = Error & {
  code?: string
  detail?: string
  where?: string
}

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = false
let keyRegistryIsUp = false

const q = (text: string, values?: unknown[]) => pool.query(text, values)

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

async function installCleanupProtocolIfAbsent(): Promise<void> {
  const surface = await q(
    `SELECT
       pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL AS staging,
       EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='meta_recovery_archive_attachment_refs'
            AND column_name='cleanup_owner_kind'
       ) AS cleanup_column`,
  )
  const row = surface.rows[0] as { staging: boolean; cleanup_column: boolean }
  if (!row.staging && !row.cleanup_column) await stagingCleanupMigration.up(db)
  else if (!row.staging || !row.cleanup_column) throw new Error('recovery_archive_stale_pin_partial_schema')
  schemaIsUp = true
}

async function seedSealedOperation(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source,
         changed_field_ids, patch, snapshot, seq, operation_id
       ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
                 '{}'::jsonb, $4::bigint, $5::uuid)`,
      [randomUUID(), SHEET, `${PREFIX}_anchor_record`, ANCHOR_SEQ, ANCHOR_OPERATION],
    )
    await client.query(
      `INSERT INTO meta_record_history_operations (
         sheet_id, operation_id, endpoint_seq, event_count
       ) VALUES ($1, $2::uuid, $3::bigint, 1)`,
      [SHEET, ANCHOR_OPERATION, ANCHOR_SEQ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function insertArchive(leaseExpiresAt = FUTURE_LEASE): Promise<string> {
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
       $8, $9, 'archive_builder', $10, 1,
       $11::timestamptz, '2099-12-31T00:00:00.000Z'::timestamptz
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
      OWNER,
      leaseExpiresAt,
    ],
  )
  return generationId
}

async function insertExpiringArchive(): Promise<string> {
  const lease = await q(
    `SELECT (clock_timestamp() + interval '250 milliseconds')::text AS lease_until`,
  )
  return insertArchive(String(lease.rows[0]?.lease_until))
}

async function waitForArchiveLeaseExpiry(generationId: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT lease_expires_at <= clock_timestamp() AS expired
         FROM meta_recovery_archives
        WHERE generation_id=$1::uuid`,
      [generationId],
    )
    if (result.rows[0]?.expired === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('recovery_archive_cleanup_fixture_lease_expiry_timeout')
}

async function abandon(generationId: string): Promise<void> {
  await q(
    `UPDATE meta_recovery_archives
        SET build_status='abandoned'
      WHERE generation_id=$1::uuid`,
    [generationId],
  )
}

async function insertSourcePin(generationId: string, attachmentId: string): Promise<void> {
  await q(
    `INSERT INTO meta_recovery_archive_attachment_refs (
       generation_id, attachment_id, reference_class, reference_state,
       availability, content_sha256,
       source_owner_kind, source_owner_id, source_owner_fence, source_lease_until
     )
     SELECT archive.generation_id, $2, 'source', 'building', 'mutable', NULL,
            archive.owner_kind, archive.owner_id, archive.owner_fence, archive.lease_expires_at
       FROM meta_recovery_archives archive
      WHERE archive.generation_id=$1::uuid`,
    [generationId, attachmentId],
  )
}

async function insertAttachment(
  attachmentId: string,
  input: { recordId: string | null; deletedAt: string | null },
): Promise<void> {
  await q(
    `INSERT INTO multitable_attachments (
       id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, size,
       storage_path, storage_provider, metadata, created_at, updated_at, deleted_at
     ) VALUES (
       $1, $2, $3, NULL, $4, 'attachment', 'application/octet-stream', 1,
       $5, 'local', '{}'::jsonb, '2000-01-01T00:00:00.000Z'::timestamptz,
       '2000-01-01T00:00:00.000Z'::timestamptz, $6::timestamptz
     )`,
    [attachmentId, SHEET, input.recordId, `${attachmentId}_file`, `${attachmentId}/blob`, input.deletedAt],
  )
}

async function insertStagingAttachment(
  generationId: string,
  attachmentId: string,
  objectState: 'pending' | 'sealed' = 'pending',
): Promise<string> {
  const stagingObjectId = randomUUID()
  await q(
    `INSERT INTO meta_recovery_archive_staging_objects (
       generation_id, staging_object_id, object_class, attachment_id, object_state, key_id
     ) VALUES ($1::uuid, $2::uuid, 'attachment', $3, 'pending', $4)`,
    [generationId, stagingObjectId, attachmentId, KEY_ID],
  )
  if (objectState === 'sealed') {
    await q(
      `UPDATE meta_recovery_archive_staging_objects
          SET object_state='sealed'
        WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
      [generationId, stagingObjectId],
    )
  }
  return stagingObjectId
}

async function claimCleanup(
  generationId: string,
  overrides: Partial<{
    expectedOwnerId: string
    expectedFence: string
    newOwnerKind: string
    newOwnerId: string
    leaseExpiresAt: string
  }> = {},
): Promise<string> {
  const result = await q(
    `SELECT meta_recovery_archive_claim_abandoned_cleanup(
       $1::uuid, 'archive_builder', $2, $3::bigint,
       $4, $5, $6::timestamptz
     )::text AS fence`,
    [
      generationId,
      overrides.expectedOwnerId ?? OWNER,
      overrides.expectedFence ?? '1',
      overrides.newOwnerKind ?? CLEANER,
      overrides.newOwnerId ?? CLEANER_ID,
      overrides.leaseExpiresAt ?? FUTURE_LEASE,
    ],
  )
  return String(result.rows[0]?.fence)
}

async function finishStagingObject(
  generationId: string,
  stagingObjectId: string,
  ownerFence = '2',
  objectState: 'deleted' | 'absent' = 'absent',
): Promise<void> {
  await q(
    `UPDATE meta_recovery_archive_staging_objects
        SET object_state=$3,
            terminal_receipt_sha256=$4,
            cleanup_owner_kind=$5,
            cleanup_owner_id=$6,
            cleanup_owner_fence=$7::bigint
      WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
    [generationId, stagingObjectId, objectState, RECEIPT_HASH, CLEANER, CLEANER_ID, ownerFence],
  )
}

async function releaseSourcePin(
  client: PoolClient,
  generationId: string,
  attachmentId: string,
  ownerFence = '2',
): Promise<void> {
  await client.query(
    `SELECT meta_recovery_archive_release_abandoned_source_pin(
       $1::uuid, $2, $3, $4, $5::bigint
     )`,
    [generationId, attachmentId, CLEANER, CLEANER_ID, ownerFence],
  )
}

async function truncateCatalog(): Promise<void> {
  if (!schemaIsUp) return
  const reservationTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL AS present`,
  )
  const reservationTarget = reservationTable.rows[0]?.present
    ? 'meta_recovery_archive_snapshot_reservations,'
    : ''
  await q(
    `TRUNCATE TABLE
       ${reservationTarget}
       meta_recovery_archive_staging_objects,
       meta_recovery_archive_attachment_refs,
       meta_recovery_archive_coverage_items,
       meta_recovery_archives`,
  )
}

async function provisionFixtureKeyIfRequired(): Promise<void> {
  const surface = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_keys') IS NOT NULL AS present`,
  )
  keyRegistryIsUp = surface.rows[0]?.present === true
  if (keyRegistryIsUp) {
    await q(`INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)`, [KEY_ID])
  }
}

async function removeFixtureKeyIfRequired(): Promise<void> {
  if (!keyRegistryIsUp) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
    await client.query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
    await client.query('DELETE FROM meta_recovery_archive_keys WHERE key_id=$1', [KEY_ID])
    await client.query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

describeIfRealDbStep('Phase D2b abandoned source-pin cleanup protocol (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installCleanupProtocolIfAbsent()
    await truncateCatalog()
    await provisionFixtureKeyIfRequired()

    await q(
      `INSERT INTO meta_bases (id, name, workspace_id)
       VALUES ($1, $2, $3)`,
      [BASE, `${PREFIX} Base`, WORKSPACE],
    )
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, system_kind)
       VALUES ($1, $2, $3, NULL)`,
      [SHEET, BASE, `${PREFIX} Sheet`],
    )
    await seedSealedOperation()
    await q(
      `INSERT INTO meta_history_trust_checkpoints (
         id, sheet_id, state, trusted_since_seq
       ) VALUES ($1, $2, 'active', $3::bigint)`,
      [CHECKPOINT, SHEET, ANCHOR_SEQ],
    )
  })

  afterEach(async () => {
    await q('DELETE FROM multitable_attachments WHERE sheet_id=$1', [SHEET])
    await truncateCatalog()
  })

  afterAll(async () => {
    try {
      if (!schemaIsUp) await stagingCleanupMigration.up(db)
      await truncateCatalog()
      await q(
        `DELETE FROM meta_history_trust_checkpoints WHERE id=$1`,
        [CHECKPOINT],
      ).catch(() => {})
      await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [
        SHEET,
        ANCHOR_OPERATION,
      ]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id=$1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
      await removeFixtureKeyIfRequired()
    } finally {
      await db.destroy()
    }
  })

  test('the exact real-DB marker and D2b catalog surface are active', async () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()

    const surface = await q(
      `SELECT
         pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects')::text AS staging_table,
         (
           SELECT procedure_row.proname
             FROM pg_catalog.pg_trigger trigger_row
             JOIN pg_catalog.pg_class relation ON relation.oid=trigger_row.tgrelid
             JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
            WHERE relation.relname='meta_recovery_archive_attachment_refs'
              AND trigger_row.tgname='trg_meta_recovery_archive_attachment_ref_guard_row'
              AND NOT trigger_row.tgisinternal
         ) AS attachment_guard,
         (
           SELECT count(*)::int
             FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='meta_recovery_archive_attachment_refs'
              AND column_name IN (
                'cleanup_owner_kind', 'cleanup_owner_id', 'cleanup_owner_fence'
              )
         ) AS cleanup_columns`,
    )
    expect(surface.rows).toEqual([
      {
        staging_table: 'meta_recovery_archive_staging_objects',
        attachment_guard: 'meta_recovery_archive_attachment_ref_cleanup_guard_row',
        cleanup_columns: 3,
      },
    ])
  })

  test('active source pins skip both physical attachment sweepers with zero storage calls', async () => {
    const previousArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    const previousFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    try {
      const generationId = await insertArchive()
      const orphanAttachmentId = `${PREFIX}_orphan_pinned`
      const deletedAttachmentId = `${PREFIX}_deleted_pinned`
      await insertAttachment(orphanAttachmentId, { recordId: null, deletedAt: null })
      await insertAttachment(deletedAttachmentId, { recordId: null, deletedAt: EXPIRED_LEASE })
      await insertSourcePin(generationId, orphanAttachmentId)
      await insertSourcePin(generationId, deletedAttachmentId)

      let orphanStorageCalls = 0
      const orphanResult = await cleanupOrphanMultitableAttachments({
        queryFn: q,
        transactionFn: transaction,
        storage: {
          delete: async () => {
            orphanStorageCalls += 1
          },
        },
      })
      let blobStorageCalls = 0
      const blobResult = await sweepMultitableAttachmentBlobPurge({
        queryFn: q,
        transactionFn: transaction,
        storage: {
          deleteByKey: async () => {
            blobStorageCalls += 1
          },
        },
      })

      expect(orphanResult).toEqual({ inspected: 1, deleted: 0, skipped: 1 })
      expect(blobResult).toEqual({ inspected: 1, purged: 0, skipped: 1 })
      expect(orphanStorageCalls).toBe(0)
      expect(blobStorageCalls).toBe(0)
      const rows = await q(
        `SELECT id, deleted_at IS NULL AS orphan_live, blob_purged_at IS NULL AS blob_unpurged
           FROM multitable_attachments
          WHERE id = ANY($1::text[])
          ORDER BY id`,
        [[deletedAttachmentId, orphanAttachmentId]],
      )
      expect(rows.rows).toEqual([
        { id: deletedAttachmentId, orphan_live: false, blob_unpurged: true },
        { id: orphanAttachmentId, orphan_live: true, blob_unpurged: true },
      ])
    } finally {
      if (previousArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = previousArchiveFlag
      if (previousFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFenceFlag
    }
  })

  test('blob purge rechecks grace under the row lock after a restore and fresh re-delete', async () => {
    const previousArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    const previousFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    const attachmentId = `${PREFIX}_blob_fresh_redelete`
    await insertAttachment(attachmentId, { recordId: null, deletedAt: EXPIRED_LEASE })

    let candidateObserved = false
    const redeleteAfterCandidate = async (text: string, values?: unknown[]) => {
      const response = await q(text, values)
      if (!candidateObserved && text.includes('ORDER BY deleted_at ASC')) {
        candidateObserved = true
        await q(
          'UPDATE multitable_attachments SET deleted_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1',
          [attachmentId],
        )
      }
      return response
    }

    try {
      let storageCalls = 0
      const result = await sweepMultitableAttachmentBlobPurge({
        queryFn: redeleteAfterCandidate,
        transactionFn: transaction,
        graceHours: 24,
        storage: {
          deleteByKey: async () => {
            storageCalls += 1
          },
        },
      })

      expect(candidateObserved).toBe(true)
      expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
      expect(storageCalls).toBe(0)
      const row = await q(
        'SELECT blob_purged_at IS NULL AS unpurged FROM multitable_attachments WHERE id=$1',
        [attachmentId],
      )
      expect(row.rows).toEqual([{ unpurged: true }])
    } finally {
      if (previousArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = previousArchiveFlag
      if (previousFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFenceFlag
    }
  })

  test('orphan sweep tombstones before storage and prevents a waiting claimant from seeing a pin-able row', async () => {
    const previousArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    const previousFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    const attachmentId = `${PREFIX}_orphan_race`
    await insertAttachment(attachmentId, { recordId: null, deletedAt: null })

    let releaseFence: (() => void) | undefined
    const fenceRelease = new Promise<void>((resolve) => {
      releaseFence = resolve
    })
    let signalFence: (() => void) | undefined
    const fenceHeld = new Promise<void>((resolve) => {
      signalFence = resolve
    })
    let firstFence = true
    const gatedTransaction = async <T>(work: (client: { query: TransactionQuery }) => Promise<T>): Promise<T> => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({
          query: async (text, values) => {
            const response = await client.query(text, values)
            if (firstFence && text.startsWith('SELECT pg_advisory_xact_lock')) {
              firstFence = false
              signalFence?.()
              await fenceRelease
            }
            return response
          },
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    try {
      let storageCalls = 0
      const sweep = cleanupOrphanMultitableAttachments({
        queryFn: q,
        transactionFn: gatedTransaction,
        storage: {
          delete: async () => {
            const state = await q('SELECT deleted_at IS NOT NULL AS tombstoned FROM multitable_attachments WHERE id=$1', [attachmentId])
            expect(state.rows).toEqual([{ tombstoned: true }])
            storageCalls += 1
          },
        },
      })
      await fenceHeld

      const claimant = await pool.connect()
      try {
        await claimant.query('BEGIN')
        const lock = claimant.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [canonicalSheetFenceKey(SHEET)],
        )
        releaseFence?.()
        await lock
        const source = await claimant.query(
          'SELECT id FROM multitable_attachments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
          [attachmentId],
        )
        expect(source.rows).toEqual([])
        await claimant.query('ROLLBACK')
      } finally {
        claimant.release()
      }
      await expect(sweep).resolves.toEqual({ inspected: 1, deleted: 1, skipped: 0 })
      expect(storageCalls).toBe(1)
    } finally {
      if (previousArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = previousArchiveFlag
      if (previousFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFenceFlag
    }
  })

  test('only an expired abandoned exact owner/fence can be claimed and the fence advances once', async () => {
    const active = await insertArchive(EXPIRED_LEASE)
    const activeRefusal = await errorOf(claimCleanup(active))
    expect(activeRefusal.message).toBe('recovery_archive_abandoned_cleanup_claim_refused')

    const unexpired = await insertArchive(FUTURE_LEASE)
    await abandon(unexpired)
    const unexpiredRefusal = await errorOf(claimCleanup(unexpired))
    expect(unexpiredRefusal.message).toBe('recovery_archive_abandoned_cleanup_claim_refused')

    const expired = await insertArchive(EXPIRED_LEASE)
    await abandon(expired)
    const staleRefusal = await errorOf(
      claimCleanup(expired, { expectedOwnerId: `${OWNER}_stale` }),
    )
    expect(staleRefusal.message).toBe('recovery_archive_abandoned_cleanup_claim_refused')
    expectValuesFree(staleRefusal, [expired, OWNER, `${OWNER}_stale`])

    const staleFenceRefusal = await errorOf(
      claimCleanup(expired, { expectedFence: '2' }),
    )
    expect(staleFenceRefusal.message).toBe('recovery_archive_abandoned_cleanup_claim_refused')

    const wrongOwnerKindRefusal = await errorOf(
      claimCleanup(expired, { newOwnerKind: 'archive_builder' }),
    )
    expect(wrongOwnerKindRefusal.message).toBe(
      'recovery_archive_abandoned_cleanup_claim_shape_invalid',
    )

    expect(await claimCleanup(expired)).toBe('2')
    const claimed = await q(
      `SELECT owner_kind, owner_id, owner_fence::text, lease_expires_at > clock_timestamp() AS live
         FROM meta_recovery_archives
        WHERE generation_id=$1::uuid`,
      [expired],
    )
    expect(claimed.rows).toEqual([
      { owner_kind: CLEANER, owner_id: CLEANER_ID, owner_fence: '2', live: true },
    ])

    const replayRefusal = await errorOf(claimCleanup(expired))
    expect(replayRefusal.message).toBe('recovery_archive_abandoned_cleanup_claim_refused')
  })

  test('an active live builder cannot be re-owned while entering abandoned cleanup posture', async () => {
    const generationId = await insertArchive(FUTURE_LEASE)
    const attachmentId = `${PREFIX}_attachment_live_builder`
    await insertSourcePin(generationId, attachmentId)
    const stagingObjectId = await insertStagingAttachment(generationId, attachmentId)

    const refusal = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET build_status='abandoned',
                owner_kind='archive_cleanup',
                owner_id=$2,
                owner_fence=77,
                lease_expires_at=$3::timestamptz
          WHERE generation_id=$1::uuid`,
        [generationId, ATTACKER_ID, FUTURE_LEASE],
      ),
    )
    expect(refusal.message).toBe('recovery_archive_active_owner_mutation_invalid')
    expectValuesFree(refusal, [generationId, ATTACKER_ID])

    const posture = await q(
      `SELECT archive.build_status,
              archive.owner_kind,
              archive.owner_id,
              archive.owner_fence::text,
              attachment_ref.reference_state,
              staging_object.object_state
         FROM meta_recovery_archives archive
         JOIN meta_recovery_archive_attachment_refs attachment_ref
           ON attachment_ref.generation_id=archive.generation_id
          AND attachment_ref.attachment_id=$2
          AND attachment_ref.reference_class='source'
         JOIN meta_recovery_archive_staging_objects staging_object
           ON staging_object.generation_id=archive.generation_id
          AND staging_object.staging_object_id=$3::uuid
        WHERE archive.generation_id=$1::uuid`,
      [generationId, attachmentId, stagingObjectId],
    )
    expect(posture.rows).toEqual([
      {
        build_status: 'active',
        owner_kind: 'archive_builder',
        owner_id: OWNER,
        owner_fence: '1',
        reference_state: 'building',
        object_state: 'pending',
      },
    ])
  })

  test('an abandoning builder cannot emit cleanup receipts before an expired-lease cleanup claim', async () => {
    const generationId = await insertArchive(FUTURE_LEASE)
    const attachmentId = `${PREFIX}_attachment_claim_required`
    const stagingObjectId = await insertStagingAttachment(generationId, attachmentId)
    await abandon(generationId)

    const refusal = await errorOf(
      q(
        `UPDATE meta_recovery_archive_staging_objects
            SET object_state='absent',
                terminal_receipt_sha256=$3,
                cleanup_owner_kind='archive_builder',
                cleanup_owner_id=$4,
                cleanup_owner_fence=1
          WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
        [generationId, stagingObjectId, RECEIPT_HASH, OWNER],
      ),
    )
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_owner_invalid')

    const retained = await q(
      `SELECT object_state, cleanup_owner_kind
         FROM meta_recovery_archive_staging_objects
        WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
      [generationId, stagingObjectId],
    )
    expect(retained.rows).toEqual([{ object_state: 'pending', cleanup_owner_kind: null }])
  })

  test('staging terminal receipts require the current cleanup owner and a legal transition', async () => {
    const generationId = await insertArchive(EXPIRED_LEASE)
    const attachmentId = `${PREFIX}_attachment_owner`
    const pendingId = await insertStagingAttachment(generationId, attachmentId)
    const sealedId = await insertStagingAttachment(
      generationId,
      `${attachmentId}_sealed`,
      'sealed',
    )
    await abandon(generationId)
    await claimCleanup(generationId)

    const wrongFence = await errorOf(finishStagingObject(generationId, pendingId, '1'))
    expect(wrongFence.message).toBe('recovery_archive_staging_cleanup_owner_invalid')

    const pendingDelete = await errorOf(
      finishStagingObject(generationId, pendingId, '2', 'deleted'),
    )
    expect(pendingDelete.message).toBe('recovery_archive_staging_cleanup_owner_invalid')

    const missingReceipt = await errorOf(
      q(
        `UPDATE meta_recovery_archive_staging_objects
            SET object_state='absent',
                cleanup_owner_kind=$3,
                cleanup_owner_id=$4,
                cleanup_owner_fence=2
          WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid`,
        [generationId, pendingId, CLEANER, CLEANER_ID],
      ),
    )
    expect(missingReceipt.message).toBe('recovery_archive_staging_shape_invalid')
    expectValuesFree(missingReceipt, [generationId, pendingId, CLEANER, CLEANER_ID])

    await finishStagingObject(generationId, pendingId, '2', 'absent')
    await finishStagingObject(generationId, sealedId, '2', 'deleted')
    const rows = await q(
      `SELECT object_state, terminal_receipt_sha256, cleanup_owner_fence::text
         FROM meta_recovery_archive_staging_objects
        WHERE generation_id=$1::uuid
        ORDER BY object_state`,
      [generationId],
    )
    expect(rows.rows).toEqual([
      {
        object_state: 'absent',
        terminal_receipt_sha256: RECEIPT_HASH,
        cleanup_owner_fence: '2',
      },
      {
        object_state: 'deleted',
        terminal_receipt_sha256: RECEIPT_HASH,
        cleanup_owner_fence: '2',
      },
    ])
  })

  test('cleanup refuses a missing inventory proof and any generation-wide nonterminal object', async () => {
    const missingGenerationId = await insertExpiringArchive()
    const missingAttachmentId = `${PREFIX}_attachment_inventory_missing`
    await insertSourcePin(missingGenerationId, missingAttachmentId)
    await abandon(missingGenerationId)
    await waitForArchiveLeaseExpiry(missingGenerationId)
    await claimCleanup(missingGenerationId)

    const missingInventory = await errorOf(
      q(
        `UPDATE meta_recovery_archive_attachment_refs
            SET cleanup_owner_kind=$3, cleanup_owner_id=$4, cleanup_owner_fence=2
          WHERE generation_id=$1::uuid AND attachment_id=$2`,
        [missingGenerationId, missingAttachmentId, CLEANER, CLEANER_ID],
      ),
    )
    expect(missingInventory.message).toBe('recovery_archive_attachment_cleanup_authorization_invalid')

    const generationId = await insertExpiringArchive()
    const attachmentId = `${PREFIX}_attachment_inventory_nonterminal`
    await insertSourcePin(generationId, attachmentId)
    const attachmentStaging = await insertStagingAttachment(generationId, attachmentId)
    const siblingStaging = await insertStagingAttachment(
      generationId,
      `${attachmentId}_sibling`,
    )
    await abandon(generationId)
    await waitForArchiveLeaseExpiry(generationId)
    await claimCleanup(generationId)
    await finishStagingObject(generationId, attachmentStaging)

    const client = await pool.connect()
    let nonterminalSibling: DatabaseError
    try {
      await client.query('BEGIN')
      nonterminalSibling = await errorOf(releaseSourcePin(client, generationId, attachmentId))
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(nonterminalSibling.message).toBe(
      'recovery_archive_attachment_cleanup_authorization_invalid',
    )
    const retained = await q(
      `SELECT
         EXISTS (
           SELECT 1
             FROM meta_recovery_archive_attachment_refs
            WHERE generation_id=$1::uuid
              AND attachment_id=$2
              AND reference_class='source'
         ) AS source_pin_present,
         (
           SELECT object_state
             FROM meta_recovery_archive_staging_objects
            WHERE generation_id=$1::uuid AND staging_object_id=$3::uuid
         ) AS sibling_state`,
      [generationId, attachmentId, siblingStaging],
    )
    expect(retained.rows).toEqual([{ source_pin_present: true, sibling_state: 'pending' }])
  })

  test('an abandoned generation cannot acquire new staging inventory after cleanup claim', async () => {
    const generationId = await insertArchive(EXPIRED_LEASE)
    await abandon(generationId)
    await claimCleanup(generationId)
    const attachmentId = `${PREFIX}_attachment_late_inventory`
    const refusal = await errorOf(insertStagingAttachment(generationId, attachmentId))
    expect(refusal.message).toBe('recovery_archive_staging_initial_posture_invalid')
    expectValuesFree(refusal, [generationId, attachmentId])
  })

  test('a cleanup authorization cannot survive commit without consuming its exact source pin', async () => {
    const generationId = await insertExpiringArchive()
    const attachmentId = `${PREFIX}_attachment_unconsumed`
    await insertSourcePin(generationId, attachmentId)
    const stagingObjectId = await insertStagingAttachment(generationId, attachmentId)
    await abandon(generationId)
    await waitForArchiveLeaseExpiry(generationId)
    await claimCleanup(generationId)
    await finishStagingObject(generationId, stagingObjectId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE meta_recovery_archive_attachment_refs
            SET cleanup_owner_kind=$3, cleanup_owner_id=$4, cleanup_owner_fence=2
          WHERE generation_id=$1::uuid AND attachment_id=$2`,
        [generationId, attachmentId, CLEANER, CLEANER_ID],
      )
      const refusal = await errorOf(client.query('COMMIT'))
      expect(refusal.message).toBe('recovery_archive_attachment_cleanup_authorization_unconsumed')
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }

    const retained = await q(
      `SELECT cleanup_owner_kind
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [generationId, attachmentId],
    )
    expect(retained.rows).toEqual([{ cleanup_owner_kind: null }])
  })

  test('the current owner can consume one source pin without touching another generation', async () => {
    const generationId = await insertExpiringArchive()
    const otherGenerationId = await insertExpiringArchive()
    const attachmentId = `${PREFIX}_attachment_success`
    await insertSourcePin(generationId, attachmentId)
    await insertSourcePin(otherGenerationId, attachmentId)
    const stagingObjectId = await insertStagingAttachment(generationId, attachmentId)
    const otherStagingObjectId = await insertStagingAttachment(otherGenerationId, attachmentId)
    await abandon(generationId)
    await abandon(otherGenerationId)
    await waitForArchiveLeaseExpiry(generationId)
    await waitForArchiveLeaseExpiry(otherGenerationId)
    await claimCleanup(generationId)
    await claimCleanup(otherGenerationId)
    await finishStagingObject(generationId, stagingObjectId)
    await finishStagingObject(otherGenerationId, otherStagingObjectId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await releaseSourcePin(client, generationId, attachmentId)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const rows = await q(
      `SELECT generation_id::text
         FROM meta_recovery_archive_attachment_refs
        WHERE attachment_id=$1
        ORDER BY generation_id::text`,
      [attachmentId],
    )
    expect(rows.rows).toEqual([{ generation_id: otherGenerationId }])
  })

  test('archive-object presence blocks abandoned source-pin cleanup', async () => {
    const generationId = await insertExpiringArchive()
    const attachmentId = `${PREFIX}_attachment_archive_ref`
    await insertSourcePin(generationId, attachmentId)
    const stagingObjectId = await insertStagingAttachment(generationId, attachmentId)
      await q(
        `ALTER TABLE meta_recovery_archive_attachment_refs
           DISABLE TRIGGER trg_meta_recovery_archive_attachment_finalize_guard_row;
         ALTER TABLE meta_recovery_archive_attachment_refs
           DISABLE TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row;
         ALTER TABLE meta_recovery_archive_attachment_refs
           DISABLE TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row`,
      )
      try {
        await q(
          `INSERT INTO meta_recovery_archive_attachment_refs (
             generation_id, attachment_id, reference_class, reference_state,
             availability, content_sha256, immutable_version, content_size_bytes
           ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
          [generationId, attachmentId, ATTACHMENT_HASH, `${PREFIX}_archive_version`],
        )
      } finally {
        await q(
          `ALTER TABLE meta_recovery_archive_attachment_refs
             ENABLE TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row;
           ALTER TABLE meta_recovery_archive_attachment_refs
             ENABLE TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row;
           ALTER TABLE meta_recovery_archive_attachment_refs
             ENABLE TRIGGER trg_meta_recovery_archive_attachment_finalize_guard_row`,
        )
    }
    await abandon(generationId)
    await waitForArchiveLeaseExpiry(generationId)
    await claimCleanup(generationId)
    await finishStagingObject(generationId, stagingObjectId)

    const refusal = await errorOf(
      q(
        `UPDATE meta_recovery_archive_attachment_refs
            SET cleanup_owner_kind=$3, cleanup_owner_id=$4, cleanup_owner_fence=2
          WHERE generation_id=$1::uuid
            AND attachment_id=$2
            AND reference_class='source'`,
        [generationId, attachmentId, CLEANER, CLEANER_ID],
      ),
    )
    expect(refusal.message).toBe('recovery_archive_attachment_cleanup_authorization_invalid')
  })

  test('down refuses durable cleanup state and an empty down/up replay restores the protocol', async () => {
    const generationId = await insertArchive()
    await insertStagingAttachment(generationId, `${PREFIX}_attachment_down`)
    const refusal = await errorOf(stagingCleanupMigration.down(db))
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_nonempty')

    await truncateCatalog()
    await sourcePinAuthorityMigration.down(db)
    await stagingCleanupMigration.down(db)
    schemaIsUp = false
    const absent = await q(
      `SELECT
         pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NULL AS staging_absent,
         NOT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='meta_recovery_archive_attachment_refs'
              AND column_name='cleanup_owner_kind'
         ) AS cleanup_column_absent`,
    )
    expect(absent.rows).toEqual([{ staging_absent: true, cleanup_column_absent: true }])

    await stagingCleanupMigration.up(db)
    await sourcePinAuthorityMigration.up(db)
    schemaIsUp = true
    const restored = await q(
      `SELECT
         pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL AS staging_present,
         (
           SELECT procedure_row.proname
             FROM pg_catalog.pg_trigger trigger_row
             JOIN pg_catalog.pg_class relation ON relation.oid=trigger_row.tgrelid
             JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
            WHERE relation.relname='meta_recovery_archive_attachment_refs'
              AND trigger_row.tgname='trg_meta_recovery_archive_attachment_ref_guard_row'
              AND NOT trigger_row.tgisinternal
         ) AS attachment_guard`,
    )
    expect(restored.rows).toEqual([
      {
        staging_present: true,
        attachment_guard: 'meta_recovery_archive_attachment_ref_cleanup_guard_row',
      },
    ])
  })

  test('up fails loud when the exact D2a attachment guard source drifts', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await stagingCleanupMigration.down(trx)
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archive_attachment_ref_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $$
          BEGIN
            RETURN NEW;
          END $$
        `.execute(trx)
        await stagingCleanupMigration.up(trx)
        throw new Error('recovery_archive_d2a_guard_fingerprint_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_source_mismatch')

    const binding = await q(
      `SELECT procedure_row.proname
         FROM pg_catalog.pg_trigger trigger_row
         JOIN pg_catalog.pg_class relation ON relation.oid=trigger_row.tgrelid
         JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
        WHERE relation.relname='meta_recovery_archive_attachment_refs'
          AND trigger_row.tgname='trg_meta_recovery_archive_attachment_ref_guard_row'
          AND NOT trigger_row.tgisinternal`,
    )
    expect(binding.rows).toEqual([
      { proname: 'meta_recovery_archive_attachment_ref_cleanup_guard_row' },
    ])
  })

  test('up fails loud when the load-bearing D2a archive guard source drifts', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await stagingCleanupMigration.down(trx)
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archives_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $$
          BEGIN
            RETURN NEW;
          END $$
        `.execute(trx)
        await stagingCleanupMigration.up(trx)
        throw new Error('recovery_archive_archive_guard_fingerprint_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_source_mismatch')
  })

  test('up fails loud when the D2a attachment finalize trigger is missing', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await stagingCleanupMigration.down(trx)
        await sql`
          DROP TRIGGER trg_meta_recovery_archive_attachment_finalize_guard_row
            ON public.meta_recovery_archive_attachment_refs
        `.execute(trx)
        await stagingCleanupMigration.up(trx)
        throw new Error('recovery_archive_attachment_finalize_trigger_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_source_mismatch')
  })

  test('up fails loud when a load-bearing D2a posture constraint drifts', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await stagingCleanupMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archives
            DROP CONSTRAINT chk_meta_recovery_archives_posture
        `.execute(trx)
        await stagingCleanupMigration.up(trx)
        throw new Error('recovery_archive_posture_constraint_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_staging_cleanup_source_mismatch')
  })
})
