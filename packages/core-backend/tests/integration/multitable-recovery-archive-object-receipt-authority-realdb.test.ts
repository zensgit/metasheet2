import { createHash, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as objectReceiptMigration from '../../src/db/migrations/zzzz20260828125000_add_recovery_archive_object_receipt_authority'
import * as claimAnchorMigration from '../../src/db/migrations/zzzz20260828126000_amend_recovery_archive_claim_anchor'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  claimRecoveryArchiveSourcePinIntent,
  verifyRecoveryArchiveSourcePin,
} from '../../src/multitable/recovery-archive-source-pin'
import {
  RecoveryArchiveObjectReceiptError,
  recordRecoveryArchiveObjectUploaded,
  verifyRecoveryArchiveObjectReceipt,
  type RecoveryArchiveObjectReceiptEvidence,
  type RecoveryArchiveObjectReceiptQuery,
} from '../../src/multitable/recovery-archive-object-receipts'
import {
  consumeRecoveryArchiveV2ClaimFixture,
  persistRecoveryArchiveV2ClaimFixture,
} from '../utils/recovery-archive-v2-claim-fixture'

const runRealDb =
  Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2 object-receipt real-DB step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_object_receipt_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2obj_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OWNER_KIND = 'archive_builder'
const OWNER_ID = `${PREFIX}_owner`
const KEY_ID = `${PREFIX}_key`
const ROOT_HASH = '2'.repeat(64)
const COVERAGE_HASH = '3'.repeat(64)
const ATTACHMENT_HASH = '4'.repeat(64)
const ATTACHMENT_SOURCE_VERSION = `${PREFIX}_source_version`
const ATTACHMENT_SIZE = '17'
const LEASE_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const EXPIRES_AT = '2099-12-31T00:00:00.000Z'

type DatabaseError = Error & { code?: string; detail?: string; where?: string }

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = true
let objectAuthorityIsUp = true
let claimAnchorIsUp = true
let initialFingerprint = ''

const q = (text: string, values?: unknown[]) => pool.query(text, values)

async function transaction<T>(
  work: (query: RecoveryArchiveObjectReceiptQuery) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work((text, values) => client.query(text, values))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_database_rejection')
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query('SELECT pg_backend_pid() AS pid')
  return Number(result.rows[0]?.pid)
}

async function waitForBlockedBy(waiterPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT wait_event_type = 'Lock'
              AND $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS blocked
         FROM pg_catalog.pg_stat_activity
        WHERE pid=$1::int`,
      [waiterPid, blockerPid],
    )
    if (result.rows[0]?.blocked === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('recovery_archive_object_lock_order_probe_timeout')
}

function expectValuesFree(error: DatabaseError, values: readonly string[]): void {
  const rendered = [error.message, error.detail, error.where].filter(Boolean).join(' ')
  for (const value of values) expect(rendered).not.toContain(value)
}

async function insertArchiveRow(
  query: RecoveryArchiveObjectReceiptQuery,
  input: {
    generationId: string
    anchorOperationId: string
    anchorSeq: string
    sourceVectorHash: string
    leaseExpiresAt: string
    ownerFence: string
  },
): Promise<void> {
  await query(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, format_version, state, build_status, coverage_status,
       source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, 1, 'building', 'active', 'incomplete',
       $8, $9, $10, $11, $12::bigint,
       $13::timestamptz, $14::timestamptz
     )`,
    [
      input.generationId,
      WORKSPACE,
      BASE,
      SHEET,
      input.anchorOperationId,
      input.anchorSeq,
      CHECKPOINT,
      input.sourceVectorHash,
      KEY_ID,
      OWNER_KIND,
      OWNER_ID,
      input.ownerFence,
      input.leaseExpiresAt,
      EXPIRES_AT,
    ],
  )
}

async function insertArchive(
  overrides: Partial<{ leaseExpiresAt: string; ownerFence: string }> = {},
): Promise<string> {
  const generationId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const query: RecoveryArchiveObjectReceiptQuery = (text, values) => client.query(text, values)
    await persistRecoveryArchiveV2ClaimFixture(
      query,
      {
        generationId,
        sheetId: SHEET,
        ownerKind: OWNER_KIND,
        ownerId: OWNER_ID,
        ownerFence: overrides.ownerFence ?? '1',
      },
      async (identity) =>
        insertArchiveRow(query, {
          generationId,
          anchorOperationId: identity.anchorOperationId,
          anchorSeq: identity.anchorSeq,
          sourceVectorHash: identity.sourceVectorHash,
          leaseExpiresAt: overrides.leaseExpiresAt ?? LEASE_EXPIRES_AT,
          ownerFence: overrides.ownerFence ?? '1',
        }),
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return generationId
}

function evidence(
  generationId: string,
  slot: { sectionName: string } | { attachmentId: string } | { manifest: true },
  suffix = '',
): RecoveryArchiveObjectReceiptEvidence {
  const slotName =
    'sectionName' in slot
      ? slot.sectionName
      : 'attachmentId' in slot
        ? slot.attachmentId
        : 'manifest'
  return {
    generationId,
    objectId: sha(`${generationId}:${slotName}:${suffix}:object`),
    objectClass:
      'sectionName' in slot ? 'section' : 'attachmentId' in slot ? 'attachment' : 'manifest',
    sectionName:
      'sectionName' in slot
        ? (slot.sectionName as RecoveryArchiveObjectReceiptEvidence['sectionName'])
        : null,
    attachmentId: 'attachmentId' in slot ? slot.attachmentId : null,
    keyId: KEY_ID,
    providerVersion: `version-${sha(`${slotName}:${suffix}`).slice(0, 24)}`,
    plaintextSha256:
      'attachmentId' in slot ? ATTACHMENT_HASH : sha(`${slotName}:${suffix}:plaintext`),
    ciphertextSha256: sha(`${slotName}:${suffix}:ciphertext`),
    sizeBytes: '1',
    idempotencyKey: sha(`${generationId}:${slotName}:${suffix}:idempotency`),
    putReceiptSha256: sha(`${generationId}:${slotName}:${suffix}:put`),
    headReceiptSha256: sha(`${generationId}:${slotName}:${suffix}:head`),
    ownerKind: OWNER_KIND,
    ownerId: OWNER_ID,
    ownerFence: '1',
  }
}

async function recordUploaded(
  input: RecoveryArchiveObjectReceiptEvidence,
  query: RecoveryArchiveObjectReceiptQuery = q,
): Promise<void> {
  const result = await recordRecoveryArchiveObjectUploaded(query, input)
  expect(result).toMatchObject({
    generationId: input.generationId,
    objectId: input.objectId,
    state: 'uploaded',
  })
}

async function recordUploadedRoster(
  generationId: string,
  options: {
    sectionCount?: number
    excludeSectionNames?: readonly string[]
    includeManifest?: boolean
  } = {},
): Promise<RecoveryArchiveObjectReceiptEvidence[]> {
  const sectionCount = options.sectionCount ?? RECOVERY_ARCHIVE_V1_SECTION_NAMES.length
  const objects: RecoveryArchiveObjectReceiptEvidence[] = []
  for (const sectionName of RECOVERY_ARCHIVE_V1_SECTION_NAMES.slice(0, sectionCount)) {
    if (options.excludeSectionNames?.includes(sectionName)) continue
    const object = evidence(generationId, { sectionName })
    await recordUploaded(object)
    objects.push(object)
  }
  if (options.includeManifest !== false) {
    const manifest = evidence(generationId, { manifest: true })
    await recordUploaded(manifest)
    objects.push(manifest)
  }
  return objects
}

async function setArchiveVerified(
  query: RecoveryArchiveObjectReceiptQuery,
  generationId: string,
): Promise<void> {
  await query(
    `UPDATE meta_recovery_archives
        SET state='verified',
            build_status='finalized',
            coverage_status='complete',
            root_hash=$2,
            coverage_section_hash=$3,
            coverage_row_count=0,
            manifest_mac=$4::bytea
      WHERE generation_id=$1::uuid`,
    [generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2-object-receipt-mac')],
  )
}

async function finalizeArchiveWithVerifiedObjects(
  generationId: string,
  objects: readonly RecoveryArchiveObjectReceiptEvidence[],
  beforeFinalize?: (query: RecoveryArchiveObjectReceiptQuery) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  const transactionQuery: RecoveryArchiveObjectReceiptQuery = (text, values) =>
    client.query(text, values)
  try {
    await client.query('BEGIN')
    for (const object of objects) {
      const result = await verifyRecoveryArchiveObjectReceipt(transactionQuery, object)
      expect(result).toMatchObject({
        generationId: object.generationId,
        objectId: object.objectId,
        state: 'verified',
      })
    }
    await beforeFinalize?.(transactionQuery)
    const parent = await transactionQuery(
      `SELECT sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence::text
         FROM meta_recovery_archives
        WHERE generation_id=$1::uuid`,
      [generationId],
    )
    if (!parent.rows[0]) throw new Error('recovery_archive_object_parent_missing')
    await consumeRecoveryArchiveV2ClaimFixture(transactionQuery, {
      generationId,
      sheetId: String(parent.rows[0].sheet_id),
      sourceVectorHash: String(parent.rows[0].source_vector_hash),
      ownerKind: String(parent.rows[0].owner_kind),
      ownerId: String(parent.rows[0].owner_id),
      ownerFence: String(parent.rows[0].owner_fence),
    })
    await setArchiveVerified(transactionQuery, generationId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function truncateArchiveState(): Promise<void> {
  if (!schemaIsUp) return
  const reservationTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL AS present`,
  )
  const reservationTarget = reservationTable.rows[0]?.present
    ? 'meta_recovery_archive_snapshot_reservations,'
    : ''
  const markerTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_section_bootstrap_markers') IS NOT NULL AS present`,
  )
  const markerTarget = markerTable.rows[0]?.present
    ? 'meta_recovery_archive_section_bootstrap_markers,'
    : ''
  const legalHoldTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NOT NULL AS present`,
  )
  const legalHoldTarget = legalHoldTable.rows[0]?.present
    ? 'meta_recovery_archive_legal_holds,'
    : ''
  const restoreJobsTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_jobs') IS NOT NULL AS present`,
  )
  const restoreJobTargets = restoreJobsTable.rows[0]?.present
    ? `meta_recovery_archive_restore_plans,
         meta_recovery_archive_job_chunks,
         meta_recovery_archive_sync_receipts,
         meta_recovery_token_burns,
         meta_recovery_archive_jobs,`
    : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `TRUNCATE TABLE
         ${restoreJobTargets}
         meta_recovery_archive_objects,
         ${reservationTarget}
         ${markerTarget}
         meta_recovery_archive_staging_objects,
         meta_recovery_archive_attachment_refs,
         meta_recovery_archive_coverage_items,
         ${legalHoldTarget}
         meta_recovery_archives`,
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function authorityFingerprint(): Promise<string> {
  const result = await q(
    `SELECT md5(string_agg(definition, '|' ORDER BY definition)) AS fingerprint
       FROM (
         SELECT concat_ws('|', 'column', attribute.attname,
                          pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                          attribute.attnotnull::text) AS definition
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.meta_recovery_archive_objects'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
         UNION ALL
         SELECT concat_ws('|', 'constraint', constraint_row.conname,
                          pg_catalog.pg_get_constraintdef(constraint_row.oid, true))
           FROM pg_catalog.pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'public.meta_recovery_archive_objects'::regclass
         UNION ALL
         SELECT concat_ws('|', 'trigger', trigger_row.tgname,
                          pg_catalog.pg_get_triggerdef(trigger_row.oid, true))
           FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgrelid IN (
                  'public.meta_recovery_archive_objects'::regclass,
                  'public.meta_recovery_archives'::regclass
                )
            AND trigger_row.tgname LIKE 'trg_meta_recovery_archive_object_%'
            AND NOT trigger_row.tgisinternal
         UNION ALL
         SELECT concat_ws('|', 'function', procedure_row.proname,
                          pg_catalog.md5(procedure_row.prosrc),
                          coalesce(pg_catalog.array_to_string(procedure_row.proconfig, ','), ''))
           FROM pg_catalog.pg_proc procedure_row
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname IN (
              'meta_recovery_archive_object_guard_row',
              'meta_recovery_archive_object_finalize_guard_row',
              'meta_recovery_archive_object_parent_guard_row'
            )
       ) definitions`,
  )
  return String(result.rows[0]?.fingerprint ?? '')
}

async function restoreFinalSchema(): Promise<void> {
  if (!objectAuthorityIsUp) {
    await objectReceiptMigration.up(db)
    objectAuthorityIsUp = true
  }
  if (!claimAnchorIsUp) {
    await claimAnchorMigration.up(db)
    claimAnchorIsUp = true
  }
  schemaIsUp = true
}

describeIfRealDbStep('Phase D2 generic object PUT+HEAD receipt authority (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    const present = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) await objectReceiptMigration.up(db)
    objectAuthorityIsUp = true
    const claimAnchorPresent = await q(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgname='trg_meta_recovery_archives_claim_anchor_guard_row'
            AND trigger_row.tgrelid='public.meta_recovery_archives'::regclass
            AND NOT trigger_row.tgisinternal
       ) AS present`,
    )
    if (!claimAnchorPresent.rows[0]?.present) await claimAnchorMigration.up(db)
    claimAnchorIsUp = true
    schemaIsUp = true
    initialFingerprint = await authorityFingerprint()

    await q('INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)', [KEY_ID])
    await q(`INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)`, [
      BASE,
      `${PREFIX} Base`,
      WORKSPACE,
    ])
    await q(`INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1, $2, $3, NULL)`, [
      SHEET,
      BASE,
      `${PREFIX} Sheet`,
    ])
    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1, $2, 'active', $3::bigint)`,
      [CHECKPOINT, SHEET, '1'],
    )
  })

  afterEach(async () => {
    await restoreFinalSchema()
    await truncateArchiveState()
  })

  afterAll(async () => {
    try {
      await restoreFinalSchema()
      await truncateArchiveState()
      await transaction(async (query) => {
        await query('SET LOCAL session_replication_role = replica')
        await query('DELETE FROM meta_record_history_snapshot_members WHERE sheet_id=$1', [SHEET])
        await query('DELETE FROM meta_sheet_section_revisions WHERE sheet_id=$1', [SHEET])
        await query('DELETE FROM meta_record_revisions WHERE sheet_id=$1', [SHEET])
        await query('DELETE FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])
      })
      await q(`DELETE FROM meta_history_trust_checkpoints WHERE id=$1`, [CHECKPOINT])
      await q(`DELETE FROM meta_sheets WHERE id=$1`, [SHEET])
      await q(`DELETE FROM meta_bases WHERE id=$1`, [BASE])
      await transaction(async (query) => {
        await query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
        await query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
        await query('DELETE FROM meta_recovery_archive_keys WHERE key_id=$1', [KEY_ID])
        await query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
      })
      const residue = await q(
        `SELECT
           (SELECT count(*)::int FROM meta_recovery_archive_objects) AS objects,
           (SELECT count(*)::int FROM meta_recovery_archives WHERE sheet_id=$1) AS archives,
           (SELECT count(*)::int FROM meta_record_history_operations WHERE sheet_id=$1) AS operations,
           (SELECT count(*)::int FROM meta_sheets WHERE id=$1) AS sheets,
           (SELECT count(*)::int FROM meta_bases WHERE id=$2) AS bases`,
        [SHEET, BASE],
      )
      expect(residue.rows).toEqual([
        { objects: 0, archives: 0, operations: 0, sheets: 0, bases: 0 },
      ])
    } finally {
      await db.destroy()
    }
  })

  test('schema owns exact generic slots, closed shapes, and PUT+HEAD receipt fields', async () => {
    const result = await q(
      `SELECT
         (SELECT count(*)::int FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid='public.meta_recovery_archive_objects'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
         (SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
            FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid='public.meta_recovery_archive_objects'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_names,
         (SELECT count(*)::int FROM pg_catalog.pg_index index_row
           JOIN pg_catalog.pg_class relation ON relation.oid=index_row.indexrelid
          WHERE index_row.indrelid='public.meta_recovery_archive_objects'::regclass
            AND relation.relname LIKE 'idx_meta_recovery_archive_object_%') AS slot_indexes,
         (SELECT count(*)::int FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgname = ANY(ARRAY[
                  'trg_meta_recovery_archive_object_guard_row',
                  'trg_meta_recovery_archive_object_finalize_guard_row',
                  'trg_meta_recovery_archives_object_parent_guard_row'
                ]::text[])
            AND NOT trigger_row.tgisinternal) AS triggers`,
    )
    expect(result.rows).toEqual([
      {
        columns: 19,
        column_names: [
          'generation_id',
          'object_id',
          'object_class',
          'section_name',
          'attachment_id',
          'key_id',
          'provider_version',
          'plaintext_sha256',
          'ciphertext_sha256',
          'size_bytes',
          'idempotency_key',
          'put_receipt_sha256',
          'head_receipt_sha256',
          'owner_kind',
          'owner_id',
          'owner_fence',
          'state',
          'created_at',
          'verified_at',
        ],
        slot_indexes: 3,
        triggers: 3,
      },
    ])
    expect(initialFingerprint).toMatch(/^[0-9a-f]{32}$/)
  })

  test('uploaded receipt replay is exact-idempotent and mismatched replay writes nothing', async () => {
    const generationId = await insertArchive()
    const input = evidence(generationId, { manifest: true })
    const first = await recordRecoveryArchiveObjectUploaded(q, input)
    const replay = await recordRecoveryArchiveObjectUploaded(q, input)
    expect(replay).toEqual(first)

    const mismatched = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, {
        ...input,
        providerVersion: 'different-version',
      }),
    )
    expect(mismatched).toBeInstanceOf(RecoveryArchiveObjectReceiptError)
    expect((mismatched as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
    const stored = await q(
      `SELECT count(*)::int AS count FROM meta_recovery_archive_objects
        WHERE generation_id=$1::uuid`,
      [generationId],
    )
    expect(stored.rows).toEqual([{ count: 1 }])
  })

  test('hostile input, rejection, and result proxies stay values-free and typed', async () => {
    const sentinel = `${PREFIX}_proxy_secret`
    const valid = evidence(randomUUID(), { manifest: true })
    const hostileInput = new Proxy(valid, {
      get() {
        throw new Error(sentinel)
      },
    })
    const invalid = await errorOf(recordRecoveryArchiveObjectUploaded(q, hostileInput))
    expect(invalid).toBeInstanceOf(RecoveryArchiveObjectReceiptError)
    expect((invalid as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT',
    )
    expectValuesFree(invalid, [sentinel])

    const hostileRejection = new Proxy(
      {},
      {
        get() {
          throw new Error(sentinel)
        },
        getPrototypeOf() {
          throw new Error(sentinel)
        },
      },
    )
    const rejected = await errorOf(
      recordRecoveryArchiveObjectUploaded(async () => Promise.reject(hostileRejection), valid),
    )
    expect(rejected).toBeInstanceOf(RecoveryArchiveObjectReceiptError)
    expect((rejected as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
    expectValuesFree(rejected, [sentinel])

    const hostileRow = new Proxy(
      {},
      {
        get() {
          throw new Error(sentinel)
        },
      },
    )
    const malformed = await errorOf(
      recordRecoveryArchiveObjectUploaded(async () => ({ rows: [hostileRow], rowCount: 1 }), valid),
    )
    expect(malformed).toBeInstanceOf(RecoveryArchiveObjectReceiptError)
    expect((malformed as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
    expectValuesFree(malformed, [sentinel])
  })

  test('owner, fence, and live lease are exact and stale writes leave zero rows', async () => {
    const generationId = await insertArchive()
    for (const override of [{ ownerId: `${OWNER_ID}_stale` }, { ownerFence: '2' }]) {
      const stale = await errorOf(
        recordRecoveryArchiveObjectUploaded(q, {
          ...evidence(generationId, { manifest: true }),
          ...override,
        }),
      )
      expect(stale).toBeInstanceOf(RecoveryArchiveObjectReceiptError)
      expect((stale as RecoveryArchiveObjectReceiptError).code).toBe(
        'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
      )
      expectValuesFree(stale, [generationId, OWNER_ID, PREFIX])
    }
    const expiredGeneration = await insertArchive({
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    })
    const expired = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, evidence(expiredGeneration, { manifest: true })),
    )
    expect((expired as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
    const remaining = await q(`SELECT count(*)::int AS count FROM meta_recovery_archive_objects`)
    expect(remaining.rows).toEqual([{ count: 0 }])
  })

  test('section set and one-slot uniqueness are closed, including unknown-section refusal', async () => {
    const generationId = await insertArchive()
    const section = evidence(generationId, { sectionName: 'records' })
    await recordUploaded(section)
    const duplicate = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, {
        ...evidence(generationId, { sectionName: 'records' }, 'duplicate'),
      }),
    )
    expect((duplicate as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )

    const unknown = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, {
        ...evidence(generationId, { sectionName: 'records' }, 'unknown'),
        sectionName: 'unknown' as RecoveryArchiveObjectReceiptEvidence['sectionName'],
      }),
    )
    expect((unknown as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT',
    )

    const secondManifest = evidence(generationId, { manifest: true }, 'second')
    await recordUploaded(evidence(generationId, { manifest: true }))
    const duplicateManifest = await errorOf(recordRecoveryArchiveObjectUploaded(q, secondManifest))
    expect((duplicateManifest as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )

    const duplicateIdempotency = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, {
        ...evidence(generationId, { sectionName: 'links' }),
        idempotencyKey: section.idempotencyKey,
      }),
    )
    expect((duplicateIdempotency as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
  })

  test('provider version, hashes, size, idempotency, and both receipts are immutable and exact at verify', async () => {
    const generationId = await insertArchive()
    const uploaded = evidence(generationId, { sectionName: 'schema' })
    const missingHead = await errorOf(
      q(
        `INSERT INTO meta_recovery_archive_objects (
           generation_id, object_id, object_class, section_name, attachment_id,
           key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
           idempotency_key, put_receipt_sha256, head_receipt_sha256,
           owner_kind, owner_id, owner_fence, state
         ) VALUES (
           $1::uuid, $2, 'section', 'records', NULL,
           $3, $4, $5, $6, 1,
           $7, $8, NULL,
           'archive_builder', $9, 1, 'uploaded'
         )`,
        [
          generationId,
          sha(`${generationId}:missing-head`),
          KEY_ID,
          'version-missing-head',
          'a'.repeat(64),
          'b'.repeat(64),
          'c'.repeat(64),
          'd'.repeat(64),
          OWNER_ID,
        ],
      ),
    )
    expect(missingHead.code).toBe('23514')
    expect(missingHead.message).toBe('recovery_archive_object_shape_invalid')
    expectValuesFree(missingHead, [generationId, KEY_ID, 'version-missing-head', OWNER_ID])

    await recordUploaded(uploaded)
    const detachedVerification = await errorOf(verifyRecoveryArchiveObjectReceipt(q, uploaded))
    expect((detachedVerification as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_NOT_IN_TRANSACTION',
    )
    const stillUploaded = await q(
      `SELECT state FROM meta_recovery_archive_objects
        WHERE generation_id=$1::uuid AND object_id=$2`,
      [generationId, uploaded.objectId],
    )
    expect(stillUploaded.rows).toEqual([{ state: 'uploaded' }])

    const fields: Array<keyof RecoveryArchiveObjectReceiptEvidence> = [
      'providerVersion',
      'plaintextSha256',
      'ciphertextSha256',
      'sizeBytes',
      'idempotencyKey',
      'putReceiptSha256',
      'headReceiptSha256',
    ]
    for (const field of fields) {
      const changed = {
        ...uploaded,
        [field]:
          field === 'sizeBytes'
            ? '2'
            : field === 'providerVersion'
              ? 'other-version'
              : 'f'.repeat(64),
      }
      const refusal = await errorOf(
        transaction((query) => verifyRecoveryArchiveObjectReceipt(query, changed)),
      )
      expect((refusal as RecoveryArchiveObjectReceiptError).code).toBe(
        'RECOVERY_ARCHIVE_OBJECT_RECEIPT_STALE',
      )
    }

    const direct = await errorOf(
      q(
        `UPDATE meta_recovery_archive_objects
            SET state='verified', provider_version='mutated'
          WHERE generation_id=$1::uuid`,
        [generationId],
      ),
    )
    expect(direct.message).toBe('recovery_archive_object_immutable')
    const remainingRoster = await recordUploadedRoster(generationId, {
      excludeSectionNames: ['schema'],
    })
    await finalizeArchiveWithVerifiedObjects(generationId, [uploaded, ...remainingRoster])
    const stored = await q(
      `SELECT provider_version, plaintext_sha256, ciphertext_sha256, size_bytes::text,
              idempotency_key, put_receipt_sha256, head_receipt_sha256, state
         FROM meta_recovery_archive_objects
        WHERE generation_id=$1::uuid AND object_id=$2`,
      [generationId, uploaded.objectId],
    )
    expect(stored.rows).toEqual([
      {
        provider_version: uploaded.providerVersion,
        plaintext_sha256: uploaded.plaintextSha256,
        ciphertext_sha256: uploaded.ciphertextSha256,
        size_bytes: uploaded.sizeBytes,
        idempotency_key: uploaded.idempotencyKey,
        put_receipt_sha256: uploaded.putReceiptSha256,
        head_receipt_sha256: uploaded.headReceiptSha256,
        state: 'verified',
      },
    ])
  })

  test('incomplete or uploaded roster blocks parent verification', async () => {
    const incomplete = await insertArchive()
    const incompleteRoster = await recordUploadedRoster(incomplete, {
      sectionCount: RECOVERY_ARCHIVE_V1_SECTION_NAMES.length - 1,
    })
    const missingSection = await errorOf(
      finalizeArchiveWithVerifiedObjects(incomplete, incompleteRoster),
    )
    expect(missingSection.message).toBe('recovery_archive_object_roster_invalid')

    const uploaded = await insertArchive()
    const uploadedRoster = await recordUploadedRoster(uploaded)
    const verifiedSectionsOnly = uploadedRoster.filter((object) => object.objectClass === 'section')
    const unverifiedManifest = await errorOf(
      finalizeArchiveWithVerifiedObjects(uploaded, verifiedSectionsOnly),
    )
    expect(unverifiedManifest.message).toBe('recovery_archive_object_roster_invalid')

    const postures = await q(
      `SELECT generation_id::text, state, build_status, coverage_status
         FROM meta_recovery_archives ORDER BY generation_id`,
    )
    expect(postures.rows).toEqual(
      expect.arrayContaining([
        {
          generation_id: incomplete,
          state: 'building',
          build_status: 'active',
          coverage_status: 'incomplete',
        },
        {
          generation_id: uploaded,
          state: 'building',
          build_status: 'active',
          coverage_status: 'incomplete',
        },
      ]),
    )
  })

  test('the full exact verified roster permits the existing parent transition', async () => {
    const generationId = await insertArchive()
    const roster = await recordUploadedRoster(generationId)
    await finalizeArchiveWithVerifiedObjects(generationId, roster)
    const parent = await q(
      `SELECT state, build_status, coverage_status FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [generationId],
    )
    expect(parent.rows).toEqual([
      {
        state: 'verified',
        build_status: 'finalized',
        coverage_status: 'complete',
      },
    ])
  })

  test('attachment receipts require an available source pin and survive source-pin release', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_attachment`
    const attachment = evidence(generationId, { attachmentId })
    const noPin = await errorOf(recordRecoveryArchiveObjectUploaded(q, attachment))
    expect((noPin as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )

    const sourceOwner = {
      generationId,
      attachmentId,
      keyId: KEY_ID,
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      ownerFence: '1',
      leaseUntil: LEASE_EXPIRES_AT,
    }
    await transaction((query) => claimRecoveryArchiveSourcePinIntent(query, sourceOwner))
    await transaction((query) =>
      verifyRecoveryArchiveSourcePin(query, {
        ...sourceOwner,
        immutableVersion: ATTACHMENT_SOURCE_VERSION,
        contentSha256: ATTACHMENT_HASH,
        contentSizeBytes: ATTACHMENT_SIZE,
      }),
    )
    await recordUploaded(attachment)
    const roster = await recordUploadedRoster(generationId)

    await finalizeArchiveWithVerifiedObjects(
      generationId,
      [...roster, attachment],
      async (query) => {
        await query(
          `INSERT INTO meta_recovery_archive_attachment_refs (
             generation_id, attachment_id, reference_class, reference_state, availability,
             content_sha256, immutable_version, content_size_bytes
           ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, $5::bigint)`,
          [generationId, attachmentId, ATTACHMENT_HASH, ATTACHMENT_SOURCE_VERSION, ATTACHMENT_SIZE],
        )
        await query(
          `DELETE FROM meta_recovery_archive_attachment_refs
            WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
          [generationId, attachmentId],
        )
      },
    )
    const genericStillPresent = await q(
      `SELECT object_class, attachment_id, state FROM meta_recovery_archive_objects
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [generationId, attachmentId],
    )
    expect(genericStillPresent.rows).toEqual([
      {
        object_class: 'attachment',
        attachment_id: attachmentId,
        state: 'verified',
      },
    ])
  })

  test('attachment receipts reject a source pin whose content hash differs', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_wrong_source_hash`
    const sourceOwner = {
      generationId,
      attachmentId,
      keyId: KEY_ID,
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      ownerFence: '1',
      leaseUntil: LEASE_EXPIRES_AT,
    }
    await transaction((query) => claimRecoveryArchiveSourcePinIntent(query, sourceOwner))
    await transaction((query) =>
      verifyRecoveryArchiveSourcePin(query, {
        ...sourceOwner,
        immutableVersion: ATTACHMENT_SOURCE_VERSION,
        contentSha256: '5'.repeat(64),
        contentSizeBytes: ATTACHMENT_SIZE,
      }),
    )

    const refusal = await errorOf(
      recordRecoveryArchiveObjectUploaded(q, evidence(generationId, { attachmentId })),
    )
    expect((refusal as RecoveryArchiveObjectReceiptError).code).toBe(
      'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    )
  })

  test('an archive-object reference without a matching generic receipt blocks parent verification', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_orphan_archive_ref`
    const sourceOwner = {
      generationId,
      attachmentId,
      keyId: KEY_ID,
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      ownerFence: '1',
      leaseUntil: LEASE_EXPIRES_AT,
    }
    await transaction((query) => claimRecoveryArchiveSourcePinIntent(query, sourceOwner))
    await transaction((query) =>
      verifyRecoveryArchiveSourcePin(query, {
        ...sourceOwner,
        immutableVersion: ATTACHMENT_SOURCE_VERSION,
        contentSha256: ATTACHMENT_HASH,
        contentSizeBytes: ATTACHMENT_SIZE,
      }),
    )
    const sourcePin = await q(
      `SELECT reference_state, availability, content_sha256, immutable_version,
              content_size_bytes::text AS content_size_bytes
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
      [generationId, attachmentId],
    )
    expect(sourcePin.rows).toEqual([
      {
        reference_state: 'building',
        availability: 'available',
        content_sha256: ATTACHMENT_HASH,
        immutable_version: ATTACHMENT_SOURCE_VERSION,
        content_size_bytes: ATTACHMENT_SIZE,
      },
    ])
    const roster = await recordUploadedRoster(generationId)

    const refusal = await errorOf(
      finalizeArchiveWithVerifiedObjects(generationId, roster, async (query) => {
        await query(
          `INSERT INTO meta_recovery_archive_attachment_refs (
             generation_id, attachment_id, reference_class, reference_state, availability,
             content_sha256, immutable_version, content_size_bytes
           ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, $5::bigint)`,
          [generationId, attachmentId, ATTACHMENT_HASH, ATTACHMENT_SOURCE_VERSION, ATTACHMENT_SIZE],
        )
        await query(
          `DELETE FROM meta_recovery_archive_attachment_refs
            WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
          [generationId, attachmentId],
        )
      }),
    )
    expect(refusal.message).toBe('recovery_archive_object_attachment_roster_invalid')
  })

  test('object verification blocks on the active key before it acquires the generation', async () => {
    const generationId = await insertArchive()
    const attachmentId = `${PREFIX}_observable_lock_order`
    const sourceOwner = {
      generationId,
      attachmentId,
      keyId: KEY_ID,
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      ownerFence: '1',
      leaseUntil: LEASE_EXPIRES_AT,
    }
    await transaction((query) => claimRecoveryArchiveSourcePinIntent(query, sourceOwner))
    await transaction((query) =>
      verifyRecoveryArchiveSourcePin(query, {
        ...sourceOwner,
        immutableVersion: ATTACHMENT_SOURCE_VERSION,
        contentSha256: ATTACHMENT_HASH,
        contentSizeBytes: ATTACHMENT_SIZE,
      }),
    )
    const attachment = evidence(generationId, { attachmentId })
    await recordUploaded(attachment)

    const keyHolder = await pool.connect()
    const verifier = await pool.connect()
    const generationProbe = await pool.connect()
    let verifierPromise: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    try {
      await keyHolder.query('BEGIN')
      const keyHolderPid = await backendPid(keyHolder)
      await keyHolder.query(`SELECT 1 FROM meta_recovery_archive_keys WHERE key_id=$1 FOR UPDATE`, [
        KEY_ID,
      ])

      await verifier.query('BEGIN')
      const verifierPid = await backendPid(verifier)
      verifierPromise = verifyRecoveryArchiveObjectReceipt(
        (text, values) => verifier.query(text, values),
        attachment,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForBlockedBy(verifierPid, keyHolderPid)

      await generationProbe.query('BEGIN')
      await generationProbe.query(
        `SELECT 1 FROM meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE NOWAIT`,
        [generationId],
      )
      await generationProbe.query('ROLLBACK')

      await keyHolder.query('ROLLBACK')
      const verifierOutcome = await verifierPromise
      if (!verifierOutcome.ok) throw verifierOutcome.error
      await verifier.query('ROLLBACK')
    } catch (error) {
      await generationProbe.query('ROLLBACK').catch(() => {})
      await keyHolder.query('ROLLBACK').catch(() => {})
      await verifier.query('ROLLBACK').catch(() => {})
      if (verifierPromise) await verifierPromise
      throw error
    } finally {
      generationProbe.release()
      verifier.release()
      keyHolder.release()
    }
  }, 15_000)

  test('object verification holds the active key until completion and source-pin admission resumes', async () => {
    const generationId = await insertArchive()
    const verifiedAttachmentId = `${PREFIX}_verified_lock_order`
    const waitingAttachmentId = `${PREFIX}_waiting_lock_order`
    const sourceOwner = {
      generationId,
      attachmentId: verifiedAttachmentId,
      keyId: KEY_ID,
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      ownerFence: '1',
      leaseUntil: LEASE_EXPIRES_AT,
    }
    await transaction((query) => claimRecoveryArchiveSourcePinIntent(query, sourceOwner))
    await transaction((query) =>
      verifyRecoveryArchiveSourcePin(query, {
        ...sourceOwner,
        immutableVersion: ATTACHMENT_SOURCE_VERSION,
        contentSha256: ATTACHMENT_HASH,
        contentSizeBytes: ATTACHMENT_SIZE,
      }),
    )
    const attachment = evidence(generationId, {
      attachmentId: verifiedAttachmentId,
    })
    await recordUploaded(attachment)

    const verifier = await pool.connect()
    const waiter = await pool.connect()
    let waiterPromise: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    try {
      await verifier.query('BEGIN')
      await verifyRecoveryArchiveObjectReceipt(
        (text, values) => verifier.query(text, values),
        attachment,
      )
      const verifierPid = await backendPid(verifier)

      await waiter.query('BEGIN')
      const waiterPid = await backendPid(waiter)
      waiterPromise = claimRecoveryArchiveSourcePinIntent(
        (text, values) => waiter.query(text, values),
        { ...sourceOwner, attachmentId: waitingAttachmentId },
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForBlockedBy(waiterPid, verifierPid)

      await verifier.query(
        `INSERT INTO meta_recovery_archive_attachment_refs (
           generation_id, attachment_id, reference_class, reference_state, availability,
           content_sha256, immutable_version, content_size_bytes
         ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, $5::bigint)`,
        [
          generationId,
          verifiedAttachmentId,
          ATTACHMENT_HASH,
          ATTACHMENT_SOURCE_VERSION,
          ATTACHMENT_SIZE,
        ],
      )
      await verifier.query('ROLLBACK')
      const waiterOutcome = await waiterPromise
      if (!waiterOutcome.ok) throw waiterOutcome.error
      await waiter.query('COMMIT')
    } catch (error) {
      await verifier.query('ROLLBACK').catch(() => {})
      await waiter.query('ROLLBACK').catch(() => {})
      if (waiterPromise) await waiterPromise
      throw error
    } finally {
      waiter.release()
      verifier.release()
    }
  }, 15_000)

  test('verified generic refs reject every update and delete', async () => {
    const generationId = await insertArchive()
    const roster = await recordUploadedRoster(generationId)
    await finalizeArchiveWithVerifiedObjects(generationId, roster)
    const update = await errorOf(
      q(
        `UPDATE meta_recovery_archive_objects SET head_receipt_sha256=$2 WHERE generation_id=$1::uuid`,
        [generationId, 'f'.repeat(64)],
      ),
    )
    expect(update.message).toBe('recovery_archive_object_immutable')
    const deletion = await errorOf(
      q(`DELETE FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid`, [generationId]),
    )
    expect(deletion.message).toBe('recovery_archive_object_delete_not_authorized')
  })

  test('down races an uncommitted receipt fail closed and preserve the authority', async () => {
    const generationId = await insertArchive()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await recordRecoveryArchiveObjectUploaded(
        (text, values) => client.query(text, values),
        evidence(generationId, { manifest: true }),
      )
      const busy = await errorOf(objectReceiptMigration.down(db))
      expect(busy.code).toBe('55P03')
      expect(busy.message).toBe('recovery_archive_object_receipt_busy')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const preserved = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present,
              count(*)::int AS count
         FROM meta_recovery_archive_objects`,
    )
    expect(preserved.rows).toEqual([{ present: true, count: 1 }])
  })

  test('migration replay is exact, wrong-shape same-name fails loud, and down refuses nonempty authority', async () => {
    const generationId = await insertArchive()
    await recordUploaded(evidence(generationId, { manifest: true }))
    const nonempty = await errorOf(objectReceiptMigration.down(db))
    expect(nonempty.message).toBe('recovery_archive_object_receipt_nonempty')
    expect(await authorityFingerprint()).toBe(initialFingerprint)

    await truncateArchiveState()
    await claimAnchorMigration.down(db)
    claimAnchorIsUp = false
    await objectReceiptMigration.down(db)
    objectAuthorityIsUp = false
    schemaIsUp = false

    await q(
      `ALTER TABLE public.meta_recovery_archive_attachment_refs
         DISABLE TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row`,
    )
    const weakSourceAuthority = await errorOf(objectReceiptMigration.up(db))
    expect(weakSourceAuthority.message).toBe(
      'recovery_archive_object_receipt_source_schema_mismatch',
    )
    await q(
      `ALTER TABLE public.meta_recovery_archive_attachment_refs
         ENABLE TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row`,
    )

    const missingKeyReferenceTrigger = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          DROP TRIGGER trg_meta_recovery_archive_key_reference_guard_row
            ON public.meta_recovery_archives
        `.execute(trx)
        await objectReceiptMigration.up(trx)
        throw new Error('missing_key_reference_trigger_accepted')
      }),
    )
    expect(missingKeyReferenceTrigger.message).toBe(
      'recovery_archive_object_receipt_source_schema_mismatch',
    )

    const missingKeyForeignKey = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_recovery_archives
            DROP CONSTRAINT fk_meta_recovery_archives_key
        `.execute(trx)
        await objectReceiptMigration.up(trx)
        throw new Error('missing_key_foreign_key_accepted')
      }),
    )
    expect(missingKeyForeignKey.message).toBe(
      'recovery_archive_object_receipt_source_schema_mismatch',
    )

    const replacedKeyReferenceGuard = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archive_key_reference_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $guard$
          BEGIN
            RETURN NEW;
          END $guard$
        `.execute(trx)
        await objectReceiptMigration.up(trx)
        throw new Error('replaced_key_reference_guard_accepted')
      }),
    )
    expect(replacedKeyReferenceGuard.message).toBe(
      'recovery_archive_object_receipt_source_schema_mismatch',
    )

    const replacedParentGuard = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archives_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $guard$
          BEGIN
            RETURN NEW;
          END $guard$
        `.execute(trx)
        await objectReceiptMigration.up(trx)
        throw new Error('replaced_parent_guard_accepted')
      }),
    )
    expect(replacedParentGuard.message).toBe(
      'recovery_archive_object_receipt_source_schema_mismatch',
    )

    const wrongShape = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`CREATE TABLE public.meta_recovery_archive_objects (wrong_shape integer)`.execute(
          trx,
        )
        await objectReceiptMigration.up(trx)
      }),
    )
    expect(wrongShape.message).toBe('recovery_archive_object_receipt_object_conflict')
    expectValuesFree(wrongShape, [generationId, OWNER_ID, PREFIX])

    await objectReceiptMigration.up(db)
    objectAuthorityIsUp = true
    await claimAnchorMigration.up(db)
    claimAnchorIsUp = true
    schemaIsUp = true
    expect(await authorityFingerprint()).toBe(initialFingerprint)
  })
})
