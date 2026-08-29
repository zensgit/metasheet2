import { createHash, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as archiveCatalogMigration from '../../src/db/migrations/zzzz20260826120000_create_meta_recovery_archive_catalog'
import * as stagingCleanupMigration from '../../src/db/migrations/zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol'
import * as coverageBindingMigration from '../../src/db/migrations/zzzz20260827120000_add_recovery_archive_coverage_binding'
import * as snapshotReservationMigration from '../../src/db/migrations/zzzz20260828120000_add_recovery_archive_snapshot_reservations'
import * as keyRegistryMigration from '../../src/db/migrations/zzzz20260828121000_add_recovery_archive_key_registry'
import * as legalHoldMigration from '../../src/db/migrations/zzzz20260828130000_add_recovery_archive_legal_hold_authority'
import * as sourcePinAuthorityMigration from '../../src/db/migrations/zzzz20260828124000_add_recovery_archive_source_pin_authority'
import * as objectReceiptAuthorityMigration from '../../src/db/migrations/zzzz20260828125000_add_recovery_archive_object_receipt_authority'
import * as claimAnchorMigration from '../../src/db/migrations/zzzz20260828126000_amend_recovery_archive_claim_anchor'
import * as restoreJobsMigration from '../../src/db/migrations/zzzz20260828131000_create_recovery_archive_restore_jobs'
import {
  RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY,
  RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS,
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
} from '../../src/multitable/recovery-archive-contract'
import {
  listRecoveryArchiveCatalog,
  readRecoveryArchiveCatalogEntry,
} from '../../src/multitable/recovery-archive-catalog'
import { expireRecoveryArchiveAfterLegalHoldCheck } from '../../src/multitable/recovery-archive-legal-holds'
import {
  consumeRecoveryArchiveV2ClaimFixture,
  persistRecoveryArchiveV2ClaimFixture,
} from '../utils/recovery-archive-v2-claim-fixture'

const runRealDb =
  Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2a real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2a_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const OTHER_WORKSPACE = `${PREFIX}_other_workspace`
const BASE = `${PREFIX}_base`
const OTHER_BASE = `${PREFIX}_other_base`
const NULL_WORKSPACE_BASE = `${PREFIX}_null_workspace_base`
const SHEET = `${PREFIX}_sheet`
const OTHER_SHEET = `${PREFIX}_other_sheet`
const NULL_WORKSPACE_SHEET = `${PREFIX}_null_workspace_sheet`
const SYSTEM_SHEET = `${PREFIX}_system_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OTHER_CHECKPOINT = `${PREFIX}_other_checkpoint`
const NULL_WORKSPACE_CHECKPOINT = `${PREFIX}_null_workspace_checkpoint`
const SYSTEM_CHECKPOINT = `${PREFIX}_system_checkpoint`
const OWNER = `${PREFIX}_owner`
const KEY_ID = `${PREFIX}_key`
const ANCHOR_OPERATION = randomUUID()
const OTHER_ANCHOR_OPERATION = randomUUID()
const NULL_WORKSPACE_OPERATION = randomUUID()
const SYSTEM_ANCHOR_OPERATION = randomUUID()
const ANCHOR_SEQ = '9007199254741993'
const CHECKPOINT_TRUSTED_SINCE_SEQ = '1'
const OTHER_ANCHOR_SEQ = '9007199254742993'
const NULL_WORKSPACE_ANCHOR_SEQ = '9007199254743993'
const SYSTEM_ANCHOR_SEQ = '9007199254744993'
const SOURCE_VECTOR_HASH = '1'.repeat(64)
const ROOT_HASH = '2'.repeat(64)
const COVERAGE_HASH = '3'.repeat(64)
const SOURCE_HASH = '4'.repeat(64)
const ATTACHMENT_HASH = '5'.repeat(64)
const LEASE_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const EXPIRES_AT = '2099-12-31T00:00:00.000Z'
const DUE_EXPIRES_AT = '2000-01-01T00:00:00.000Z'

const TABLES = [
  'meta_recovery_archives',
  'meta_recovery_archive_coverage_items',
  'meta_recovery_archive_attachment_refs',
  'meta_recovery_archive_staging_objects',
] as const

const FUNCTIONS = [
  'meta_recovery_archives_guard_row',
  'meta_recovery_archive_coverage_guard_row',
  'meta_recovery_archive_attachment_ref_guard_row',
  'meta_recovery_archive_attachment_finalize_guard_row',
  'meta_recovery_archive_abandoned_cleanup_claim_guard_row',
  'meta_recovery_archive_claim_abandoned_cleanup',
  'meta_recovery_archive_staging_object_guard_row',
  'meta_recovery_archive_staging_object_finalize_guard_row',
  'meta_recovery_archive_attachment_ref_cleanup_guard_row',
  'meta_recovery_archive_attachment_cleanup_finalize_guard_row',
  'meta_recovery_archive_release_abandoned_source_pin',
  'meta_recovery_archive_attachment_authority_guard_row',
] as const

const INDEXES = [
  'idx_meta_recovery_archive_attachment_lookup',
  'idx_meta_recovery_archive_coverage_source',
  'idx_meta_recovery_archives_anchor',
  'idx_meta_recovery_archives_sheet_state',
  'idx_meta_recovery_archive_staging_generation_state',
] as const

const SOURCE_KINDS = RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS

type ArchiveInput = {
  generationId: string
  workspaceId: string | null
  baseId: string
  sheetId: string
  anchorOperationId: string
  anchorSeq: string
  checkpointId: string
  formatVersion: number
  state: string
  buildStatus: string
  coverageStatus: string
  sourceVectorHash: string
  keyId: string
  ownerKind: string
  ownerId: string
  ownerFence: string
  leaseExpiresAt: string
  expiresAt: string
  rootHash: string | null
  coverageSectionHash: string | null
  coverageRowCount: string | null
  manifestMac: Buffer | null
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
let initialFingerprint = ''

const q = (text: string, values?: unknown[]) => pool.query(text, values)

type ArchiveQuery = typeof q

function objectFixtureHash(generationId: string, slot: string, field: string): string {
  return createHash('sha256').update(`${generationId}|${slot}|${field}`).digest('hex')
}

async function seedVerifiedObjectRosterIfPresent(
  query: ArchiveQuery,
  generationId: string,
  attachmentIds: string[] = [],
): Promise<void> {
  const presence = await query(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present`,
  )
  if (presence.rows[0]?.present !== true) return

  const parentResult = await query(
    `SELECT state, build_status, coverage_status, key_id, owner_kind, owner_id,
            owner_fence::text, lease_expires_at > clock_timestamp() AS lease_live
       FROM meta_recovery_archives
      WHERE generation_id=$1::uuid`,
    [generationId],
  )
  const parent = parentResult.rows[0]
  if (
    parent?.state !== 'building' ||
    parent.build_status !== 'active' ||
    parent.coverage_status !== 'incomplete' ||
    parent.lease_live !== true
  ) {
    return
  }

  const slots: Array<{
    objectClass: 'section' | 'attachment' | 'manifest'
    slot: string
    sectionName: string | null
    attachmentId: string | null
    plaintextSha256: string
  }> = RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => ({
    objectClass: 'section',
    slot: `section:${sectionName}`,
    sectionName,
    attachmentId: null,
    plaintextSha256: objectFixtureHash(generationId, `section:${sectionName}`, 'plaintext'),
  }))
  slots.push({
    objectClass: 'manifest',
    slot: 'manifest',
    sectionName: null,
    attachmentId: null,
    plaintextSha256: objectFixtureHash(generationId, 'manifest', 'plaintext'),
  })

  for (const attachmentId of attachmentIds) {
    const source = await query(
      `SELECT content_sha256
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2
          AND reference_class='source' AND reference_state='building'
          AND availability='available'`,
      [generationId, attachmentId],
    )
    if (typeof source.rows[0]?.content_sha256 !== 'string') {
      throw new Error('recovery_archive_catalog_object_fixture_source_missing')
    }
    slots.push({
      objectClass: 'attachment',
      slot: `attachment:${attachmentId}`,
      sectionName: null,
      attachmentId,
      plaintextSha256: source.rows[0].content_sha256,
    })
  }

  for (const slot of slots) {
    const objectId = objectFixtureHash(generationId, slot.slot, 'object')
    await query(
      `INSERT INTO meta_recovery_archive_objects (
         generation_id, object_id, object_class, section_name, attachment_id,
         key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
         idempotency_key, put_receipt_sha256, head_receipt_sha256,
         owner_kind, owner_id, owner_fence
       ) VALUES (
         $1::uuid, $2, $3, $4, $5,
         $6, $7, $8, $9, 1,
         $2, $10, $11,
         $12, $13, $14::bigint
       )
       ON CONFLICT (generation_id, object_id) DO NOTHING`,
      [
        generationId,
        objectId,
        slot.objectClass,
        slot.sectionName,
        slot.attachmentId,
        parent.key_id,
        `${PREFIX}_fixture_v1`,
        slot.plaintextSha256,
        objectFixtureHash(generationId, slot.slot, 'ciphertext'),
        objectFixtureHash(generationId, slot.slot, 'put'),
        objectFixtureHash(generationId, slot.slot, 'head'),
        parent.owner_kind,
        parent.owner_id,
        parent.owner_fence,
      ],
    )
  }

  await query(
    `UPDATE meta_recovery_archive_objects
        SET state='verified', verified_at=clock_timestamp()
      WHERE generation_id=$1::uuid AND state='uploaded'`,
    [generationId],
  )
}

function archiveInput(overrides: Partial<ArchiveInput> = {}): ArchiveInput {
  return {
    generationId: randomUUID(),
    workspaceId: WORKSPACE,
    baseId: BASE,
    sheetId: SHEET,
    anchorOperationId: ANCHOR_OPERATION,
    anchorSeq: ANCHOR_SEQ,
    checkpointId: CHECKPOINT,
    formatVersion: 1,
    state: 'building',
    buildStatus: 'active',
    coverageStatus: 'incomplete',
    sourceVectorHash: SOURCE_VECTOR_HASH,
    keyId: KEY_ID,
    ownerKind: 'archive_builder',
    ownerId: OWNER,
    ownerFence: '1',
    leaseExpiresAt: LEASE_EXPIRES_AT,
    expiresAt: EXPIRES_AT,
    rootHash: null,
    coverageSectionHash: null,
    coverageRowCount: null,
    manifestMac: null,
    ...overrides,
  }
}

async function insertArchiveRow(query: ArchiveQuery, input: ArchiveInput): Promise<void> {
  await query(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, format_version, state, build_status, coverage_status,
       source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at, root_hash, coverage_section_hash,
       coverage_row_count, manifest_mac
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16::bigint,
       $17::timestamptz, $18::timestamptz, $19, $20,
       $21::bigint, $22::bytea
     )`,
    [
      input.generationId,
      input.workspaceId,
      input.baseId,
      input.sheetId,
      input.anchorOperationId,
      input.anchorSeq,
      input.checkpointId,
      input.formatVersion,
      input.state,
      input.buildStatus,
      input.coverageStatus,
      input.sourceVectorHash,
      input.keyId,
      input.ownerKind,
      input.ownerId,
      input.ownerFence,
      input.leaseExpiresAt,
      input.expiresAt,
      input.rootHash,
      input.coverageSectionHash,
      input.coverageRowCount,
      input.manifestMac,
    ],
  )
}

async function insertArchive(overrides: Partial<ArchiveInput> = {}): Promise<ArchiveInput> {
  const input = archiveInput(overrides)
  await insertArchiveRow(q, input)
  return input
}

async function insertFinalizableArchive(
  overrides: Partial<ArchiveInput> = {},
): Promise<ArchiveInput> {
  const generationId = overrides.generationId ?? randomUUID()
  const client = await pool.connect()
  let input: ArchiveInput | undefined
  try {
    await client.query('BEGIN')
    const query: ArchiveQuery = (text, values) => client.query(text, values)
    await persistRecoveryArchiveV2ClaimFixture(
      query,
      {
        generationId,
        sheetId: overrides.sheetId ?? SHEET,
        ownerKind: overrides.ownerKind ?? 'archive_builder',
        ownerId: overrides.ownerId ?? OWNER,
        ownerFence: overrides.ownerFence ?? '1',
      },
      async (identity) => {
        input = archiveInput({
          ...overrides,
          generationId,
          anchorOperationId: identity.anchorOperationId,
          anchorSeq: identity.anchorSeq,
          sourceVectorHash: identity.sourceVectorHash,
        })
        await insertArchiveRow(query, input)
      },
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (!input) throw new Error('recovery_archive_v2_claim_fixture_not_inserted')
  return input
}

async function insertSealedAnchorReuseArchive(
  authority: ArchiveInput,
  overrides: Partial<ArchiveInput> = {},
): Promise<ArchiveInput> {
  return insertArchive({
    workspaceId: authority.workspaceId,
    baseId: authority.baseId,
    sheetId: authority.sheetId,
    anchorOperationId: authority.anchorOperationId,
    anchorSeq: authority.anchorSeq,
    checkpointId: authority.checkpointId,
    formatVersion: authority.formatVersion,
    sourceVectorHash: authority.sourceVectorHash,
    ...overrides,
  })
}

async function finalizeArchive(generationId: string, coverageRowCount = '0'): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const query: ArchiveQuery = (text, values) => client.query(text, values)
    await seedVerifiedObjectRosterIfPresent(query, generationId)
    const parent = await query(
      `SELECT sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence::text
         FROM meta_recovery_archives
        WHERE generation_id=$1::uuid`,
      [generationId],
    )
    const reservationCount = await query(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_snapshot_reservations
        WHERE generation_id=$1::uuid`,
      [generationId],
    )
    if (reservationCount.rows[0]?.count === 10 && parent.rows[0]) {
      await consumeRecoveryArchiveV2ClaimFixture(query, {
        generationId,
        sheetId: String(parent.rows[0].sheet_id),
        sourceVectorHash: String(parent.rows[0].source_vector_hash),
        ownerKind: String(parent.rows[0].owner_kind),
        ownerId: String(parent.rows[0].owner_id),
        ownerFence: String(parent.rows[0].owner_fence),
      })
    }
    await query(
      `UPDATE meta_recovery_archives
          SET state = 'verified',
              build_status = 'finalized',
              coverage_status = 'complete',
              root_hash = $2,
              coverage_section_hash = $3,
              coverage_row_count = $4::bigint,
              manifest_mac = $5::bytea
        WHERE generation_id = $1::uuid`,
      [generationId, ROOT_HASH, COVERAGE_HASH, coverageRowCount, Buffer.from('d2a-manifest-mac')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function withArchiveTransaction<T>(work: (query: ArchiveQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work((text, values) => client.query(text, values))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function expireArchiveWithLegalHoldAuthority(generationId: string) {
  return withArchiveTransaction((query) =>
    expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: WORKSPACE,
      baseId: BASE,
      sheetId: SHEET,
      generationId,
    }),
  )
}

async function insertCoverage(
  generationId: string,
  overrides: Partial<{
    sourceKind: string
    sourceId: string
    sourceSeq: string | null
    sourceSha256: string
    boundSection: string
  }> = {},
): Promise<void> {
  const sourceKind = overrides.sourceKind ?? 'record_revision'
  const sourceId = overrides.sourceId ?? `${PREFIX}_source_${randomUUID()}`
  await q(
    `INSERT INTO meta_recovery_archive_coverage_items (
       generation_id, source_kind, source_id, source_seq, source_sha256, bound_section
     ) VALUES ($1::uuid, $2, $3, $4::bigint, $5, $6)`,
    [
      generationId,
      sourceKind,
      sourceId,
      overrides.sourceSeq === undefined ? ANCHOR_SEQ : overrides.sourceSeq,
      overrides.sourceSha256 ?? SOURCE_HASH,
      overrides.boundSection ?? 'records',
    ],
  )
}

async function insertAttachmentRef(
  generationId: string,
  overrides: Partial<{
    attachmentId: string
    referenceClass: string
    referenceState: string
    availability: string
    contentSha256: string | null
  }> = {},
): Promise<string> {
  const attachmentId = overrides.attachmentId ?? `${PREFIX}_attachment_${randomUUID()}`
  const referenceClass = overrides.referenceClass ?? 'source'
  const referenceState = overrides.referenceState ?? 'building'
  const availability = overrides.availability ?? 'available'
  const contentSha256 =
    overrides.contentSha256 === undefined ? ATTACHMENT_HASH : overrides.contentSha256

  if (referenceClass === 'source') {
    await q(
      `INSERT INTO meta_recovery_archive_attachment_refs (
         generation_id, attachment_id, reference_class, reference_state,
         availability, content_sha256,
         source_owner_kind, source_owner_id, source_owner_fence, source_lease_until
       )
       SELECT archive.generation_id, $2, 'source', $3, 'mutable', NULL,
              archive.owner_kind, archive.owner_id, archive.owner_fence, archive.lease_expires_at
         FROM meta_recovery_archives archive
        WHERE archive.generation_id=$1::uuid`,
      [generationId, attachmentId, referenceState],
    )
    if (availability !== 'mutable') {
      await q(
        `UPDATE meta_recovery_archive_attachment_refs
            SET availability=$3,
                content_sha256=$4,
                immutable_version=CASE WHEN $3='available' THEN $5 ELSE NULL END,
                content_size_bytes=CASE WHEN $3='available' THEN 1 ELSE NULL END
          WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
        [generationId, attachmentId, availability, contentSha256, `${PREFIX}_source_version`],
      )
    }
    return attachmentId
  }

  await q(
    `INSERT INTO meta_recovery_archive_attachment_refs (
       generation_id, attachment_id, reference_class, reference_state,
       availability, content_sha256, immutable_version, content_size_bytes
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 1)`,
    [
      generationId,
      attachmentId,
      referenceClass,
      referenceState,
      availability,
      contentSha256,
      `${PREFIX}_archive_version`,
    ],
  )
  return attachmentId
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

async function truncateCatalog(): Promise<void> {
  if (!schemaIsUp) return
  const reservationTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL AS present`,
  )
  const reservationTarget = reservationTable.rows[0]?.present
    ? 'meta_recovery_archive_snapshot_reservations,'
    : ''
  const objectTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present`,
  )
  const objectTarget = objectTable.rows[0]?.present ? 'meta_recovery_archive_objects,' : ''
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
         meta_recovery_archive_jobs,
         meta_recovery_token_burns,`
    : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `TRUNCATE TABLE
         ${restoreJobTargets}
         ${objectTarget}
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

async function seedSealedOperation(
  sheetId: string,
  operationId: string,
  endpointSeq: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source,
         changed_field_ids, patch, snapshot, seq, operation_id
       ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
                 '{}'::jsonb, $4::bigint, $5::uuid)`,
      [randomUUID(), sheetId, `${sheetId}_anchor_record`, endpointSeq, operationId],
    )
    await client.query(
      `INSERT INTO meta_record_history_operations (
         sheet_id, operation_id, endpoint_seq, event_count
       ) VALUES ($1, $2::uuid, $3::bigint, 1)`,
      [sheetId, operationId, endpointSeq],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function catalogFingerprint(): Promise<string> {
  const result = await q(
    `SELECT kind, object_name, member_name, definition
       FROM (
         SELECT 'column'::text AS kind,
                table_name::text AS object_name,
                column_name::text AS member_name,
                concat_ws('|', data_type, udt_name, is_nullable,
                          coalesce(column_default, ''), coalesce(collation_name, ''))::text AS definition
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY($1::text[])
         UNION ALL
         SELECT 'constraint'::text,
                relation.relname::text,
                constraint_row.conname::text,
                concat_ws('|', constraint_row.contype::text,
                          constraint_row.condeferrable::text,
                          constraint_row.condeferred::text,
                          pg_get_constraintdef(constraint_row.oid, true))::text
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
         UNION ALL
         SELECT 'index'::text,
                tablename::text,
                indexname::text,
                indexdef::text
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = ANY($1::text[])
         UNION ALL
         SELECT 'trigger'::text,
                relation.relname::text,
                trigger_row.tgname::text,
                concat_ws('|', trigger_row.tgenabled::text,
                          pg_get_triggerdef(trigger_row.oid, true))::text
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND NOT trigger_row.tgisinternal
            AND relation.relname = ANY($1::text[])
         UNION ALL
         SELECT 'function'::text,
                procedure_row.proname::text,
                pg_get_function_identity_arguments(procedure_row.oid)::text,
                concat_ws('|', coalesce(array_to_string(procedure_row.proconfig, ','), ''),
                          pg_get_functiondef(procedure_row.oid))::text
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname = ANY($2::text[])
       ) catalog
      ORDER BY kind, object_name, member_name, definition`,
    [TABLES, FUNCTIONS],
  )
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}

async function catalogSurface(): Promise<{
  tables: string[]
  functions: string[]
  indexes: string[]
}> {
  const [tables, functions, indexes] = await Promise.all([
    q(
      `SELECT relation.relname AS name
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = 'r'
          AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname`,
      [TABLES],
    ),
    q(
      `SELECT procedure_row.proname AS name
         FROM pg_proc procedure_row
         JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure_row.proname = ANY($1::text[])
        ORDER BY procedure_row.proname`,
      [FUNCTIONS],
    ),
    q(
      `SELECT indexname AS name
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [INDEXES],
    ),
  ])
  return {
    tables: tables.rows.map((row) => String(row.name)),
    functions: functions.rows.map((row) => String(row.name)),
    indexes: indexes.rows.map((row) => String(row.name)),
  }
}

async function installCatalogIfAbsent(): Promise<void> {
  const result = await q(
    `SELECT name,
            pg_catalog.to_regclass('public.' || name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS owned_tables(name)`,
    [TABLES.slice(0, 3)],
  )
  const presentCount = result.rows.filter((row) => row.present).length
  if (presentCount === 0) await archiveCatalogMigration.up(db)
  else if (presentCount !== 3) throw new Error('recovery_archive_catalog_partial_schema')

  const cleanupPresent = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL AS present`,
  )
  if (!cleanupPresent.rows[0]?.present) await stagingCleanupMigration.up(db)

  const bindingPresent = await q(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'meta_recovery_archive_coverage_items'
          AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_kind_binding'
     ) AS present`,
  )
  if (!bindingPresent.rows[0]?.present) await coverageBindingMigration.up(db)

  const sourcePinAuthorityPresent = await q(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='meta_recovery_archive_attachment_refs'
          AND column_name='source_owner_kind'
     ) AS present`,
  )
  if (!sourcePinAuthorityPresent.rows[0]?.present) await sourcePinAuthorityMigration.up(db)
  schemaIsUp = true
}

interface CatalogStackRestore {
  claimAnchor: boolean
  legalHoldAuthority: boolean
  objectAuthority: boolean
  restoreJobs: boolean
}

async function downCatalogStack(target: Kysely<unknown>): Promise<CatalogStackRestore> {
  const restoreJobs = await sql<{ present: boolean }>`
    SELECT pg_catalog.to_regclass('public.meta_recovery_archive_jobs') IS NOT NULL AS present
  `.execute(target)
  const restoreRestoreJobs = restoreJobs.rows[0]?.present === true
  if (restoreRestoreJobs) await restoreJobsMigration.down(target)

  const legalHoldAuthority = await sql<{ present: boolean }>`
    SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NOT NULL AS present
  `.execute(target)
  const restoreLegalHoldAuthority = legalHoldAuthority.rows[0]?.present === true
  if (restoreLegalHoldAuthority) await legalHoldMigration.down(target)

  const claimAnchor = await sql<{ present: boolean }>`
    SELECT pg_catalog.to_regprocedure(
      'public.meta_recovery_archives_claim_anchor_guard_row()'
    ) IS NOT NULL AS present
  `.execute(target)
  const restoreClaimAnchor = claimAnchor.rows[0]?.present === true
  if (restoreClaimAnchor) await claimAnchorMigration.down(target)

  const objectAuthority = await sql<{ present: boolean }>`
    SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present
  `.execute(target)
  const restoreObjectAuthority = objectAuthority.rows[0]?.present === true
  if (restoreObjectAuthority) await objectReceiptAuthorityMigration.down(target)
  await sourcePinAuthorityMigration.down(target)
  await snapshotReservationMigration.down(target)
  await coverageBindingMigration.down(target)
  await stagingCleanupMigration.down(target)
  await archiveCatalogMigration.down(target)
  return {
    claimAnchor: restoreClaimAnchor,
    legalHoldAuthority: restoreLegalHoldAuthority,
    objectAuthority: restoreObjectAuthority,
    restoreJobs: restoreRestoreJobs,
  }
}

async function upCatalogStack(
  target: Kysely<unknown>,
  restore: CatalogStackRestore = {
    claimAnchor: false,
    legalHoldAuthority: false,
    objectAuthority: false,
    restoreJobs: false,
  },
): Promise<void> {
  await archiveCatalogMigration.up(target)
  await stagingCleanupMigration.up(target)
  await coverageBindingMigration.up(target)
  await snapshotReservationMigration.up(target)
  await sourcePinAuthorityMigration.up(target)
  if (restore.objectAuthority) await objectReceiptAuthorityMigration.up(target)
  if (restore.claimAnchor) await claimAnchorMigration.up(target)
  if (restore.legalHoldAuthority) await legalHoldMigration.up(target)
  if (restore.restoreJobs) await restoreJobsMigration.up(target)
}

async function cleanupSourceFixtures(): Promise<void> {
  const sheetIds = [SHEET, OTHER_SHEET, NULL_WORKSPACE_SHEET, SYSTEM_SHEET]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `DELETE FROM meta_record_history_snapshot_members WHERE sheet_id = ANY($1::text[])`,
      [sheetIds],
    )
    await client.query(
      `DELETE FROM meta_sheet_section_revisions WHERE sheet_id = ANY($1::text[])`,
      [sheetIds],
    )
    await client.query(`DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])`, [
      sheetIds,
    ])
    await client.query(
      `DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])`,
      [sheetIds],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await q(
    `DELETE FROM meta_history_trust_checkpoints
      WHERE id = ANY($1::text[])`,
    [[CHECKPOINT, OTHER_CHECKPOINT, NULL_WORKSPACE_CHECKPOINT, SYSTEM_CHECKPOINT]],
  ).catch(() => {})
  await q(
    `DELETE FROM meta_sheets
      WHERE id = ANY($1::text[])`,
    [[SHEET, OTHER_SHEET, NULL_WORKSPACE_SHEET, SYSTEM_SHEET]],
  ).catch(() => {})
  await q(
    `DELETE FROM meta_bases
      WHERE id = ANY($1::text[])`,
    [[BASE, OTHER_BASE, NULL_WORKSPACE_BASE]],
  ).catch(() => {})
}

async function provisionFixtureKey(): Promise<void> {
  const surface = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_keys') IS NOT NULL AS present`,
  )
  if (!surface.rows[0]?.present) await keyRegistryMigration.up(db)
  keyRegistryIsUp = true
  await q(`INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)`, [KEY_ID])
}

async function removeFixtureKey(): Promise<void> {
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

describeIfRealDbStep('Phase D2a recovery archive catalog schema (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installCatalogIfAbsent()

    const nonempty = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_recovery_archives) AS archives,
         (SELECT count(*)::int FROM meta_recovery_archive_coverage_items) AS coverage,
         (SELECT count(*)::int FROM meta_recovery_archive_attachment_refs) AS attachments`,
    )
    if (Object.values(nonempty.rows[0] as Record<string, number>).some((count) => count !== 0)) {
      throw new Error('recovery_archive_catalog_not_empty_before_test')
    }
    await provisionFixtureKey()

    initialFingerprint = await catalogFingerprint()

    await q(
      `INSERT INTO meta_bases (id, name, workspace_id) VALUES
         ($1, $2, $3),
         ($4, $5, $6),
         ($7, $8, NULL)`,
      [
        BASE,
        `${PREFIX} Base`,
        WORKSPACE,
        OTHER_BASE,
        `${PREFIX} Other Base`,
        OTHER_WORKSPACE,
        NULL_WORKSPACE_BASE,
        `${PREFIX} Null Workspace Base`,
      ],
    )
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES
         ($1, $2, $3, NULL),
         ($4, $5, $6, NULL),
         ($7, $8, $9, NULL),
         ($10, $11, $12, 'people_directory')`,
      [
        SHEET,
        BASE,
        `${PREFIX} Sheet`,
        OTHER_SHEET,
        OTHER_BASE,
        `${PREFIX} Other Sheet`,
        NULL_WORKSPACE_SHEET,
        NULL_WORKSPACE_BASE,
        `${PREFIX} Null Workspace Sheet`,
        SYSTEM_SHEET,
        BASE,
        `${PREFIX} System Sheet`,
      ],
    )

    await seedSealedOperation(SHEET, ANCHOR_OPERATION, ANCHOR_SEQ)
    await seedSealedOperation(OTHER_SHEET, OTHER_ANCHOR_OPERATION, OTHER_ANCHOR_SEQ)
    await seedSealedOperation(
      NULL_WORKSPACE_SHEET,
      NULL_WORKSPACE_OPERATION,
      NULL_WORKSPACE_ANCHOR_SEQ,
    )
    await seedSealedOperation(SYSTEM_SHEET, SYSTEM_ANCHOR_OPERATION, SYSTEM_ANCHOR_SEQ)

    await q(
      `INSERT INTO meta_history_trust_checkpoints (
         id, sheet_id, state, trusted_since_seq
       ) VALUES
         ($1, $2, 'active', $3::bigint),
         ($4, $5, 'active', $6::bigint),
         ($7, $8, 'active', $9::bigint),
         ($10, $11, 'active', $12::bigint)`,
      [
        CHECKPOINT,
        SHEET,
        CHECKPOINT_TRUSTED_SINCE_SEQ,
        OTHER_CHECKPOINT,
        OTHER_SHEET,
        OTHER_ANCHOR_SEQ,
        NULL_WORKSPACE_CHECKPOINT,
        NULL_WORKSPACE_SHEET,
        NULL_WORKSPACE_ANCHOR_SEQ,
        SYSTEM_CHECKPOINT,
        SYSTEM_SHEET,
        SYSTEM_ANCHOR_SEQ,
      ],
    )
  })

  test('the exact real-DB allowlist marker and database are active', () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('catalog read authority lists and reads only an exact available sheet scope', async () => {
    const archive = await insertFinalizableArchive()
    await finalizeArchive(archive.generationId)
    const context = {
      workspaceId: WORKSPACE,
      baseId: BASE,
      sheetId: SHEET,
      recheckAuthority: async () => true,
      env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' },
    }

    const page = await listRecoveryArchiveCatalog(withArchiveTransaction, {
      ...context,
      limit: 10,
    })
    expect(page.entries).toEqual([
      expect.objectContaining({
        generationId: archive.generationId,
        anchorSeq: archive.anchorSeq,
        coverageRowCount: '0',
        superseded: false,
      }),
    ])
    expect(page.nextCursor).toBeNull()
    await expect(readRecoveryArchiveCatalogEntry(withArchiveTransaction, {
      ...context,
      generationId: archive.generationId,
    })).resolves.toEqual(page.entries[0])

    await expect(readRecoveryArchiveCatalogEntry(withArchiveTransaction, {
      ...context,
      workspaceId: OTHER_WORKSPACE,
      baseId: OTHER_BASE,
      generationId: archive.generationId,
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND' })
  })

  afterEach(async () => {
    await truncateCatalog()
  })

  afterAll(async () => {
    try {
      if (!schemaIsUp) {
        await upCatalogStack(db)
        schemaIsUp = true
      }
      await truncateCatalog()
      await cleanupSourceFixtures()
      await removeFixtureKey()
    } finally {
      await db.destroy()
    }
  })

  test('positive building insert binds exact bigint endpoint and current workspace/base/sheet', async () => {
    const archive = await insertArchive()
    const row = await q(
      `SELECT generation_id::text, workspace_id, base_id, sheet_id,
              anchor_operation_id::text, anchor_seq::text, checkpoint_id,
              format_version, state, build_status, coverage_status
         FROM meta_recovery_archives
        WHERE generation_id = $1::uuid`,
      [archive.generationId],
    )
    expect(row.rows).toEqual([
      {
        generation_id: archive.generationId,
        workspace_id: WORKSPACE,
        base_id: BASE,
        sheet_id: SHEET,
        anchor_operation_id: ANCHOR_OPERATION,
        anchor_seq: ANCHOR_SEQ,
        checkpoint_id: CHECKPOINT,
        format_version: 1,
        state: 'building',
        build_status: 'active',
        coverage_status: 'incomplete',
      },
    ])
  })

  test('NULL catalog workspace refuses before the native NOT NULL detail can echo identities', async () => {
    const error = await errorOf(insertArchive({ workspaceId: null }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, [WORKSPACE, BASE, SHEET, OWNER])
  })

  test('a source base whose workspace is NULL refuses even when the catalog supplies one', async () => {
    const error = await errorOf(
      insertArchive({
        workspaceId: WORKSPACE,
        baseId: NULL_WORKSPACE_BASE,
        sheetId: NULL_WORKSPACE_SHEET,
        anchorOperationId: NULL_WORKSPACE_OPERATION,
        anchorSeq: NULL_WORKSPACE_ANCHOR_SEQ,
        checkpointId: NULL_WORKSPACE_CHECKPOINT,
      }),
    )
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, [WORKSPACE, NULL_WORKSPACE_BASE, NULL_WORKSPACE_SHEET, OWNER])
  })

  test('cross-workspace binding refuses', async () => {
    const error = await errorOf(insertArchive({ workspaceId: OTHER_WORKSPACE }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, [OTHER_WORKSPACE, BASE, SHEET, OWNER])
  })

  test('cross-base sheet binding refuses', async () => {
    const error = await errorOf(insertArchive({ workspaceId: OTHER_WORKSPACE, baseId: OTHER_BASE }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, [OTHER_WORKSPACE, OTHER_BASE, SHEET, OWNER])
  })

  test('system_kind sheet binding refuses', async () => {
    const error = await errorOf(
      insertArchive({
        sheetId: SYSTEM_SHEET,
        anchorOperationId: SYSTEM_ANCHOR_OPERATION,
        anchorSeq: SYSTEM_ANCHOR_SEQ,
        checkpointId: SYSTEM_CHECKPOINT,
      }),
    )
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, [WORKSPACE, BASE, SYSTEM_SHEET, OWNER])
  })

  test('wrong anchor sequence refuses', async () => {
    const error = await errorOf(insertArchive({ anchorSeq: '9007199254741994' }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
  })

  test('unknown anchor operation refuses', async () => {
    const error = await errorOf(insertArchive({ anchorOperationId: randomUUID() }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
  })

  test('anchor operation from another sheet refuses', async () => {
    const error = await errorOf(
      insertArchive({
        anchorOperationId: OTHER_ANCHOR_OPERATION,
        anchorSeq: OTHER_ANCHOR_SEQ,
      }),
    )
    expect(error.message).toBe('recovery_archive_binding_invalid')
  })

  test('checkpoint from another sheet refuses', async () => {
    const error = await errorOf(insertArchive({ checkpointId: OTHER_CHECKPOINT }))
    expect(error.message).toBe('recovery_archive_binding_invalid')
  })

  test('building checkpoint is non-selectable and refuses values-free', async () => {
    await q(`UPDATE meta_history_trust_checkpoints SET state='building' WHERE id=$1`, [CHECKPOINT])
    try {
      const error = await errorOf(insertArchive())
      expect(error.message).toBe('recovery_archive_binding_invalid')
      expectValuesFree(error, [WORKSPACE, BASE, SHEET, CHECKPOINT, OWNER])
    } finally {
      await q(`UPDATE meta_history_trust_checkpoints SET state='active' WHERE id=$1`, [CHECKPOINT])
    }

    const restored = await q(
      `SELECT state, pruned_at, trusted_since_seq::text
         FROM meta_history_trust_checkpoints WHERE id=$1`,
      [CHECKPOINT],
    )
    expect(restored.rows).toEqual([
      {
        state: 'active',
        pruned_at: null,
        trusted_since_seq: CHECKPOINT_TRUSTED_SINCE_SEQ,
      },
    ])
  })

  test('pruned checkpoint is non-selectable and refuses values-free', async () => {
    await q(`UPDATE meta_history_trust_checkpoints SET pruned_at=clock_timestamp() WHERE id=$1`, [
      CHECKPOINT,
    ])
    try {
      const error = await errorOf(insertArchive())
      expect(error.message).toBe('recovery_archive_binding_invalid')
      expectValuesFree(error, [WORKSPACE, BASE, SHEET, CHECKPOINT, OWNER])
    } finally {
      await q(`UPDATE meta_history_trust_checkpoints SET pruned_at=NULL WHERE id=$1`, [CHECKPOINT])
    }

    const restored = await q(
      `SELECT state, pruned_at, trusted_since_seq::text
         FROM meta_history_trust_checkpoints WHERE id=$1`,
      [CHECKPOINT],
    )
    expect(restored.rows).toEqual([
      {
        state: 'active',
        pruned_at: null,
        trusted_since_seq: CHECKPOINT_TRUSTED_SINCE_SEQ,
      },
    ])
  })

  test('checkpoint newer than anchor is non-selectable and refuses values-free', async () => {
    await q(
      `UPDATE meta_history_trust_checkpoints
          SET trusted_since_seq=$2::bigint + 1
        WHERE id=$1`,
      [CHECKPOINT, ANCHOR_SEQ],
    )
    try {
      const error = await errorOf(insertArchive())
      expect(error.message).toBe('recovery_archive_binding_invalid')
      expectValuesFree(error, [WORKSPACE, BASE, SHEET, CHECKPOINT, OWNER])
    } finally {
      await q(
        `UPDATE meta_history_trust_checkpoints SET trusted_since_seq=$2::bigint WHERE id=$1`,
        [CHECKPOINT, CHECKPOINT_TRUSTED_SINCE_SEQ],
      )
    }

    const restored = await q(
      `SELECT state, pruned_at, trusted_since_seq::text
         FROM meta_history_trust_checkpoints WHERE id=$1`,
      [CHECKPOINT],
    )
    expect(restored.rows).toEqual([
      {
        state: 'active',
        pruned_at: null,
        trusted_since_seq: CHECKPOINT_TRUSTED_SINCE_SEQ,
      },
    ])
  })

  test('payload, build, and coverage enums are closed independently', async () => {
    const invalidState = await errorOf(insertArchive({ state: 'ready' }))
    expect(invalidState.message).toBe('recovery_archive_initial_posture_invalid')

    const invalidBuild = await errorOf(insertArchive({ buildStatus: 'done' }))
    expect(invalidBuild.message).toBe('recovery_archive_initial_posture_invalid')

    const invalidCoverage = await errorOf(insertArchive({ coverageStatus: 'partial' }))
    expect(invalidCoverage.message).toBe('recovery_archive_initial_posture_invalid')
  })

  test('parent shape rejection is values-free before native CHECK detail can echo identities', async () => {
    const error = await errorOf(insertArchive({ sourceVectorHash: 'A'.repeat(64) }))
    expect(error.message).toBe('recovery_archive_catalog_shape_invalid')
    expectValuesFree(error, [WORKSPACE, BASE, SHEET, OWNER])
  })

  test('insert accepts only the active building incomplete initial posture', async () => {
    const abandoned = await errorOf(insertArchive({ buildStatus: 'abandoned' }))
    expect(abandoned.message).toBe('recovery_archive_initial_posture_invalid')

    const verified = await errorOf(
      insertArchive({
        state: 'verified',
        buildStatus: 'finalized',
        coverageStatus: 'complete',
        rootHash: ROOT_HASH,
        coverageSectionHash: COVERAGE_HASH,
        coverageRowCount: '0',
        manifestMac: Buffer.from('mac'),
      }),
    )
    expect(verified.message).toBe('recovery_archive_initial_posture_invalid')
  })

  test('verified transition requires every finalized field and exact coverage count', async () => {
    const archive = await insertFinalizableArchive()
    const finalizedFields = {
      rootHash: ROOT_HASH,
      coverageHash: COVERAGE_HASH,
      coverageCount: '0',
      manifestMac: Buffer.from('mac'),
    }

    const missingRoot = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                coverage_section_hash=$2, coverage_row_count=$3::bigint, manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [
          archive.generationId,
          finalizedFields.coverageHash,
          finalizedFields.coverageCount,
          finalizedFields.manifestMac,
        ],
      ),
    )
    expect(missingRoot.message).toBe('recovery_archive_finalized_fields_missing')

    const missingCoverageHash = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_row_count=$3::bigint, manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [
          archive.generationId,
          finalizedFields.rootHash,
          finalizedFields.coverageCount,
          finalizedFields.manifestMac,
        ],
      ),
    )
    expect(missingCoverageHash.message).toBe('recovery_archive_finalized_fields_missing')

    const missingCoverageCount = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_section_hash=$3, manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [
          archive.generationId,
          finalizedFields.rootHash,
          finalizedFields.coverageHash,
          finalizedFields.manifestMac,
        ],
      ),
    )
    expect(missingCoverageCount.message).toBe('recovery_archive_finalized_fields_missing')

    const missingMac = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_section_hash=$3, coverage_row_count=$4::bigint
          WHERE generation_id=$1::uuid`,
        [
          archive.generationId,
          finalizedFields.rootHash,
          finalizedFields.coverageHash,
          finalizedFields.coverageCount,
        ],
      ),
    )
    expect(missingMac.message).toBe('recovery_archive_finalized_fields_missing')

    await insertCoverage(archive.generationId, {
      sourceSeq: archive.anchorSeq,
    })
    const wrongCount = await errorOf(finalizeArchive(archive.generationId, '0'))
    expect(wrongCount.message).toBe('recovery_archive_coverage_count_mismatch')

    await finalizeArchive(archive.generationId, '1')
    const row = await q(
      `SELECT state, build_status, coverage_status, coverage_row_count::text
         FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    expect(row.rows).toEqual([
      {
        state: 'verified',
        build_status: 'finalized',
        coverage_status: 'complete',
        coverage_row_count: '1',
      },
    ])
  })

  test('abandoned building cannot verify or return to active', async () => {
    const archive = await insertArchive()
    await q(
      `UPDATE meta_recovery_archives
          SET build_status='abandoned'
        WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )

    const verify = await errorOf(finalizeArchive(archive.generationId))
    expect(verify.message).toBe('recovery_archive_transition_invalid')

    const reactivate = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET build_status='active'
          WHERE generation_id=$1::uuid`,
        [archive.generationId],
      ),
    )
    expect(reactivate.message).toBe('recovery_archive_transition_invalid')
  })

  test('verified catalog posture expires only through D3 authority and never rolls back', async () => {
    const archive = await insertFinalizableArchive({ expiresAt: DUE_EXPIRES_AT })
    await finalizeArchive(archive.generationId)

    const toBuilding = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='building', build_status='active', coverage_status='incomplete'
          WHERE generation_id=$1::uuid`,
        [archive.generationId],
      ),
    )
    expect(toBuilding.message).toBe('recovery_archive_transition_invalid')

    const toAbandoned = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='building', build_status='abandoned', coverage_status='incomplete'
          WHERE generation_id=$1::uuid`,
        [archive.generationId],
      ),
    )
    expect(toAbandoned.message).toBe('recovery_archive_transition_invalid')

    const directExpiry = await errorOf(
      q(`UPDATE meta_recovery_archives SET state='expired' WHERE generation_id=$1::uuid`, [
        archive.generationId,
      ]),
    )
    expect(directExpiry.message).toBe('recovery_archive_expiry_not_authorized')
    expectValuesFree(directExpiry, [archive.generationId, WORKSPACE, BASE, SHEET, KEY_ID])
    const stillVerified = await q(
      `SELECT state, build_status, coverage_status
         FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    expect(stillVerified.rows).toEqual([
      { state: 'verified', build_status: 'finalized', coverage_status: 'complete' },
    ])

    const expired = await expireArchiveWithLegalHoldAuthority(archive.generationId)
    expect(expired).toMatchObject({
      workspaceId: WORKSPACE,
      baseId: BASE,
      sheetId: SHEET,
      generationId: archive.generationId,
      state: 'expired',
    })
    const expiredState = await q(
      `SELECT state, build_status, coverage_status
         FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    expect(expiredState.rows).toEqual([
      { state: 'expired', build_status: 'finalized', coverage_status: 'complete' },
    ])

    const rollback = await errorOf(
      q(`UPDATE meta_recovery_archives SET state='verified' WHERE generation_id=$1::uuid`, [
        archive.generationId,
      ]),
    )
    expect(rollback.message).toBe('recovery_archive_transition_invalid')
    expectValuesFree(rollback, [archive.generationId, WORKSPACE, BASE, SHEET, KEY_ID])

    const invalidRollback = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET state='building', build_status='abandoned', coverage_status='incomplete'
          WHERE generation_id=$1::uuid`,
        [archive.generationId],
      ),
    )
    expect(invalidRollback.message).toBe('recovery_archive_transition_invalid')
    expectValuesFree(invalidRollback, [archive.generationId, WORKSPACE, BASE, SHEET, KEY_ID])
    const stillExpired = await q(
      `SELECT state FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    expect(stillExpired.rows).toEqual([{ state: 'expired' }])
  })

  test('binding identity is immutable and verified payload fields cannot be rewritten', async () => {
    const archive = await insertFinalizableArchive()
    const mutations: Array<[string, string]> = [
      ['workspace_id', OTHER_WORKSPACE],
      ['base_id', OTHER_BASE],
      ['sheet_id', OTHER_SHEET],
      ['anchor_operation_id', OTHER_ANCHOR_OPERATION],
      ['anchor_seq', OTHER_ANCHOR_SEQ],
      ['checkpoint_id', OTHER_CHECKPOINT],
      ['format_version', '2'],
      ['source_vector_hash', '6'.repeat(64)],
      ['key_id', `${KEY_ID}_other`],
    ]

    for (const [column, value] of mutations) {
      const error = await errorOf(
        q(
          `UPDATE meta_recovery_archives
              SET ${column} = $2
            WHERE generation_id = $1::uuid`,
          [archive.generationId, value],
        ),
      )
      expect(error.message).toMatch(/recovery_archive_(identity_immutable|binding_invalid)/)
    }

    const createdAt = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET created_at = created_at + interval '1 second'
          WHERE generation_id = $1::uuid`,
        [archive.generationId],
      ),
    )
    expect(createdAt.message).toBe('recovery_archive_identity_immutable')

    await finalizeArchive(archive.generationId)
    const payloadRewrite = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET root_hash=$2
          WHERE generation_id=$1::uuid`,
        [archive.generationId, '7'.repeat(64)],
      ),
    )
    expect(payloadRewrite.message).toBe('recovery_archive_payload_immutable')
  })

  test('expires_at is immutable canonical manifest identity', async () => {
    const archive = await insertArchive()
    const error = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET expires_at=expires_at + interval '1 second'
          WHERE generation_id=$1::uuid`,
        [archive.generationId],
      ),
    )
    expect(error.message).toBe('recovery_archive_identity_immutable')

    const row = await q(
      `SELECT expires_at::text FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    expect(new Date(String(row.rows[0]?.expires_at)).toISOString()).toBe(EXPIRES_AT)
  })

  test('verified catalog row may set one safe same-anchor superseded_by reference only once', async () => {
    const original = await insertFinalizableArchive()
    await finalizeArchive(original.generationId)
    const replacement = await insertSealedAnchorReuseArchive(original)
    await finalizeArchive(replacement.generationId)

    await q(
      `UPDATE meta_recovery_archives
          SET superseded_by_generation_id=$2::uuid
        WHERE generation_id=$1::uuid`,
      [original.generationId, replacement.generationId],
    )
    const row = await q(
      `SELECT state, root_hash, superseded_by_generation_id::text
         FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
      [original.generationId],
    )
    expect(row.rows).toEqual([
      {
        state: 'verified',
        root_hash: ROOT_HASH,
        superseded_by_generation_id: replacement.generationId,
      },
    ])

    const clear = await errorOf(
      q(
        `UPDATE meta_recovery_archives SET superseded_by_generation_id=NULL
          WHERE generation_id=$1::uuid`,
        [original.generationId],
      ),
    )
    expect(clear.message).toBe('recovery_archive_supersession_immutable')
  })

  test('verified catalog supersession remains updateable after its hot checkpoint is pruned', async () => {
    const original = await insertFinalizableArchive()
    await finalizeArchive(original.generationId)
    const replacement = await insertSealedAnchorReuseArchive(original)
    await finalizeArchive(replacement.generationId)

    await q(`UPDATE meta_history_trust_checkpoints SET pruned_at=clock_timestamp() WHERE id=$1`, [
      CHECKPOINT,
    ])
    try {
      await q(
        `UPDATE meta_recovery_archives
            SET superseded_by_generation_id=$2::uuid
          WHERE generation_id=$1::uuid`,
        [original.generationId, replacement.generationId],
      )
      const row = await q(
        `SELECT state, build_status, coverage_status, superseded_by_generation_id::text
           FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
        [original.generationId],
      )
      expect(row.rows).toEqual([
        {
          state: 'verified',
          build_status: 'finalized',
          coverage_status: 'complete',
          superseded_by_generation_id: replacement.generationId,
        },
      ])
    } finally {
      await q(`UPDATE meta_history_trust_checkpoints SET pruned_at=NULL WHERE id=$1`, [CHECKPOINT])
    }

    const restored = await q(
      `SELECT state, pruned_at, trusted_since_seq::text
         FROM meta_history_trust_checkpoints WHERE id=$1`,
      [CHECKPOINT],
    )
    expect(restored.rows).toEqual([
      {
        state: 'active',
        pruned_at: null,
        trusted_since_seq: CHECKPOINT_TRUSTED_SINCE_SEQ,
      },
    ])
  })

  test('coverage accepts exactly the D1 source kinds and non-derived v1 bound sections', async () => {
    const archive = await insertArchive()
    for (const [index, sourceKind] of SOURCE_KINDS.entries()) {
      const allowed = RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS[sourceKind]
      await insertCoverage(archive.generationId, {
        sourceKind,
        sourceId: `${PREFIX}_kind_${index}`,
        sourceSeq: index % 2 === 0 ? ANCHOR_SEQ : null,
        boundSection: allowed[index % allowed.length],
      })
    }

    const rows = await q(
      `SELECT source_kind, source_seq::text, bound_section
         FROM meta_recovery_archive_coverage_items
        WHERE generation_id=$1::uuid
        ORDER BY source_kind`,
      [archive.generationId],
    )
    expect(rows.rows).toHaveLength(SOURCE_KINDS.length)
    expect(new Set(rows.rows.map((row) => row.source_kind))).toEqual(new Set(SOURCE_KINDS))
    expect(rows.rows.some((row) => row.source_seq === null)).toBe(true)

    const unknownKind = await errorOf(
      insertCoverage(archive.generationId, { sourceKind: 'timestamp_range' }),
    )
    expect(unknownKind.message).toMatch(
      /chk_meta_recovery_archive_coverage_(source_kind|kind_binding)/,
    )

    const selfCoverage = await errorOf(
      insertCoverage(archive.generationId, {
        boundSection: 'coverage_index',
      }),
    )
    expect(selfCoverage.message).toContain('chk_meta_recovery_archive_coverage_bound_section')
  })

  test('coverage exact key, lowerhex hash, source seq, and ordinary immutability are enforced', async () => {
    const archive = await insertArchive()
    const sourceId = `${PREFIX}_exact_source`
    await insertCoverage(archive.generationId, { sourceId })

    const duplicate = await errorOf(insertCoverage(archive.generationId, { sourceId }))
    expect(duplicate.code).toBe('23505')

    const uppercaseHash = await errorOf(
      insertCoverage(archive.generationId, {
        sourceId: `${sourceId}_uppercase`,
        sourceSha256: 'A'.repeat(64),
      }),
    )
    expect(uppercaseHash.message).toContain('chk_meta_recovery_archive_coverage_source_sha256')

    const shortHash = await errorOf(
      insertCoverage(archive.generationId, {
        sourceId: `${sourceId}_short`,
        sourceSha256: 'a'.repeat(63),
      }),
    )
    expect(shortHash.message).toContain('chk_meta_recovery_archive_coverage_source_sha256')

    const invalidSeq = await errorOf(
      insertCoverage(archive.generationId, {
        sourceId: `${sourceId}_seq`,
        sourceSeq: '0',
      }),
    )
    expect(invalidSeq.message).toContain('chk_meta_recovery_archive_coverage_source_seq')

    const update = await errorOf(
      q(
        `UPDATE meta_recovery_archive_coverage_items
            SET source_sha256=$4
          WHERE generation_id=$1::uuid AND source_kind=$2 AND source_id=$3`,
        [archive.generationId, 'record_revision', sourceId, '8'.repeat(64)],
      ),
    )
    expect(update.message).toBe('recovery_archive_coverage_immutable')

    const remove = await errorOf(
      q(
        `DELETE FROM meta_recovery_archive_coverage_items
          WHERE generation_id=$1::uuid AND source_kind=$2 AND source_id=$3`,
        [archive.generationId, 'record_revision', sourceId],
      ),
    )
    expect(remove.message).toBe('recovery_archive_coverage_immutable')
  })

  test('coverage insertion is only legal while parent is active building incomplete', async () => {
    const abandoned = await insertArchive()
    await q(
      `UPDATE meta_recovery_archives SET build_status='abandoned'
        WHERE generation_id=$1::uuid`,
      [abandoned.generationId],
    )
    const abandonedInsert = await errorOf(insertCoverage(abandoned.generationId))
    expect(abandonedInsert.message).toBe('recovery_archive_coverage_parent_posture_invalid')

    const verified = await insertFinalizableArchive()
    await finalizeArchive(verified.generationId)
    const verifiedInsert = await errorOf(insertCoverage(verified.generationId))
    expect(verifiedInsert.message).toBe('recovery_archive_coverage_parent_posture_invalid')
  })

  test('ordinary parent DELETE is refused instead of cascading child immutability', async () => {
    const archive = await insertArchive()
    await insertCoverage(archive.generationId)
    const error = await errorOf(
      q('DELETE FROM meta_recovery_archives WHERE generation_id=$1::uuid', [archive.generationId]),
    )
    expect(error.message).toBe('recovery_archive_delete_not_authorized')
    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_recovery_archives WHERE generation_id=$1::uuid) AS parent,
         (SELECT count(*)::int FROM meta_recovery_archive_coverage_items WHERE generation_id=$1::uuid) AS child`,
      [archive.generationId],
    )
    expect(counts.rows).toEqual([{ parent: 1, child: 1 }])
  })

  test('attachment reference class follows parent posture and key uniqueness', async () => {
    const archive = await insertArchive()
    const attachmentId = await insertAttachmentRef(archive.generationId, {
      availability: 'drifted',
    })

    const stored = await q(
      `SELECT reference_class, reference_state, availability, content_sha256
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2`,
      [archive.generationId, attachmentId],
    )
    expect(stored.rows).toEqual([
      {
        reference_class: 'source',
        reference_state: 'building',
        availability: 'drifted',
        content_sha256: ATTACHMENT_HASH,
      },
    ])

    await q(
      `UPDATE meta_recovery_archive_attachment_refs
          SET availability='available',
              immutable_version=$3,
              content_size_bytes=1
        WHERE generation_id=$1::uuid AND attachment_id=$2
          AND reference_class='source' AND reference_state='building'`,
      [archive.generationId, attachmentId, `${PREFIX}_source_version`],
    )
    const mutableSource = await q(
      `SELECT availability
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
      [archive.generationId, attachmentId],
    )
    expect(mutableSource.rows).toEqual([{ availability: 'available' }])

    const crossStateMutation = await errorOf(
      q(
        `UPDATE meta_recovery_archive_attachment_refs
            SET reference_state='verified'
          WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`,
        [archive.generationId, attachmentId],
      ),
    )
    expect(crossStateMutation.message).toBe('recovery_archive_attachment_ref_immutable')

    const duplicate = await errorOf(insertAttachmentRef(archive.generationId, { attachmentId }))
    expect(duplicate.code).toBe('23505')

    const archiveObjectWithoutMatchingSource = await errorOf(
      insertAttachmentRef(archive.generationId, {
        attachmentId: `${attachmentId}_unbound`,
        referenceClass: 'archive_object',
        referenceState: 'verified',
      }),
    )
    expect(archiveObjectWithoutMatchingSource.message).toBe(
      'recovery_archive_attachment_posture_invalid',
    )

    const releaseBeforeArchiveObject = await errorOf(
      q(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='source' AND reference_state='building'`,
        [archive.generationId, attachmentId],
      ),
    )
    expect(releaseBeforeArchiveObject.message).toBe('recovery_archive_attachment_posture_invalid')

    const finalizeWithSourcePin = await errorOf(finalizeArchive(archive.generationId))
    expect(finalizeWithSourcePin.message).toBe('recovery_archive_attachment_posture_invalid')
  })

  test('attachment finalize hands off source protection atomically before parent verification', async () => {
    const archive = await insertFinalizableArchive({ expiresAt: DUE_EXPIRES_AT })
    const attachmentId = await insertAttachmentRef(archive.generationId)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO meta_recovery_archive_attachment_refs (
           generation_id, attachment_id, reference_class, reference_state,
           availability, content_sha256, immutable_version, content_size_bytes
         ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
        [archive.generationId, attachmentId, ATTACHMENT_HASH, `${PREFIX}_archive_version`],
      )
      await seedVerifiedObjectRosterIfPresent(
        (text, values) => client.query(text, values),
        archive.generationId,
        [attachmentId],
      )
      await consumeRecoveryArchiveV2ClaimFixture((text, values) => client.query(text, values), {
        generationId: archive.generationId,
        sheetId: archive.sheetId,
        sourceVectorHash: archive.sourceVectorHash,
        ownerKind: archive.ownerKind,
        ownerId: archive.ownerId,
        ownerFence: archive.ownerFence,
      })
      await client.query(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='source' AND reference_state='building'`,
        [archive.generationId, attachmentId],
      )
      await client.query(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_section_hash=$3, coverage_row_count=0,
                manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [archive.generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2a-manifest-mac')],
      )

      const beforeCommit = await q(
        `SELECT archive.state,
                count(*) FILTER (WHERE attachment_ref.reference_class='source')::int AS source_refs,
                count(*) FILTER (WHERE attachment_ref.reference_class='archive_object')::int AS archive_refs
           FROM meta_recovery_archives archive
           LEFT JOIN meta_recovery_archive_attachment_refs attachment_ref
             ON attachment_ref.generation_id=archive.generation_id
          WHERE archive.generation_id=$1::uuid
          GROUP BY archive.state`,
        [archive.generationId],
      )
      expect(beforeCommit.rows).toEqual([{ state: 'building', source_refs: 1, archive_refs: 0 }])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const afterCommit = await q(
      `SELECT archive.state,
              count(*) FILTER (WHERE attachment_ref.reference_class='source')::int AS source_refs,
              count(*) FILTER (WHERE attachment_ref.reference_class='archive_object')::int AS archive_refs
         FROM meta_recovery_archives archive
         LEFT JOIN meta_recovery_archive_attachment_refs attachment_ref
           ON attachment_ref.generation_id=archive.generation_id
        WHERE archive.generation_id=$1::uuid
        GROUP BY archive.state`,
      [archive.generationId],
    )
    expect(afterCommit.rows).toEqual([{ state: 'verified', source_refs: 0, archive_refs: 1 }])

    const sourceTooLate = await errorOf(
      insertAttachmentRef(archive.generationId, {
        attachmentId: `${attachmentId}_late`,
      }),
    )
    expect(sourceTooLate.message).toBe('recovery_archive_attachment_posture_invalid')
    const archiveObjectTooLate = await errorOf(
      insertAttachmentRef(archive.generationId, {
        attachmentId: `${attachmentId}_late`,
        referenceClass: 'archive_object',
        referenceState: 'verified',
      }),
    )
    expect(archiveObjectTooLate.message).toBe('recovery_archive_attachment_posture_invalid')

    const expired = await expireArchiveWithLegalHoldAuthority(archive.generationId)
    expect(expired).toMatchObject({ generationId: archive.generationId, state: 'expired' })
    const retained = await q(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid
          AND reference_class='archive_object' AND reference_state='verified'`,
      [archive.generationId],
    )
    expect(retained.rows).toEqual([{ count: 1 }])
  })

  test('archive-ref mint rechecks source availability and exact hash before the deferred finalizer', async () => {
    const invalidSources = [
      {
        availability: 'missing',
        sourceHash: null,
        archiveHash: ATTACHMENT_HASH,
      },
      {
        availability: 'mutable',
        sourceHash: ATTACHMENT_HASH,
        archiveHash: ATTACHMENT_HASH,
      },
      {
        availability: 'drifted',
        sourceHash: ATTACHMENT_HASH,
        archiveHash: ATTACHMENT_HASH,
      },
      {
        availability: 'available',
        sourceHash: ATTACHMENT_HASH,
        archiveHash: '6'.repeat(64),
      },
    ] as const

    for (const invalidSource of invalidSources) {
      const archive = await insertArchive()
      const attachmentId = await insertAttachmentRef(archive.generationId, {
        availability: invalidSource.availability,
        contentSha256: invalidSource.sourceHash,
      })
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const refusal = await errorOf(
          (async () => {
            await client.query(
              `INSERT INTO meta_recovery_archive_attachment_refs (
                 generation_id, attachment_id, reference_class, reference_state,
                 availability, content_sha256, immutable_version, content_size_bytes
               ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
              [
                archive.generationId,
                attachmentId,
                invalidSource.archiveHash,
                `${PREFIX}_archive_version`,
              ],
            )
            throw new Error('recovery_archive_attachment_source_validation_missing')
          })(),
        )
        expect(refusal.message).toBe('recovery_archive_attachment_posture_invalid')
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
  })

  test('verified source refuses availability and hash rewrites after an archive ref is minted', async () => {
    for (const mutation of [
      { column: 'availability', value: 'drifted' },
      { column: 'content_sha256', value: '6'.repeat(64) },
    ] as const) {
      const archive = await insertArchive()
      const attachmentId = await insertAttachmentRef(archive.generationId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO meta_recovery_archive_attachment_refs (
             generation_id, attachment_id, reference_class, reference_state,
             availability, content_sha256, immutable_version, content_size_bytes
           ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
          [archive.generationId, attachmentId, ATTACHMENT_HASH, `${PREFIX}_archive_version`],
        )
        await client.query('SAVEPOINT before_source_mutation')
        const refusal = await errorOf(
          client.query(
            `UPDATE meta_recovery_archive_attachment_refs
                SET ${mutation.column}=$3
              WHERE generation_id=$1::uuid AND attachment_id=$2
                AND reference_class='source' AND reference_state='building'`,
            [archive.generationId, attachmentId, mutation.value],
          ),
        )
        expect(refusal.message).toBe('recovery_archive_source_pin_verified_immutable')
        await client.query('ROLLBACK TO SAVEPOINT before_source_mutation')
        const retained = await client.query(
          `SELECT reference_class, availability, content_sha256
             FROM meta_recovery_archive_attachment_refs
            WHERE generation_id=$1::uuid AND attachment_id=$2
            ORDER BY reference_class`,
          [archive.generationId, attachmentId],
        )
        expect(retained.rows).toEqual([
          {
            reference_class: 'archive_object',
            availability: 'available',
            content_sha256: ATTACHMENT_HASH,
          },
          {
            reference_class: 'source',
            availability: 'available',
            content_sha256: ATTACHMENT_HASH,
          },
        ])
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
  })

  test('archive-object protection cannot commit separately from parent finalization', async () => {
    const archive = await insertArchive()
    const attachmentId = await insertAttachmentRef(archive.generationId)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO meta_recovery_archive_attachment_refs (
           generation_id, attachment_id, reference_class, reference_state,
           availability, content_sha256, immutable_version, content_size_bytes
         ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
        [archive.generationId, attachmentId, ATTACHMENT_HASH, `${PREFIX}_archive_version`],
      )
      const refusal = await errorOf(client.query('COMMIT'))
      expect(refusal.message).toBe('recovery_archive_attachment_finalize_not_atomic')
      await client.query('ROLLBACK').catch(() => {})
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const posture = await q(
      `SELECT archive.state,
              count(*) FILTER (WHERE attachment_ref.reference_class='source')::int AS source_refs,
              count(*) FILTER (WHERE attachment_ref.reference_class='archive_object')::int AS archive_refs
         FROM meta_recovery_archives archive
         LEFT JOIN meta_recovery_archive_attachment_refs attachment_ref
           ON attachment_ref.generation_id=archive.generation_id
        WHERE archive.generation_id=$1::uuid
        GROUP BY archive.state`,
      [archive.generationId],
    )
    expect(posture.rows).toEqual([{ state: 'building', source_refs: 1, archive_refs: 0 }])
  })

  test('abandoned source pins remain fail-closed without owner-fence cleanup authorization', async () => {
    const archive = await insertArchive()
    const attachmentId = await insertAttachmentRef(archive.generationId)
    await q(
      `UPDATE meta_recovery_archives SET build_status='abandoned'
        WHERE generation_id=$1::uuid`,
      [archive.generationId],
    )
    const refusal = await errorOf(
      q(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='source' AND reference_state='building'`,
        [archive.generationId, attachmentId],
      ),
    )
    expect(refusal.message).toBe('recovery_archive_attachment_posture_invalid')
  })

  test('attachment enums, verified shape, immutable archive refs, and no URI column are enforced', async () => {
    const building = await insertArchive()
    const invalidClass = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceClass: 'generic_pin',
      }),
    )
    expect(invalidClass.message).toBe('recovery_archive_attachment_posture_invalid')

    const invalidState = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceState: 'staging',
      }),
    )
    expect(invalidState.message).toBe('recovery_archive_attachment_posture_invalid')

    const oldSourceCompoundClass = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceClass: 'source_building',
      }),
    )
    expect(oldSourceCompoundClass.message).toBe('recovery_archive_attachment_posture_invalid')

    const oldArchiveCompoundClass = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceClass: 'archive_object_verified',
        referenceState: 'verified',
      }),
    )
    expect(oldArchiveCompoundClass.message).toBe('recovery_archive_attachment_posture_invalid')

    const sourceVerifiedCrossPair = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceClass: 'source',
        referenceState: 'verified',
      }),
    )
    expect(sourceVerifiedCrossPair.message).toBe('recovery_archive_attachment_posture_invalid')

    const archiveBuildingCrossPair = await errorOf(
      insertAttachmentRef(building.generationId, {
        referenceClass: 'archive_object',
        referenceState: 'building',
      }),
    )
    expect(archiveBuildingCrossPair.message).toBe('recovery_archive_attachment_posture_invalid')

    const invalidAvailabilityId = `${PREFIX}_invalid_availability`
    const invalidAvailabilityValue = 'hash_mismatch'
    const invalidAvailability = await errorOf(
      insertAttachmentRef(building.generationId, {
        attachmentId: invalidAvailabilityId,
        availability: invalidAvailabilityValue,
      }),
    )
    expect(invalidAvailability.message).toBe('recovery_archive_source_pin_shape_invalid')
    expectValuesFree(invalidAvailability, [
      building.generationId,
      invalidAvailabilityId,
      invalidAvailabilityValue,
      OWNER,
    ])

    for (const availability of RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY) {
      await insertAttachmentRef(building.generationId, {
        attachmentId: `${PREFIX}_availability_${availability}`,
        availability,
      })
    }
    const acceptedAvailability = await q(
      `SELECT availability
         FROM meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND attachment_id LIKE $2
        ORDER BY availability`,
      [building.generationId, `${PREFIX}_availability_%`],
    )
    expect(acceptedAvailability.rows.map((row) => row.availability)).toEqual([
      'available',
      'drifted',
      'missing',
      'mutable',
    ])

    const verified = await insertFinalizableArchive()
    const attachmentId = await insertAttachmentRef(verified.generationId)
    const missingArchiveHash = await errorOf(
      insertAttachmentRef(verified.generationId, {
        attachmentId,
        referenceClass: 'archive_object',
        referenceState: 'verified',
        contentSha256: null,
      }),
    )
    expect(missingArchiveHash.message).toBe('recovery_archive_attachment_posture_invalid')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO meta_recovery_archive_attachment_refs (
           generation_id, attachment_id, reference_class, reference_state,
           availability, content_sha256, immutable_version, content_size_bytes
         ) VALUES ($1::uuid, $2, 'archive_object', 'verified', 'available', $3, $4, 1)`,
        [verified.generationId, attachmentId, ATTACHMENT_HASH, `${PREFIX}_archive_version`],
      )
      await seedVerifiedObjectRosterIfPresent(
        (text, values) => client.query(text, values),
        verified.generationId,
        [attachmentId],
      )
      await consumeRecoveryArchiveV2ClaimFixture((text, values) => client.query(text, values), {
        generationId: verified.generationId,
        sheetId: verified.sheetId,
        sourceVectorHash: verified.sourceVectorHash,
        ownerKind: verified.ownerKind,
        ownerId: verified.ownerId,
        ownerFence: verified.ownerFence,
      })
      await client.query(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='source' AND reference_state='building'`,
        [verified.generationId, attachmentId],
      )
      await client.query(
        `UPDATE meta_recovery_archives
            SET state='verified', build_status='finalized', coverage_status='complete',
                root_hash=$2, coverage_section_hash=$3, coverage_row_count=0,
                manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [verified.generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2a-manifest-mac')],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    const update = await errorOf(
      q(
        `UPDATE meta_recovery_archive_attachment_refs SET availability='missing'
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='archive_object' AND reference_state='verified'`,
        [verified.generationId, attachmentId],
      ),
    )
    expect(update.message).toBe('recovery_archive_attachment_ref_immutable')

    const remove = await errorOf(
      q(
        `DELETE FROM meta_recovery_archive_attachment_refs
          WHERE generation_id=$1::uuid AND attachment_id=$2
            AND reference_class='archive_object' AND reference_state='verified'`,
        [verified.generationId, attachmentId],
      ),
    )
    expect(remove.message).toBe('recovery_archive_attachment_ref_immutable')

    const postFinalizeInsert = await errorOf(
      insertAttachmentRef(verified.generationId, {
        attachmentId: `${attachmentId}_late`,
        referenceClass: 'archive_object',
        referenceState: 'verified',
      }),
    )
    expect(postFinalizeInsert.message).toBe('recovery_archive_attachment_posture_invalid')

    const columns = await q(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='meta_recovery_archive_attachment_refs'
          AND column_name ILIKE '%uri%'`,
    )
    expect(columns.rows).toEqual([])

    const openMetadataColumns = await q(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='meta_recovery_archive_attachment_refs'
          AND column_name='source_metadata'`,
    )
    expect(openMetadataColumns.rows).toEqual([])
  })

  test('owned indexes cover sheet/state, anchor, source, and attachment lookups without CASCADE FKs', async () => {
    const indexes = await q(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])
        ORDER BY indexname`,
      [INDEXES],
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual([...INDEXES].sort())
    expect(
      indexes.rows.find((row) => row.indexname === 'idx_meta_recovery_archives_sheet_state')
        ?.indexdef,
    ).toContain('(sheet_id, state, coverage_status, expires_at)')
    expect(
      indexes.rows.find((row) => row.indexname === 'idx_meta_recovery_archives_anchor')?.indexdef,
    ).toContain('(sheet_id, anchor_operation_id, anchor_seq)')
    expect(
      indexes.rows.find((row) => row.indexname === 'idx_meta_recovery_archive_coverage_source')
        ?.indexdef,
    ).toContain('(source_kind, source_id, generation_id)')
    expect(
      indexes.rows.find((row) => row.indexname === 'idx_meta_recovery_archive_attachment_lookup')
        ?.indexdef,
    ).toContain('(attachment_id, reference_class, reference_state, generation_id)')

    const deleteActions = await q(
      `SELECT constraint_row.conname, constraint_row.confdeltype
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid=constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname=ANY($1::text[])
          AND constraint_row.contype='f'
        ORDER BY constraint_row.conname`,
      [TABLES],
    )
    expect(deleteActions.rows.length).toBeGreaterThan(0)
    expect(new Set(deleteActions.rows.map((row) => row.confdeltype))).toEqual(new Set(['r']))
  })

  test('nonempty down refuses without partial drop; empty down/up replay restores one semantic fingerprint', async () => {
    const archive = await insertArchive()
    await insertCoverage(archive.generationId)
    await insertAttachmentRef(archive.generationId)

    const refusal = await errorOf(db.transaction().execute(async (trx) => downCatalogStack(trx)))
    expect(refusal.message).toBe('recovery_archive_source_pin_authority_nonempty')
    expectValuesFree(refusal, [WORKSPACE, BASE, SHEET, OWNER])
    expect(await catalogSurface()).toEqual({
      tables: [...TABLES].sort(),
      functions: [...FUNCTIONS].sort(),
      indexes: [...INDEXES].sort(),
    })
    expect(await catalogFingerprint()).toBe(initialFingerprint)

    await truncateCatalog()
    const replayRollback = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          DROP TRIGGER trg_meta_recovery_archive_key_reference_guard_row
            ON public.meta_recovery_archives
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archives
            DROP CONSTRAINT fk_meta_recovery_archives_key
        `.execute(trx)
        const restore = await downCatalogStack(trx)
        await upCatalogStack(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archives
            ADD CONSTRAINT fk_meta_recovery_archives_key
            FOREIGN KEY (key_id)
            REFERENCES public.meta_recovery_archive_keys(key_id)
            ON UPDATE RESTRICT
            ON DELETE RESTRICT
            NOT DEFERRABLE
        `.execute(trx)
        await sql`
          CREATE TRIGGER trg_meta_recovery_archive_key_reference_guard_row
          BEFORE INSERT ON public.meta_recovery_archives
          FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_key_reference_guard_row()
        `.execute(trx)
        if (restore.objectAuthority) await objectReceiptAuthorityMigration.up(trx)
        if (restore.claimAnchor) await claimAnchorMigration.up(trx)
        if (restore.legalHoldAuthority) await legalHoldMigration.up(trx)
        throw new Error('recovery_archive_catalog_replay_rollback')
      }),
    )
    expect(replayRollback.message).toBe('recovery_archive_catalog_replay_rollback')
    expect(await catalogFingerprint()).toBe(initialFingerprint)
  })

  test('up fails loud on source-schema drift and rolls the attempted down back atomically', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        const restore = await downCatalogStack(trx)
        await sql`
          ALTER TABLE public.meta_sheets
          RENAME COLUMN system_kind TO system_kind_d2a_drift
        `.execute(trx)
        await upCatalogStack(trx, restore)
        throw new Error('recovery_archive_source_schema_guard_missing')
      }),
    )

    expect(refusal.message).toBe('recovery_archive_source_schema_mismatch')
    expect(await catalogFingerprint()).toBe(initialFingerprint)
  })

  test('up fails loud on an owned-name collision and rolls the attempted down back atomically', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        const restore = await downCatalogStack(trx)
        await sql`CREATE TABLE public.meta_recovery_archives (drifted text)`.execute(trx)
        await upCatalogStack(trx, restore)
        throw new Error('recovery_archive_owned_object_guard_missing')
      }),
    )

    expect(refusal.message).toBe('recovery_archive_catalog_object_conflict')
    expect(await catalogFingerprint()).toBe(initialFingerprint)
  })
})
