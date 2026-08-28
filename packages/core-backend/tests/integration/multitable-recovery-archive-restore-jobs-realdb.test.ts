import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import * as restoreJobsMigration from '../../src/db/migrations/zzzz20260828131000_create_recovery_archive_restore_jobs'
import {
  abandonRecoveryArchiveRestoreJob,
  acceptRecoveryArchiveRestoreJob,
  cancelRecoveryArchiveRestoreJob,
  claimRecoveryArchiveRestoreJob,
  finalizeRecoveryArchiveRestoreJob,
  pauseRecoveryArchiveRestoreJob,
  prepareRecoveryArchiveRestorePlan,
  pruneEligibleRecoveryTokenBurns,
  readRecoveryArchiveRestoreJobStatus,
  RecoveryArchiveRestoreJobError,
  resumeRecoveryArchiveRestoreJob,
  runRecoveryArchiveRestoreChunk,
  sweepExpiredRecoveryArchiveRestorePlans,
  selectRecoveryArchiveRestoreJobCandidate,
  sweepExpiredRecoveryArchiveRestoreJobs,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
} from '../../src/multitable/recovery-archive-restore-jobs'
import {
  compileRecoveryArchiveRestorePlan,
  type RecoveryArchiveRestorePlan,
} from '../../src/multitable/recovery-archive-restore-plan'
import {
  acceptFrozenRecoveryArchiveRestoreJob,
  buildRecoveryArchiveAsyncPlan,
  persistRecoveryArchiveAsyncPlan,
} from '../../src/multitable/recovery-archive-async-plan'
import {
  createLocalRecoveryArchiveObjectStoreProvider,
  createTransactionGuardedRecoveryArchiveObjectStore,
} from '../../src/multitable/recovery-archive-object-store'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  expireRecoveryArchiveAfterLegalHoldCheck,
  placeRecoveryArchiveLegalHold,
  RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
  releaseRecoveryArchiveLegalHold,
} from '../../src/multitable/recovery-archive-legal-holds'
import {
  sealDirectEventOperation,
  sealRestoreAggregateOperation,
} from '../../src/multitable/recovery-archive-seals'
import {
  claimArchiveWriterBlockPrepared,
  prepareArchiveWriterBlockTransaction,
} from '../../src/multitable/recovery-archive-writer-block'
import {
  applyMaterializedExactArchiveRecoverySyncInternal,
  type ExactAnchorApplyInput,
} from '../../src/multitable/exact-anchor-recovery-execute'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorLiveSet,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  mintExactArchiveRecoveryIdentity,
  type ExactArchiveRecoveryIdentityClaims,
} from '../../src/multitable/restore-preview-identity'
import { compileRecoveryArchiveSyncPlan } from '../../src/multitable/recovery-archive-sync-plan'
import {
  consumeRecoveryArchiveV2ClaimFixture,
  persistRecoveryArchiveV2ClaimFixture,
  type RecoveryArchiveV2ClaimFixtureIdentity,
} from '../utils/recovery-archive-v2-claim-fixture'

const runRealDb =
  Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D5 real-DB step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_restore_job_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d5_${RUN}`
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const future = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString()

type QueryResult = Awaited<ReturnType<Pool['query']>>
type Fixture = {
  workspaceId: string
  baseId: string
  sheetId: string
  actorId: string
  checkpointId: string
  keyId: string
  generationId: string
  rootHash: string
  sourceVectorHash: string
  anchorOperationId: string
  anchorSeq: string
}

let pool: Pool
let migrationDb: Kysely<unknown>
let transactionDepth = 0
let previousJwtSecret: string | undefined
let previousArchiveFlag: string | undefined
let previousWriterFenceFlag: string | undefined
let previousStrictFlag: string | undefined

const q: RecoveryArchiveRestoreJobQuery = async (text, values) => {
  const result = await pool.query(text, values)
  return result as QueryResult
}

const transaction: RecoveryArchiveRestoreJobTransaction = async (work) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    transactionDepth += 1
    const result = await work(async (text, values) => {
      const queryResult = await client.query(text, values)
      return queryResult as QueryResult
    })
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    transactionDepth -= 1
    client.release()
  }
}

async function withClientTransaction<T>(
  work: (client: PoolClient, query: RecoveryArchiveRestoreJobQuery) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client, async (text, values) => {
      const queryResult = await client.query(text, values)
      return queryResult as QueryResult
    })
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function databaseError(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected_database_rejection')
}

async function seedVerifiedArchive(
  label: string,
  expiresAt = '2099-12-31T00:00:00.000Z',
): Promise<Fixture> {
  const suffix = `${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const fixture = {
    workspaceId: `${PREFIX}_${suffix}_workspace`,
    baseId: `${PREFIX}_${suffix}_base`,
    sheetId: `${PREFIX}_${suffix}_sheet`,
    actorId: `${PREFIX}_${suffix}_actor`,
    checkpointId: `${PREFIX}_${suffix}_checkpoint`,
    keyId: `${PREFIX}_${suffix}_key`,
    generationId: randomUUID(),
    rootHash: sha(`${PREFIX}|${suffix}|root`),
    sourceVectorHash: '',
    anchorOperationId: '',
    anchorSeq: '',
  }

  await q(
    `INSERT INTO public.meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)`,
    [fixture.baseId, `${PREFIX} base`, fixture.workspaceId],
  )
  await q(
    `INSERT INTO public.meta_sheets (id, base_id, name) VALUES ($1, $2, $3)`,
    [fixture.sheetId, fixture.baseId, `${PREFIX} sheet`],
  )
  await q(
    `INSERT INTO public.meta_history_trust_checkpoints (
       id, sheet_id, state, trusted_since_seq, activated_at
     ) VALUES ($1, $2, 'active', 1, clock_timestamp())`,
    [fixture.checkpointId, fixture.sheetId],
  )
  await q(`INSERT INTO public.meta_recovery_archive_keys (key_id) VALUES ($1)`, [fixture.keyId])

  await withClientTransaction(async (_client, query) => {
    await persistRecoveryArchiveV2ClaimFixture(
      query,
      {
        generationId: fixture.generationId,
        sheetId: fixture.sheetId,
        ownerKind: 'archive_builder',
        ownerId: `${PREFIX}_builder`,
        ownerFence: '1',
      },
      async (identity: RecoveryArchiveV2ClaimFixtureIdentity) => {
        fixture.sourceVectorHash = identity.sourceVectorHash
        fixture.anchorOperationId = identity.anchorOperationId
        fixture.anchorSeq = identity.anchorSeq
        await query(
          `INSERT INTO public.meta_recovery_archives (
             generation_id, workspace_id, base_id, sheet_id,
             anchor_operation_id, anchor_seq, checkpoint_id, format_version,
             state, build_status, coverage_status, source_vector_hash, key_id,
             owner_kind, owner_id, owner_fence, lease_expires_at, expires_at
           ) VALUES (
             $1::uuid, $2, $3, $4,
             $5::uuid, $6::bigint, $7, 1,
             'building', 'active', 'incomplete', $8, $9,
             'archive_builder', $10, 1,
             '2099-01-01T00:00:00.000Z'::timestamptz,
             $11::timestamptz
           )`,
          [
            fixture.generationId,
            fixture.workspaceId,
            fixture.baseId,
            fixture.sheetId,
            identity.anchorOperationId,
            identity.anchorSeq,
            fixture.checkpointId,
            identity.sourceVectorHash,
            fixture.keyId,
            `${PREFIX}_builder`,
            expiresAt,
          ],
        )
      },
    )
  })

  await withClientTransaction(async (_client, query) => {
    const slots = [
      ...RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => ({
        objectClass: 'section',
        sectionName,
        slot: `section:${sectionName}`,
      })),
      { objectClass: 'manifest', sectionName: null, slot: 'manifest' },
    ]
    for (const slot of slots) {
      const objectId = sha(`${fixture.generationId}|${slot.slot}|object`)
      await query(
        `INSERT INTO public.meta_recovery_archive_objects (
           generation_id, object_id, object_class, section_name, attachment_id,
           key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
           idempotency_key, put_receipt_sha256, head_receipt_sha256,
           owner_kind, owner_id, owner_fence
         ) VALUES (
           $1::uuid, $2, $3, $4, NULL,
           $5, $6, $7, $8, 1,
           $2, $9, $10,
           'archive_builder', $11, 1
         )`,
        [
          fixture.generationId,
          objectId,
          slot.objectClass,
          slot.sectionName,
          fixture.keyId,
          `${PREFIX}_provider_v1`,
          sha(`${fixture.generationId}|${slot.slot}|plaintext`),
          sha(`${fixture.generationId}|${slot.slot}|ciphertext`),
          sha(`${fixture.generationId}|${slot.slot}|put`),
          sha(`${fixture.generationId}|${slot.slot}|head`),
          `${PREFIX}_builder`,
        ],
      )
    }
    await query(
      `UPDATE public.meta_recovery_archive_objects
          SET state='verified', verified_at=clock_timestamp()
        WHERE generation_id=$1::uuid AND state='uploaded'`,
      [fixture.generationId],
    )
    await consumeRecoveryArchiveV2ClaimFixture(query, {
      generationId: fixture.generationId,
      sheetId: fixture.sheetId,
      sourceVectorHash: fixture.sourceVectorHash,
      ownerKind: 'archive_builder',
      ownerId: `${PREFIX}_builder`,
      ownerFence: '1',
    })
    await query(
      `UPDATE public.meta_recovery_archives
          SET state='verified', build_status='finalized', coverage_status='complete',
              root_hash=$2, coverage_section_hash=$3, coverage_row_count=0,
              manifest_mac=$4::bytea
        WHERE generation_id=$1::uuid`,
      [
        fixture.generationId,
        fixture.rootHash,
        sha(`${fixture.generationId}|coverage`),
        Buffer.from(`${PREFIX}|manifest`),
      ],
    )
  })

  return fixture
}

function compilePlan(
  fixture: Fixture,
  objectExpiresAt = '2099-12-31T00:00:00.000Z',
): RecoveryArchiveRestorePlan {
  return compileRecoveryArchiveRestorePlan({
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
    recoveryMode: 'revert',
    scopeKind: 'selected_records',
    scopeHash: sha(`${fixture.sheetId}|scope`),
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    sourceVectorHash: fixture.sourceVectorHash,
    keyId: fixture.keyId,
    planObjectId: sha(`${fixture.sheetId}|plan_object_id`),
    planObjectVersion: `${PREFIX}_plan_version`,
    planObjectSha256: sha(`${fixture.sheetId}|plan_object`),
    planObjectSize: '2048',
    planObjectExpiresAt: objectExpiresAt,
    chunks: [
      {
        chunkIndex: 0,
        chunkHash: sha(`${fixture.sheetId}|chunk|0`),
        chunkObjectId: `${PREFIX}_chunk_0`,
        chunkObjectVersion: `${PREFIX}_chunk_version_0`,
        chunkObjectSha256: sha(`${fixture.sheetId}|chunk_object|0`),
        chunkObjectSize: '1024',
        chunkObjectExpiresAt: objectExpiresAt,
        recordCount: '5000',
      },
      {
        chunkIndex: 1,
        chunkHash: sha(`${fixture.sheetId}|chunk|1`),
        chunkObjectId: `${PREFIX}_chunk_1`,
        chunkObjectVersion: `${PREFIX}_chunk_version_1`,
        chunkObjectSha256: sha(`${fixture.sheetId}|chunk_object|1`),
        chunkObjectSize: '512',
        chunkObjectExpiresAt: objectExpiresAt,
        recordCount: '1',
      },
    ],
  })
}

function mintToken(
  fixture: Fixture,
  plan: RecoveryArchiveRestorePlan,
  expiresIn: '1s' | '10m' = '10m',
): string {
  const claims: ExactArchiveRecoveryIdentityClaims = {
    sheetId: fixture.sheetId,
    anchorOperationId: fixture.anchorOperationId,
    anchorSeq: fixture.anchorSeq,
    checkpointId: fixture.checkpointId,
    scopeHash: plan.scopeHash,
    liveSetHash: sha(`${fixture.sheetId}|live`),
    schemaHash: sha(`${fixture.sheetId}|schema`),
    actorId: fixture.actorId,
    mode: plan.recoveryMode,
    authorizedScopeHash: sha(`${fixture.sheetId}|authorized`),
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    archiveSourceVectorHash: fixture.sourceVectorHash,
    archiveKeyId: fixture.keyId,
    archivePlanHash: plan.planHash,
    archivePlanObject: {
      objectId: plan.planObjectId,
      version: plan.planObjectVersion,
      sha256: plan.planObjectSha256,
      size: plan.planObjectSize,
      expiresAt: plan.planObjectExpiresAt,
    },
    scopeKind: plan.scopeKind,
  }
  return mintExactArchiveRecoveryIdentity(claims, expiresIn)
}

function restoreRequestIdentity(fixture: Fixture) {
  return {
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
  }
}

async function preparePlan(
  fixture: Fixture,
  plan: RecoveryArchiveRestorePlan,
  token: string,
): Promise<void> {
  await prepareRecoveryArchiveRestorePlan(transaction, {
    token,
    plan,
    identity: restoreRequestIdentity(fixture),
  })
}

async function seedSyncApplyWorld(label: string) {
  const fixture = await seedVerifiedArchive(label)
  const fieldId = `${fixture.sheetId}_field`
  const recordId = `${fixture.sheetId}_record`
  const archivedData = { [fieldId]: 'archived' }
  const liveData = { [fieldId]: 'live' }
  await q(
    `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
     VALUES ($1, $2, 'Value', 'string', '{}'::jsonb, 1)`,
    [fieldId, fixture.sheetId],
  )
  await q(
    `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
     VALUES ($1, $2, $3::jsonb, 2, $4, $4)`,
    [recordId, fixture.sheetId, JSON.stringify(liveData), fixture.actorId],
  )

  const scopeHash = hashAnchorRecoveryScope([
    { recordId, exists: true, version: 1 },
  ])
  const plan = compileRecoveryArchiveSyncPlan({
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
    recoveryMode: 'revert',
    scopeKind: 'whole_sheet',
    scopeHash,
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    sourceVectorHash: fixture.sourceVectorHash,
    keyId: fixture.keyId,
    selectedRecordIds: [],
    selectedFieldIds: [],
  })
  const token = mintExactArchiveRecoveryIdentity({
    sheetId: fixture.sheetId,
    anchorOperationId: fixture.anchorOperationId,
    anchorSeq: fixture.anchorSeq,
    checkpointId: fixture.checkpointId,
    scopeHash,
    liveSetHash: hashExactAnchorLiveSet([{ recordId, version: 2 }], []),
    schemaHash: hashExactAnchorSchema([{ id: fieldId, type: 'string', property: {} }]),
    actorId: fixture.actorId,
    mode: 'revert',
    authorizedScopeHash: hashRecoveryAuthorizationScope({
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
    }),
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    archiveSourceVectorHash: fixture.sourceVectorHash,
    archiveKeyId: fixture.keyId,
    archivePlanHash: plan.planHash,
    scopeKind: 'whole_sheet',
  }, '10m')
  const targetRecords = new Map([
    [recordId, { recordId, exists: true, data: archivedData, version: 1 }],
  ])

  return { fixture, fieldId, recordId, archivedData, liveData, plan, token, targetRecords }
}

function syncApplyInput(
  fixture: Fixture,
  token: string,
  onMutationApplied?: ExactAnchorApplyInput['onMutationApplied'],
): ExactAnchorApplyInput {
  return {
    token,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
    preliminaryFullRead: async () => true,
    stabilizeAuthorization: async () => 'ready',
    finalLockedFullRead: async () => true,
    evaluatePlanAuthorization: async () => true,
    onMutationApplied,
  }
}

function mintScopedSyncToken(
  fixture: Fixture,
  input: {
    scopeKind: 'whole_sheet' | 'selected_records' | 'selected_fields'
    targetRecords: ReadonlyMap<string, {
      recordId: string
      exists: boolean
      data: Record<string, unknown> | null
      version: number | null
    }>
    liveRecords: readonly { recordId: string; version: number }[]
    schema: readonly { id: string; type: string; property: unknown }[]
    selectedRecordIds: readonly string[]
    selectedFieldIds: readonly string[]
  },
) {
  const anchorIds = input.scopeKind === 'whole_sheet'
    ? [...input.targetRecords.keys()]
    : [...input.selectedRecordIds]
  const scopeHash = hashAnchorRecoveryScope(anchorIds.map((recordId) => {
    const state = input.targetRecords.get(recordId)
    if (!state) throw new Error('sync_scope_fixture_target_missing')
    return { recordId, exists: state.exists, version: state.version }
  }))
  const plan = compileRecoveryArchiveSyncPlan({
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
    recoveryMode: 'revert',
    scopeKind: input.scopeKind,
    scopeHash,
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    sourceVectorHash: fixture.sourceVectorHash,
    keyId: fixture.keyId,
    selectedRecordIds: input.selectedRecordIds,
    selectedFieldIds: input.selectedFieldIds,
  })
  const token = mintExactArchiveRecoveryIdentity({
    sheetId: fixture.sheetId,
    anchorOperationId: fixture.anchorOperationId,
    anchorSeq: fixture.anchorSeq,
    checkpointId: fixture.checkpointId,
    scopeHash,
    liveSetHash: hashExactAnchorLiveSet([...input.liveRecords], []),
    schemaHash: hashExactAnchorSchema([...input.schema]),
    actorId: fixture.actorId,
    mode: 'revert',
    authorizedScopeHash: hashRecoveryAuthorizationScope({
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
    }),
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    archiveSourceVectorHash: fixture.sourceVectorHash,
    archiveKeyId: fixture.keyId,
    archivePlanHash: plan.planHash,
    scopeKind: input.scopeKind,
  }, '10m')
  return { plan, token }
}

async function applyChunk(
  query: RecoveryArchiveRestoreJobQuery,
  input: { sheetId: string; actorId: string; operationId: string; chunkIndex: number },
): Promise<string> {
  const inserted = await query(
    `INSERT INTO public.meta_record_revisions (
       sheet_id, record_id, version, action, source, actor_id,
       changed_field_ids, patch, snapshot, operation_id
     ) VALUES (
       $1, $2, 1, 'create', 'restore', $3,
       ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, $4::uuid
     )
     RETURNING seq::text AS seq`,
    [input.sheetId, `${PREFIX}_restored_${input.chunkIndex}_${randomUUID()}`, input.actorId, input.operationId],
  )
  const seq = (inserted.rows[0] as { seq?: unknown } | undefined)?.seq
  if (typeof seq !== 'string') throw new Error('recovery_archive_restore_job_fixture_seq_missing')
  return seq
}

async function runOneChunk(
  claim: Parameters<typeof runRecoveryArchiveRestoreChunk>[1],
  applied: number[],
) {
  return runRecoveryArchiveRestoreChunk(transaction, claim, {
    read: q,
    materialize: async (expected) => {
      expect(transactionDepth).toBe(0)
      return { ...expected, payload: Object.freeze({ admitted: true }) }
    },
    recheckAuthority: async () => true,
    apply: async (query, context) => {
      expect(transactionDepth).toBe(1)
      applied.push(context.chunkIndex)
      return {
        endpointSeq: await applyChunk(query, context),
        eventCount: 1,
        committedCount: context.chunkIndex === 0 ? '5000' : '1',
      }
    },
  })
}

async function waitUntil(timestamp: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await q(`SELECT clock_timestamp() >= $1::timestamptz AS reached`, [timestamp])
    if ((result.rows[0] as { reached?: unknown } | undefined)?.reached === true) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('recovery_archive_restore_job_clock_wait_timeout')
}

async function databaseFuture(milliseconds: number): Promise<string> {
  const result = await q(
    `SELECT (clock_timestamp() + ($1::bigint * interval '1 millisecond'))::text AS at`,
    [milliseconds],
  )
  const value = (result.rows[0] as { at?: unknown } | undefined)?.at
  if (typeof value !== 'string') throw new Error('recovery_archive_restore_job_db_clock_missing')
  return value
}

function transactionWithApplicationName(
  applicationName: string,
): RecoveryArchiveRestoreJobTransaction {
  return async (work) => {
    const client = await pool.connect()
    try {
      await client.query(`SELECT set_config('application_name', $1, false)`, [applicationName])
      await client.query('BEGIN')
      const result = await work(async (text, values) => {
        const queryResult = await client.query(text, values)
        return queryResult as QueryResult
      })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}

async function waitForBlockedApplication(applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_stat_activity activity
          WHERE activity.application_name = $1
            AND activity.wait_event_type = 'Lock'
            AND pg_catalog.cardinality(pg_catalog.pg_blocking_pids(activity.pid)) > 0
       ) AS blocked`,
      [applicationName],
    )
    if ((result.rows[0] as { blocked?: unknown } | undefined)?.blocked === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('recovery_archive_restore_job_lock_wait_not_observed')
}

async function cleanupFixtures(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    const sheets = await client.query<{ id: string }>(
      `SELECT id FROM public.meta_sheets WHERE id LIKE $1`,
      [`${PREFIX}%`],
    )
    const sheetIds = sheets.rows.map((row) => row.id)
    if (sheetIds.length > 0) {
      await client.query(`DELETE FROM public.meta_recovery_token_burns WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_sync_receipts WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_restore_plans WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(
        `DELETE FROM public.meta_recovery_archive_job_chunks
          WHERE job_id IN (SELECT id FROM public.meta_recovery_archive_jobs WHERE sheet_id=ANY($1::text[]))`,
        [sheetIds],
      )
      await client.query(`DELETE FROM public.meta_recovery_archive_jobs WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_record_history_operation_members WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_record_history_snapshot_members WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(
        `DELETE FROM public.meta_recovery_archive_objects
          WHERE generation_id IN (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`,
        [sheetIds],
      )
      await client.query(
        `DELETE FROM public.meta_recovery_archive_snapshot_reservations
          WHERE generation_id IN (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`,
        [sheetIds],
      )
      await client.query(`DELETE FROM public.meta_recovery_archive_section_bootstrap_markers WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_legal_holds WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_staging_objects WHERE generation_id IN (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_attachment_refs WHERE generation_id IN (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archive_coverage_items WHERE generation_id IN (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`, [sheetIds])
      await client.query(`DELETE FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_sheet_section_revisions WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_record_revisions WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_record_history_operations WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_history_trust_checkpoints WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(
        `DELETE FROM public.meta_links
          WHERE record_id IN (SELECT id FROM public.meta_records WHERE sheet_id=ANY($1::text[]))
             OR field_id IN (SELECT id FROM public.meta_fields WHERE sheet_id=ANY($1::text[]))`,
        [sheetIds],
      )
      await client.query(`DELETE FROM public.meta_records_trash WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_records WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_fields WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      await client.query(`DELETE FROM public.meta_sheets WHERE id=ANY($1::text[])`, [sheetIds])
    }
    await client.query(`DELETE FROM public.meta_recovery_archive_keys WHERE key_id LIKE $1`, [`${PREFIX}%`])
    await client.query(`DELETE FROM public.meta_bases WHERE id LIKE $1`, [`${PREFIX}%`])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

describeIfRealDbStep('Phase D5 durable archive restore jobs (real DB)', () => {
  beforeAll(async () => {
    previousJwtSecret = process.env.JWT_SECRET
    previousArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    previousWriterFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    previousStrictFlag = process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    process.env.JWT_SECRET = `${PREFIX}_jwt_secret_with_sufficient_length_1234567890`
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    migrationDb = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }),
      }),
    })
    const presence = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_jobs') IS NOT NULL AS present`,
    )
    if ((presence.rows[0] as { present?: unknown } | undefined)?.present !== true) {
      throw new Error('recovery_archive_restore_job_schema_missing')
    }
  })

  afterAll(async () => {
    await cleanupFixtures()
    await migrationDb.destroy()
    await pool.end()
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousJwtSecret
    if (previousArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = previousArchiveFlag
    if (previousWriterFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousWriterFenceFlag
    if (previousStrictFlag === undefined) delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    else process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = previousStrictFlag
  })

  test('applies a <=5000 archive sync through L8 and atomically binds burn, seal, and receipt', async () => {
    const world = await seedSyncApplyWorld('sync_l8')
    const result = await applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(world.fixture, world.token),
      {
        workspaceId: world.fixture.workspaceId,
        baseId: world.fixture.baseId,
        targetRecords: world.targetRecords,
        targetLinks: [],
        selectedRecordIds: [],
        selectedFieldIds: [],
        auditedReplayHorizonMs: 0,
      },
    )
    expect(result).toMatchObject({
      ok: true,
      mode: 'revert',
      applied: { reverts: 1, resurrects: 0, deletes: 0 },
    })

    const evidence = await q(
      `SELECT
         record_row.data,
         record_row.version,
         revision.source,
         revision.changed_field_ids,
         operation.operation_kind,
         operation.event_contract_version,
         operation.event_count,
         burn.burn_kind,
         burn.archive_generation_id::text,
         burn.sync_operation_id::text,
         receipt.archive_generation_id::text AS receipt_generation_id,
         receipt.operation_id::text AS receipt_operation_id,
         receipt.archive_root_hash,
         receipt.source_vector_hash,
         receipt.plan_hash,
         receipt.applied_count::int
       FROM public.meta_records record_row
       JOIN public.meta_record_revisions revision
         ON revision.sheet_id=record_row.sheet_id
        AND revision.record_id=record_row.id
        AND revision.source='restore'
       JOIN public.meta_record_history_operations operation
         ON operation.sheet_id=revision.sheet_id
        AND operation.operation_id=revision.operation_id
       JOIN public.meta_recovery_token_burns burn
         ON burn.sheet_id=operation.sheet_id
        AND burn.sync_operation_id=operation.operation_id
       JOIN public.meta_recovery_archive_sync_receipts receipt
         ON receipt.sheet_id=operation.sheet_id
        AND receipt.operation_id=operation.operation_id
      WHERE record_row.id=$1`,
      [world.recordId],
    )
    expect(evidence.rows).toEqual([expect.objectContaining({
      data: world.archivedData,
      version: 3,
      source: 'restore',
      changed_field_ids: [world.fieldId],
      operation_kind: 'ordinary',
      event_contract_version: 2,
      event_count: 1,
      burn_kind: 'sync',
      archive_generation_id: world.fixture.generationId,
      sync_operation_id: expect.any(String),
      receipt_generation_id: world.fixture.generationId,
      receipt_operation_id: expect.any(String),
      archive_root_hash: world.fixture.rootHash,
      source_vector_hash: world.fixture.sourceVectorHash,
      plan_hash: world.plan.planHash,
      applied_count: 1,
    })])
    expect((evidence.rows[0] as { sync_operation_id: string }).sync_operation_id)
      .toBe((evidence.rows[0] as { receipt_operation_id: string }).receipt_operation_id)

    expect(await applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(world.fixture, world.token),
      {
        workspaceId: world.fixture.workspaceId,
        baseId: world.fixture.baseId,
        targetRecords: world.targetRecords,
        targetLinks: [],
        selectedRecordIds: [],
        selectedFieldIds: [],
        auditedReplayHorizonMs: 0,
      },
    )).toEqual({ ok: false, reason: 'token-replayed' })
  })

  test('locks archive links from the authoritative links section, not stale record JSON', async () => {
    const fixture = await seedVerifiedArchive('sync_authoritative_links')
    const targetSheetId = `${fixture.sheetId}_target_sheet`
    const linkFieldId = `${fixture.sheetId}_link_field`
    const sourceRecordId = `${fixture.sheetId}_source_record`
    const validTargetId = `${fixture.sheetId}_valid_target`
    const staleTargetId = `${fixture.sheetId}_stale_target`
    const linkProperty = { foreignSheetId: targetSheetId }
    await q(
      `INSERT INTO public.meta_sheets (id, base_id, name) VALUES ($1, $2, 'Target')`,
      [targetSheetId, fixture.baseId],
    )
    await q(
      `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Relation', 'link', $3::jsonb, 1)`,
      [linkFieldId, fixture.sheetId, JSON.stringify(linkProperty)],
    )
    await q(
      `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES
         ($1, $3, $5::jsonb, 2, $6, $6),
         ($2, $4, '{}'::jsonb, 1, $6, $6),
         ($7, $4, '{}'::jsonb, 1, $6, $6)`,
      [
        sourceRecordId,
        validTargetId,
        fixture.sheetId,
        targetSheetId,
        JSON.stringify({ [linkFieldId]: [] }),
        fixture.actorId,
        staleTargetId,
      ],
    )
    const targetRecords = new Map([
      [sourceRecordId, {
        recordId: sourceRecordId,
        exists: true,
        data: { [linkFieldId]: [staleTargetId] },
        version: 1,
      }],
    ])
    const identity = mintScopedSyncToken(fixture, {
      scopeKind: 'whole_sheet',
      targetRecords,
      liveRecords: [{ recordId: sourceRecordId, version: 2 }],
      schema: [{ id: linkFieldId, type: 'link', property: linkProperty }],
      selectedRecordIds: [],
      selectedFieldIds: [],
    })
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT id FROM public.meta_records WHERE id=$1 FOR UPDATE`,
        [staleTargetId],
      )

      expect(await applyMaterializedExactArchiveRecoverySyncInternal(
        transaction,
        syncApplyInput(fixture, identity.token),
        {
          workspaceId: fixture.workspaceId,
          baseId: fixture.baseId,
          targetRecords,
          targetLinks: [{
            fieldId: linkFieldId,
            recordId: sourceRecordId,
            foreignRecordId: validTargetId,
          }],
          selectedRecordIds: [],
          selectedFieldIds: [],
          auditedReplayHorizonMs: 0,
        },
      )).toMatchObject({ ok: true, applied: { reverts: 1 } })
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }

    const restored = await q(
      `SELECT data FROM public.meta_records WHERE id=$1`,
      [sourceRecordId],
    )
    expect(restored.rows).toEqual([{ data: { [linkFieldId]: [validTargetId] } }])
    const links = await q(
      `SELECT field_id, record_id, foreign_record_id
         FROM public.meta_links
        WHERE record_id=$1
        ORDER BY field_id, foreign_record_id`,
      [sourceRecordId],
    )
    expect(links.rows).toEqual([{
      field_id: linkFieldId,
      record_id: sourceRecordId,
      foreign_record_id: validTargetId,
    }])
  })

  test('rolls back live write, revision, operation, burn, and receipt when the mutation hook fails', async () => {
    const world = await seedSyncApplyWorld('sync_rollback')
    const operationsBefore = Number((await q(
      `SELECT count(*)::int AS count
         FROM public.meta_record_history_operations
        WHERE sheet_id=$1`,
      [world.fixture.sheetId],
    )).rows[0]?.count)
    await expect(applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(world.fixture, world.token, async () => {
        throw new Error('constructed_sync_hook_failure')
      }),
      {
        workspaceId: world.fixture.workspaceId,
        baseId: world.fixture.baseId,
        targetRecords: world.targetRecords,
        targetLinks: [],
        selectedRecordIds: [],
        selectedFieldIds: [],
        auditedReplayHorizonMs: 0,
      },
    )).rejects.toThrow('constructed_sync_hook_failure')

    const residue = await q(
      `SELECT
         record_row.data,
         record_row.version,
         (SELECT count(*)::int FROM public.meta_record_revisions
           WHERE sheet_id=$2 AND source='restore') AS revisions,
         (SELECT count(*)::int FROM public.meta_record_history_operations
           WHERE sheet_id=$2) AS operations,
         (SELECT count(*)::int FROM public.meta_recovery_token_burns
           WHERE sheet_id=$2) AS burns,
         (SELECT count(*)::int FROM public.meta_recovery_archive_sync_receipts
           WHERE sheet_id=$2) AS receipts
       FROM public.meta_records record_row
      WHERE record_row.id=$1`,
      [world.recordId, world.fixture.sheetId],
    )
    expect(residue.rows).toEqual([{
      data: world.liveData,
      version: 2,
      revisions: 0,
      operations: operationsBefore,
      burns: 0,
      receipts: 0,
    }])

    expect((await applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(world.fixture, world.token),
      {
        workspaceId: world.fixture.workspaceId,
        baseId: world.fixture.baseId,
        targetRecords: world.targetRecords,
        targetLinks: [],
        selectedRecordIds: [],
        selectedFieldIds: [],
        auditedReplayHorizonMs: 0,
      },
    )).ok).toBe(true)
  })

  test('selected-record sync changes only the token-bound records', async () => {
    const fixture = await seedVerifiedArchive('sync_selected_records')
    const fieldId = `${fixture.sheetId}_field`
    const selectedId = `${fixture.sheetId}_selected`
    const untouchedId = `${fixture.sheetId}_untouched`
    await q(
      `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Value', 'string', '{}'::jsonb, 1)`,
      [fieldId, fixture.sheetId],
    )
    await q(
      `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES
         ($1, $3, $4::jsonb, 2, $6, $6),
         ($2, $3, $5::jsonb, 2, $6, $6)`,
      [
        selectedId,
        untouchedId,
        fixture.sheetId,
        JSON.stringify({ [fieldId]: 'selected-live' }),
        JSON.stringify({ [fieldId]: 'untouched-live' }),
        fixture.actorId,
      ],
    )
    const targetRecords = new Map([
      [selectedId, {
        recordId: selectedId,
        exists: true,
        data: { [fieldId]: 'selected-archived' },
        version: 1,
      }],
      [untouchedId, {
        recordId: untouchedId,
        exists: true,
        data: { [fieldId]: 'untouched-archived' },
        version: 1,
      }],
    ])
    const identity = mintScopedSyncToken(fixture, {
      scopeKind: 'selected_records',
      targetRecords,
      liveRecords: [
        { recordId: selectedId, version: 2 },
        { recordId: untouchedId, version: 2 },
      ],
      schema: [{ id: fieldId, type: 'string', property: {} }],
      selectedRecordIds: [selectedId],
      selectedFieldIds: [],
    })

    expect(await applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(fixture, identity.token),
      {
        workspaceId: fixture.workspaceId,
        baseId: fixture.baseId,
        targetRecords,
        targetLinks: [],
        selectedRecordIds: [selectedId],
        selectedFieldIds: [],
        auditedReplayHorizonMs: 0,
      },
    )).toMatchObject({ ok: true, applied: { reverts: 1 } })
    const records = await q(
      `SELECT id, data, version FROM public.meta_records
        WHERE id=ANY($1::text[]) ORDER BY id`,
      [[selectedId, untouchedId]],
    )
    expect(records.rows).toEqual([
      { id: selectedId, data: { [fieldId]: 'selected-archived' }, version: 3 },
      { id: untouchedId, data: { [fieldId]: 'untouched-live' }, version: 2 },
    ].sort((left, right) => left.id.localeCompare(right.id)))
  })

  test('selected-field sync changes only the chosen fields on the chosen records', async () => {
    const fixture = await seedVerifiedArchive('sync_selected_fields')
    const selectedFieldId = `${fixture.sheetId}_selected_field`
    const untouchedFieldId = `${fixture.sheetId}_untouched_field`
    const selectedRecordId = `${fixture.sheetId}_selected_record`
    const untouchedRecordId = `${fixture.sheetId}_untouched_record`
    await q(
      `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
       VALUES
         ($1, $3, 'Selected', 'string', '{}'::jsonb, 1),
         ($2, $3, 'Untouched', 'string', '{}'::jsonb, 2)`,
      [selectedFieldId, untouchedFieldId, fixture.sheetId],
    )
    const selectedLive = {
      [selectedFieldId]: 'selected-live',
      [untouchedFieldId]: 'same-record-live',
    }
    const untouchedLive = {
      [selectedFieldId]: 'other-record-live',
      [untouchedFieldId]: 'other-record-other-field-live',
    }
    await q(
      `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES
         ($1, $3, $4::jsonb, 2, $6, $6),
         ($2, $3, $5::jsonb, 2, $6, $6)`,
      [
        selectedRecordId,
        untouchedRecordId,
        fixture.sheetId,
        JSON.stringify(selectedLive),
        JSON.stringify(untouchedLive),
        fixture.actorId,
      ],
    )
    const targetRecords = new Map([
      [selectedRecordId, {
        recordId: selectedRecordId,
        exists: true,
        data: {
          [selectedFieldId]: 'selected-archived',
          [untouchedFieldId]: 'same-record-archived',
        },
        version: 1,
      }],
      [untouchedRecordId, {
        recordId: untouchedRecordId,
        exists: true,
        data: {
          [selectedFieldId]: 'other-record-archived',
          [untouchedFieldId]: 'other-record-other-field-archived',
        },
        version: 1,
      }],
    ])
    const identity = mintScopedSyncToken(fixture, {
      scopeKind: 'selected_fields',
      targetRecords,
      liveRecords: [
        { recordId: selectedRecordId, version: 2 },
        { recordId: untouchedRecordId, version: 2 },
      ],
      schema: [
        { id: selectedFieldId, type: 'string', property: {} },
        { id: untouchedFieldId, type: 'string', property: {} },
      ],
      selectedRecordIds: [selectedRecordId],
      selectedFieldIds: [selectedFieldId],
    })

    expect(await applyMaterializedExactArchiveRecoverySyncInternal(
      transaction,
      syncApplyInput(fixture, identity.token),
      {
        workspaceId: fixture.workspaceId,
        baseId: fixture.baseId,
        targetRecords,
        targetLinks: [],
        selectedRecordIds: [selectedRecordId],
        selectedFieldIds: [selectedFieldId],
        auditedReplayHorizonMs: 0,
      },
    )).toMatchObject({ ok: true, applied: { reverts: 1 } })
    const records = await q(
      `SELECT id, data, version FROM public.meta_records
        WHERE id=ANY($1::text[]) ORDER BY id`,
      [[selectedRecordId, untouchedRecordId]],
    )
    expect(records.rows).toEqual([
      {
        id: selectedRecordId,
        data: {
          [selectedFieldId]: 'selected-archived',
          [untouchedFieldId]: 'same-record-live',
        },
        version: 3,
      },
      { id: untouchedRecordId, data: untouchedLive, version: 2 },
    ].sort((left, right) => left.id.localeCompare(right.id)))
    const revision = await q(
      `SELECT changed_field_ids FROM public.meta_record_revisions
        WHERE sheet_id=$1 AND record_id=$2 AND source='restore'`,
      [fixture.sheetId, selectedRecordId],
    )
    expect(revision.rows).toEqual([{ changed_field_ids: [selectedFieldId] }])
  })

  test('fails migration preflight when archive expiry or writer ownership columns drift', async () => {
    const expiryDrift = await databaseError(migrationDb.transaction().execute(async (trx) => {
      await sql`
        ALTER TABLE public.meta_recovery_archives
          RENAME COLUMN expires_at TO expires_at_d5_drift
      `.execute(trx)
      await restoreJobsMigration.up(trx)
    }))
    expect(expiryDrift).toMatchObject({
      code: '55000',
      message: 'recovery_archive_restore_job_source_schema_mismatch',
    })

    const writerDrift = await databaseError(migrationDb.transaction().execute(async (trx) => {
      await sql`
        ALTER TABLE public.meta_sheets
          RENAME COLUMN recovery_writer_owner_kind TO recovery_writer_owner_kind_d5_drift
      `.execute(trx)
      await restoreJobsMigration.up(trx)
    }))
    expect(writerDrift).toMatchObject({
      code: '55000',
      message: 'recovery_archive_restore_job_source_schema_mismatch',
    })
  })

  test('requires one exact prepared plan and expires unused tokens without reopening archive binding', async () => {
    const fixture = await seedVerifiedArchive('prepared_plan')
    const plan = compilePlan(fixture)
    const token = mintToken(fixture, plan)

    await expect(acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: future(60_000),
      recheckAuthority: async () => true,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID',
    ))

    await preparePlan(fixture, plan, token)
    await preparePlan(fixture, plan, token)
    await expect(q(
      `UPDATE public.meta_recovery_archive_restore_plans
          SET plan_object_sha256=$2, row_version=row_version+1
        WHERE token_sha256=$1`,
      [sha(token), sha(`${fixture.sheetId}|substituted_plan_object`)],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_restore_plan_immutable_or_cas_invalid',
    })
    const prepared = await q(
      `SELECT state, row_version::text AS row_version,
              accepted_job_id::text AS accepted_job_id
         FROM public.meta_recovery_archive_restore_plans
        WHERE token_sha256=$1`,
      [sha(token)],
    )
    expect(prepared.rows[0]).toEqual({
      state: 'prepared',
      row_version: '1',
      accepted_job_id: null,
    })

    const expiringFixture = await seedVerifiedArchive('prepared_plan_expiry')
    const expiringPlan = compilePlan(expiringFixture)
    const expiringToken = mintToken(expiringFixture, expiringPlan, '1s')
    await preparePlan(expiringFixture, expiringPlan, expiringToken)
    const expiry = await q(
      `SELECT token_expires_at::text AS token_expires_at
         FROM public.meta_recovery_archive_restore_plans
        WHERE token_sha256=$1`,
      [sha(expiringToken)],
    )
    await waitUntil(String((expiry.rows[0] as Record<string, unknown>).token_expires_at))
    expect(await sweepExpiredRecoveryArchiveRestorePlans(transaction)).toBe(1)
    const expired = await q(
      `SELECT state, row_version::text AS row_version
         FROM public.meta_recovery_archive_restore_plans
        WHERE token_sha256=$1`,
      [sha(expiringToken)],
    )
    expect(expired.rows[0]).toEqual({ state: 'expired', row_version: '2' })
  })

  test('loads one frozen async plan outside the transaction before accepting its durable job', async () => {
    const fixture = await seedVerifiedArchive('frozen_async_accept')
    const liveRecords = new Map<string, { version: number }>()
    const targetRecords = new Map<string, { recordId: string; exists: boolean; version: number | null }>()
    const deleteRecordIds: string[] = []
    for (let index = 0; index < 5001; index += 1) {
      const recordId = `${fixture.sheetId}_record_${String(index).padStart(5, '0')}`
      liveRecords.set(recordId, { version: 1 })
      targetRecords.set(recordId, { recordId, exists: false, version: null })
      deleteRecordIds.push(recordId)
    }
    const schemaHash = sha(`${fixture.sheetId}|frozen|schema`)
    const scopeHash = sha(`${fixture.sheetId}|frozen|scope`)
    const authorizedScopeHash = sha(`${fixture.sheetId}|frozen|authorized`)
    const bundle = buildRecoveryArchiveAsyncPlan({
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
      recoveryMode: 'reset',
      scopeKind: 'whole_sheet',
      scopeHash,
      archiveGenerationId: fixture.generationId,
      archiveRootHash: fixture.rootHash,
      sourceVectorHash: fixture.sourceVectorHash,
      keyId: fixture.keyId,
      anchorOperationId: fixture.anchorOperationId,
      anchorSeq: fixture.anchorSeq,
      checkpointId: fixture.checkpointId,
      schemaHash,
      authorizedScopeHash,
      selectedRecordIds: [],
      selectedFieldIds: [],
      liveRecords,
      targetRecords,
      liveLinks: [],
      revertWrites: [],
      deleteRecordIds,
      expiresAt: '2099-12-31T00:00:00.000Z',
    })
    const root = await mkdtemp(join(tmpdir(), 'tm-frozen-async-plan-'))
    const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
    const depthProbe = { currentTransactionDepth: () => transactionDepth }
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe)

    try {
      expect(transactionDepth).toBe(0)
      await persistRecoveryArchiveAsyncPlan(store, bundle)
      expect(transactionDepth).toBe(0)
      const payload = bundle.planObject.payload
      const descriptor = bundle.planObject.descriptor
      const token = mintExactArchiveRecoveryIdentity({
        sheetId: fixture.sheetId,
        anchorOperationId: fixture.anchorOperationId,
        anchorSeq: fixture.anchorSeq,
        checkpointId: fixture.checkpointId,
        scopeHash,
        liveSetHash: payload.initialLiveSetHash,
        schemaHash,
        actorId: fixture.actorId,
        mode: 'reset',
        authorizedScopeHash,
        archiveGenerationId: fixture.generationId,
        archiveRootHash: fixture.rootHash,
        archiveSourceVectorHash: fixture.sourceVectorHash,
        archiveKeyId: fixture.keyId,
        archivePlanHash: bundle.plan.planHash,
        archivePlanObject: {
          objectId: descriptor.objectId,
          version: descriptor.version,
          sha256: descriptor.sha256,
          size: descriptor.size,
          expiresAt: descriptor.expiresAt,
        },
        scopeKind: 'whole_sheet',
      }, '10m')
      await preparePlan(fixture, bundle.plan, token)

      const accepted = await acceptFrozenRecoveryArchiveRestoreJob(
        transaction,
        provider,
        depthProbe,
        {
          identity: restoreRequestIdentity(fixture),
          token,
          resumeDeadline: future(300_000),
          recheckAuthority: async () => true,
        },
      )

      expect(transactionDepth).toBe(0)
      expect(accepted).toMatchObject({ state: 'planned', totalCount: '5001', completedCount: '0' })
      const registry = await q(
        `SELECT state, plan_hash, plan_object_id, plan_object_version
           FROM public.meta_recovery_archive_restore_plans
          WHERE token_sha256 = $1`,
        [sha(token)],
      )
      expect(registry.rows).toEqual([expect.objectContaining({
        state: 'accepted',
        plan_hash: bundle.plan.planHash,
        plan_object_id: descriptor.objectId,
        plan_object_version: descriptor.version,
      })])
      await expect(cancelRecoveryArchiveRestoreJob(transaction, {
        ...restoreRequestIdentity(fixture),
        jobId: accepted.id,
        replayHorizonMs: 0,
        recheckAuthority: async () => true,
      })).resolves.toMatchObject({ state: 'cancelled_zero_write' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts, applies two chunks, seals one exact aggregate, and releases the writer block', async () => {
    const fixture = await seedVerifiedArchive('complete')
    const plan = compilePlan(fixture)
    const token = mintToken(fixture, plan)
    await preparePlan(fixture, plan, token)
    const accepted = await acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: future(60_000),
      recheckAuthority: async () => true,
    })
    expect(accepted).toMatchObject({ state: 'planned', totalCount: '5001', completedCount: '0' })

    const candidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    expect(candidate?.jobId).toBe(accepted.id)
    const claim = await claimRecoveryArchiveRestoreJob(transaction, candidate!, {
      workerOwnerId: `${PREFIX}_worker_1`,
      leaseUntil: future(45_000),
    })
    expect(claim.workerFence).toBe('1')

    const applied: number[] = []
    expect(await runOneChunk(claim, applied)).toMatchObject({
      kind: 'committed',
      chunkIndex: 0,
      completedCount: '5000',
    })
    expect(await runOneChunk(claim, applied)).toMatchObject({
      kind: 'committed',
      chunkIndex: 1,
      completedCount: '5001',
    })
    expect(applied).toEqual([0, 1])

    await expect(transaction(async (query) => {
      const chunks = await query(
        `SELECT operation_id::text AS operation_id, endpoint_seq::text AS endpoint_seq
           FROM public.meta_recovery_archive_job_chunks
          WHERE job_id=$1::uuid
          ORDER BY chunk_index`,
        [accepted.id],
      )
      const first = chunks.rows[0] as { operation_id: string; endpoint_seq: string }
      const foreignOperationId = randomUUID()
      const foreignEndpointSeq = await applyChunk(query, {
        sheetId: fixture.sheetId,
        actorId: fixture.actorId,
        operationId: foreignOperationId,
        chunkIndex: 99,
      })
      await sealDirectEventOperation(query, {
        sheetId: fixture.sheetId,
        operationId: foreignOperationId,
        endpointSeq: foreignEndpointSeq,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
      const badAggregateId = randomUUID()
      await sealRestoreAggregateOperation(query, {
        sheetId: fixture.sheetId,
        operationId: badAggregateId,
        endpointSeq: foreignEndpointSeq,
        members: [
          {
            ordinal: 1,
            childOperationId: first.operation_id,
            childEndpointSeq: first.endpoint_seq,
            childEventCount: 1,
          },
          {
            ordinal: 2,
            childOperationId: foreignOperationId,
            childEndpointSeq: foreignEndpointSeq,
            childEventCount: 1,
          },
        ],
      })
      await query(
        `UPDATE public.meta_recovery_archive_jobs
            SET state='done', worker_owner_id=NULL, lease_until=NULL,
                terminal_operation_id=$2::uuid, terminal_at=clock_timestamp(),
                row_version=row_version+1
          WHERE id=$1::uuid`,
        [accepted.id, badAggregateId],
      )
    })).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_job_terminal_membership_invalid',
    })

    const terminal = await finalizeRecoveryArchiveRestoreJob(transaction, claim, {
      replayHorizonMs: 0,
    })
    expect(terminal).toMatchObject({ state: 'done', completedCount: '5001' })
    expect(terminal.terminalOperationId).toMatch(/^[0-9a-f-]{36}$/)

    const evidence = await q(
      `SELECT job.state, job.completed_count::text,
              operation_row.operation_kind, operation_row.event_contract_version,
              operation_row.component_count, operation_row.event_count,
              (SELECT count(*)::int
                 FROM public.meta_record_history_operation_members member_row
                WHERE member_row.sheet_id=job.sheet_id
                  AND member_row.parent_operation_id=job.terminal_operation_id) AS member_count,
              sheet.recovery_writer_state,
              burn.burn_kind, burn.terminal_at IS NOT NULL AS burn_terminal,
              prepared.state AS prepared_state,
              prepared.accepted_job_id = job.id AS prepared_job_bound
         FROM public.meta_recovery_archive_jobs job
         JOIN public.meta_record_history_operations operation_row
           ON operation_row.sheet_id=job.sheet_id
          AND operation_row.operation_id=job.terminal_operation_id
         JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
         JOIN public.meta_recovery_token_burns burn ON burn.job_id=job.id
         JOIN public.meta_recovery_archive_restore_plans prepared
           ON prepared.token_sha256=job.token_sha256
        WHERE job.id=$1::uuid`,
      [accepted.id],
    )
    expect(evidence.rows[0]).toMatchObject({
      state: 'done',
      completed_count: '5001',
      operation_kind: 'restore_aggregate',
      event_contract_version: 2,
      component_count: 2,
      event_count: 2,
      member_count: 2,
      recovery_writer_state: null,
      burn_kind: 'async',
      burn_terminal: true,
      prepared_state: 'accepted',
      prepared_job_bound: true,
    })

    await expect(acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: future(60_000),
      recheckAuthority: async () => true,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED',
    ))
  })

  test('recomputes the plan, binds the archive lifetime, and lets DB time reject an expired lease', async () => {
    const fixture = await seedVerifiedArchive('admission')
    const plan = compilePlan(fixture)
    const token = mintToken(fixture, plan)
    await preparePlan(fixture, plan, token)
    const tamperedPlan = {
      ...plan,
      chunks: [
        plan.chunks[0],
        { ...plan.chunks[1], chunkObjectId: `${PREFIX}_substituted_chunk` },
      ],
    } as RecoveryArchiveRestorePlan

    await expect(acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan: tamperedPlan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: await databaseFuture(60_000),
      recheckAuthority: async () => true,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID',
    ))
    await expect(acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: '2100-01-01T00:00:00.000Z',
      recheckAuthority: async () => true,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT',
    ))
    const rejectedResidue = await q(
      `SELECT
         (SELECT count(*)::int FROM public.meta_recovery_archive_jobs WHERE sheet_id=$1) AS jobs,
         (SELECT count(*)::int FROM public.meta_recovery_token_burns WHERE sheet_id=$1) AS burns`,
      [fixture.sheetId],
    )
    expect(rejectedResidue.rows[0]).toEqual({ jobs: 0, burns: 0 })

    const directJobId = randomUUID()
    await expect(transaction(async (query) => {
      const prepared = await prepareArchiveWriterBlockTransaction(query, fixture.sheetId)
      const block = await claimArchiveWriterBlockPrepared(prepared, {
        ownerKind: 'restore_job',
        ownerId: directJobId,
        leaseUntil: '2100-01-01T00:00:00.000Z',
      })
      await query(
        `INSERT INTO public.meta_recovery_archive_jobs (
           id, workspace_id, base_id, sheet_id, actor_id, token_sha256,
           recovery_mode, scope_kind, scope_hash,
           archive_generation_id, archive_root_hash, source_vector_hash, key_id,
           plan_hash, plan_object_id, plan_object_version, plan_object_sha256,
           plan_object_size, plan_object_expires_at,
           total_count, block_fence, resume_deadline
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10::uuid, $11, $12, $13,
           $14, $15, $16, $17,
           $18::bigint, $19::timestamptz,
           $20::bigint, $21::bigint, '2100-01-01T00:00:00.000Z'::timestamptz
         )`,
        [
          directJobId,
          plan.workspaceId,
          plan.baseId,
          plan.sheetId,
          plan.actorId,
          sha(`${token}|direct_db_insert`),
          plan.recoveryMode,
          plan.scopeKind,
          plan.scopeHash,
          plan.archiveGenerationId,
          plan.archiveRootHash,
          plan.sourceVectorHash,
          plan.keyId,
          plan.planHash,
          plan.planObjectId,
          plan.planObjectVersion,
          plan.planObjectSha256,
          plan.planObjectSize,
          plan.planObjectExpiresAt,
          plan.totalCount,
          block.fence,
        ],
      )
    })).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_job_archive_binding_invalid',
    })

    const accepted = await acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: await databaseFuture(60_000),
      recheckAuthority: async () => true,
    })
    const candidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    expect(candidate?.jobId).toBe(accepted.id)
    await expect(claimRecoveryArchiveRestoreJob(transaction, candidate!, {
      workerOwnerId: `${PREFIX}_expired_worker`,
      leaseUntil: await databaseFuture(-1_000),
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE',
    ))
    const unclaimed = await q(
      `SELECT state, worker_fence::text AS worker_fence, lease_until
         FROM public.meta_recovery_archive_jobs WHERE id=$1::uuid`,
      [accepted.id],
    )
    expect(unclaimed.rows[0]).toEqual({ state: 'planned', worker_fence: '0', lease_until: null })
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'
    try {
      await cancelRecoveryArchiveRestoreJob(transaction, {
        workspaceId: fixture.workspaceId,
        baseId: fixture.baseId,
        sheetId: fixture.sheetId,
        actorId: fixture.actorId,
        jobId: accepted.id,
        replayHorizonMs: 0,
        recheckAuthority: async () => true,
      })
    } finally {
      process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
      process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    }
  })

  test('keeps sync receipts immutable and permits burn pruning only through CAS authority', async () => {
    const fixture = await seedVerifiedArchive('sync_receipt')
    const operationId = randomUUID()
    const tokenSha256 = sha(`${fixture.sheetId}|sync_token`)
    const tokenExpiresAt = await databaseFuture(500)
    const retainUntil = await databaseFuture(1_000)
    await transaction(async (query) => {
      const endpointSeq = await applyChunk(query, {
        sheetId: fixture.sheetId,
        actorId: fixture.actorId,
        operationId,
        chunkIndex: 0,
      })
      await sealDirectEventOperation(query, {
        sheetId: fixture.sheetId,
        operationId,
        endpointSeq,
        eventCount: 1,
        operationKind: 'ordinary',
      })
      await query(
        `INSERT INTO public.meta_recovery_token_burns (
           token_sha256, sheet_id, actor_id, burn_kind, sync_operation_id,
           archive_generation_id, archive_root_hash, source_vector_hash,
           token_expires_at, retain_until, terminal_at, row_version
         ) VALUES (
           $1, $2, $3, 'sync', $4::uuid,
           $5::uuid, $6, $7,
           $8::timestamptz,
           $9::timestamptz,
           clock_timestamp(), 1
         )`,
        [
          tokenSha256,
          fixture.sheetId,
          fixture.actorId,
          operationId,
          fixture.generationId,
          fixture.rootHash,
          fixture.sourceVectorHash,
          tokenExpiresAt,
          retainUntil,
        ],
      )
      await query(
        `INSERT INTO public.meta_recovery_archive_sync_receipts (
           token_sha256, sheet_id, operation_id, archive_generation_id,
           archive_root_hash, source_vector_hash, plan_hash, applied_count
         ) VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, 1)`,
        [
          tokenSha256,
          fixture.sheetId,
          operationId,
          fixture.generationId,
          fixture.rootHash,
          fixture.sourceVectorHash,
          sha(`${fixture.sheetId}|sync_plan`),
        ],
      )
    })

    await expect(q(
      `UPDATE public.meta_recovery_archive_sync_receipts
          SET applied_count=2 WHERE token_sha256=$1`,
      [tokenSha256],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_sync_receipt_immutable',
    })
    await expect(q(
      `DELETE FROM public.meta_recovery_archive_sync_receipts WHERE token_sha256=$1`,
      [tokenSha256],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_sync_receipt_immutable',
    })
    await expect(q(
      `DELETE FROM public.meta_recovery_token_burns WHERE token_sha256=$1`,
      [tokenSha256],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_token_burn_delete_not_authorized',
    })
    await waitUntil(retainUntil)
    await expect(q(
      `DELETE FROM public.meta_recovery_token_burns WHERE token_sha256=$1`,
      [tokenSha256],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_token_burn_delete_not_authorized',
    })
    expect(await pruneEligibleRecoveryTokenBurns(transaction)).toBe(1)
    const pruned = await q(
      `SELECT
         (SELECT count(*)::int FROM public.meta_recovery_token_burns WHERE token_sha256=$1) AS burns,
         (SELECT count(*)::int FROM public.meta_recovery_archive_sync_receipts WHERE token_sha256=$1) AS receipts`,
      [tokenSha256],
    )
    expect(pruned.rows[0]).toEqual({ burns: 0, receipts: 1 })
  })

  test('rolls back a denied accept, then pauses, fences a stale worker, and abandons partial work', async () => {
    const fixture = await seedVerifiedArchive('resume')
    const plan = compilePlan(fixture)
    const token = mintToken(fixture, plan)
    await preparePlan(fixture, plan, token)

    await expect(acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: future(60_000),
      recheckAuthority: async () => false,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED',
    ))
    const deniedResidue = await q(
      `SELECT
         (SELECT count(*)::int FROM public.meta_recovery_archive_jobs WHERE sheet_id=$1) AS jobs,
         (SELECT count(*)::int FROM public.meta_recovery_token_burns WHERE sheet_id=$1) AS burns,
         (SELECT recovery_writer_state FROM public.meta_sheets WHERE id=$1) AS block`,
      [fixture.sheetId],
    )
    expect(deniedResidue.rows[0]).toEqual({ jobs: 0, burns: 0, block: null })

    const accepted = await acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline: future(60_000),
      recheckAuthority: async () => true,
    })
    const firstCandidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    expect(firstCandidate?.jobId).toBe(accepted.id)
    const firstClaim = await claimRecoveryArchiveRestoreJob(transaction, firstCandidate!, {
      workerOwnerId: `${PREFIX}_worker_first`,
      leaseUntil: future(45_000),
    })

    await expect(runRecoveryArchiveRestoreChunk(transaction, firstClaim, {
      read: q,
      materialize: async () => {
        expect(transactionDepth).toBe(0)
        throw new Error('fixture_object_read_failed')
      },
      recheckAuthority: async () => true,
      apply: async () => {
        throw new Error('unreachable_apply')
      },
    })).rejects.toThrow('fixture_object_read_failed')
    await expect(runRecoveryArchiveRestoreChunk(transaction, firstClaim, {
      read: q,
      materialize: async (expected) => ({ ...expected, payload: null }),
      recheckAuthority: async () => true,
      apply: async (query, context) => {
        await applyChunk(query, context)
        throw new Error('fixture_apply_failed')
      },
    })).rejects.toThrow('fixture_apply_failed')
    const failedAttemptResidue = await q(
      `SELECT job.completed_count::text,
              (SELECT count(*)::int
                 FROM public.meta_recovery_archive_job_chunks chunk_row
                WHERE chunk_row.job_id=job.id AND chunk_row.state='committed') AS committed_chunks,
              (SELECT count(*)::int
                 FROM public.meta_record_revisions revision_row
                WHERE revision_row.sheet_id=job.sheet_id AND revision_row.source='restore') AS restore_events
         FROM public.meta_recovery_archive_jobs job
        WHERE job.id=$1::uuid`,
      [accepted.id],
    )
    expect(failedAttemptResidue.rows[0]).toEqual({
      completed_count: '0',
      committed_chunks: 0,
      restore_events: 0,
    })
    await runOneChunk(firstClaim, [])
    const paused = await pauseRecoveryArchiveRestoreJob(transaction, firstClaim)
    expect(paused.state).toBe('paused_retryable')
    await expect(runOneChunk(firstClaim, [])).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST',
    ))

    expect(await selectRecoveryArchiveRestoreJobCandidate(transaction)).toBeNull()
    await expect(q(
      `UPDATE public.meta_recovery_archive_jobs
          SET state='applying', worker_owner_id=$2, worker_fence=worker_fence+1,
              lease_until=$3::timestamptz, row_version=row_version+1
        WHERE id=$1::uuid`,
      [accepted.id, `${PREFIX}_bypass_worker`, future(30_000)],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_archive_job_transition_invalid',
    })
    let mismatchAuthorityCalled = false
    await expect(resumeRecoveryArchiveRestoreJob(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: `${fixture.actorId}_foreign`,
      jobId: accepted.id,
      recheckAuthority: async () => {
        mismatchAuthorityCalled = true
        return true
      },
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND',
    ))
    expect(mismatchAuthorityCalled).toBe(false)
    await expect(resumeRecoveryArchiveRestoreJob(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
      jobId: accepted.id,
      recheckAuthority: async () => false,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED',
    ))
    const beforeResume = await q(
      `SELECT state, plan_hash, resume_deadline::text AS resume_deadline,
              worker_fence::text AS worker_fence, row_version::text AS row_version
         FROM public.meta_recovery_archive_jobs WHERE id=$1::uuid`,
      [accepted.id],
    )
    expect(beforeResume.rows[0]).toMatchObject({ state: 'paused_retryable', worker_fence: '1' })
    const resumed = await resumeRecoveryArchiveRestoreJob(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
      jobId: accepted.id,
      recheckAuthority: async () => true,
    })
    expect(resumed).toMatchObject({
      state: 'planned',
      resumeDeadline: paused.resumeDeadline,
      workerFence: paused.workerFence,
    })
    const afterResume = await q(
      `SELECT state, plan_hash, resume_deadline::text AS resume_deadline,
              worker_fence::text AS worker_fence, row_version::text AS row_version
         FROM public.meta_recovery_archive_jobs WHERE id=$1::uuid`,
      [accepted.id],
    )
    expect(afterResume.rows[0]).toEqual({
      ...(beforeResume.rows[0] as Record<string, unknown>),
      state: 'planned',
      row_version: (BigInt(String((beforeResume.rows[0] as Record<string, unknown>).row_version)) + 1n)
        .toString(),
    })

    const secondCandidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    expect(secondCandidate?.jobId).toBe(accepted.id)
    const secondClaim = await claimRecoveryArchiveRestoreJob(transaction, secondCandidate!, {
      workerOwnerId: `${PREFIX}_worker_second`,
      leaseUntil: future(45_000),
    })
    expect(secondClaim.workerFence).toBe('2')
    const terminal = await abandonRecoveryArchiveRestoreJob(transaction, secondClaim, {
      replayHorizonMs: 0,
    })
    expect(terminal).toMatchObject({ state: 'abandoned_partial', completedCount: '5000' })
    const block = await q(
      `SELECT recovery_writer_state FROM public.meta_sheets WHERE id=$1`,
      [fixture.sheetId],
    )
    expect(block.rows[0]).toEqual({ recovery_writer_state: null })
  })

  test('refuses archive expiry with live jobs and sweeps expired zero-write and partial jobs', async () => {
    const partialFixture = await seedVerifiedArchive('sweep_partial')
    const partialPlan = compilePlan(partialFixture)
    const partialDeadline = await databaseFuture(2_500)
    const partialToken = mintToken(partialFixture, partialPlan)
    await preparePlan(partialFixture, partialPlan, partialToken)
    const partial = await acceptRecoveryArchiveRestoreJob(transaction, {
      token: partialToken,
      plan: partialPlan,
      identity: restoreRequestIdentity(partialFixture),
      resumeDeadline: partialDeadline,
      recheckAuthority: async () => true,
    })
    const partialCandidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    expect(partialCandidate?.jobId).toBe(partial.id)
    const partialClaim = await claimRecoveryArchiveRestoreJob(transaction, partialCandidate!, {
      workerOwnerId: `${PREFIX}_sweep_worker`,
      leaseUntil: await databaseFuture(2_000),
    })
    await runOneChunk(partialClaim, [])

    const archiveExpiry = await databaseFuture(4_000)
    const zeroFixture = await seedVerifiedArchive('sweep_zero', archiveExpiry)
    const zeroPlan = compilePlan(zeroFixture, new Date(archiveExpiry).toISOString())
    const zeroToken = mintToken(zeroFixture, zeroPlan, '1s')
    await preparePlan(zeroFixture, zeroPlan, zeroToken)
    const zero = await acceptRecoveryArchiveRestoreJob(transaction, {
      token: zeroToken,
      plan: zeroPlan,
      identity: restoreRequestIdentity(zeroFixture),
      resumeDeadline: await databaseFuture(2_500),
      recheckAuthority: async () => true,
    })

    await waitUntil(archiveExpiry)
    await expect(transaction((query) => expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: zeroFixture.workspaceId,
      baseId: zeroFixture.baseId,
      sheetId: zeroFixture.sheetId,
      generationId: zeroFixture.generationId,
    }))).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED' })

    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'
    try {
      expect(await sweepExpiredRecoveryArchiveRestoreJobs(transaction, {
        replayHorizonMs: 0,
        limit: 10,
      })).toBe(2)
    } finally {
      process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
      process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    }
    const swept = await q(
      `SELECT job.id::text AS id, job.state, job.completed_count::text,
              burn.terminal_at IS NOT NULL AS burn_terminal,
              sheet.recovery_writer_state
         FROM public.meta_recovery_archive_jobs job
         JOIN public.meta_recovery_token_burns burn ON burn.job_id=job.id
         JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
        WHERE job.id=ANY($1::uuid[])
        ORDER BY job.id`,
      [[partial.id, zero.id]],
    )
    expect(swept.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: partial.id,
        state: 'abandoned_partial',
        completed_count: '5000',
        burn_terminal: true,
        recovery_writer_state: null,
      }),
      expect.objectContaining({
        id: zero.id,
        state: 'cancelled_zero_write',
        completed_count: '0',
        burn_terminal: true,
        recovery_writer_state: null,
      }),
    ]))
    expect(await pruneEligibleRecoveryTokenBurns(transaction)).toBe(1)
  })

  test('keeps legacy and held burns, then prunes only a terminal provenance-complete burn', async () => {
    const fixture = await seedVerifiedArchive('prune')
    const plan = compilePlan(fixture)
    const token = mintToken(fixture, plan, '1s')
    const resumeDeadline = future(1_500)
    await preparePlan(fixture, plan, token)
    const accepted = await acceptRecoveryArchiveRestoreJob(transaction, {
      token,
      plan,
      identity: restoreRequestIdentity(fixture),
      resumeDeadline,
      recheckAuthority: async () => true,
    })
    await cancelRecoveryArchiveRestoreJob(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
      jobId: accepted.id,
      replayHorizonMs: 0,
      recheckAuthority: async () => true,
    })

    const legacyToken = sha(`${fixture.sheetId}|legacy`)
    await q(
      `INSERT INTO public.meta_recovery_token_burns (token_sha256, sheet_id, actor_id, burned_at)
       VALUES ($1, $2, $3, '2000-01-01T00:00:00.000Z'::timestamptz)`,
      [legacyToken, fixture.sheetId, fixture.actorId],
    )
    await waitUntil(resumeDeadline)
    const holdId = randomUUID()
    let markGenerationLocked!: () => void
    const generationLocked = new Promise<void>((resolve) => {
      markGenerationLocked = resolve
    })
    let continueHold!: () => void
    const holdMayContinue = new Promise<void>((resolve) => {
      continueHold = resolve
    })
    const holdPromise = withClientTransaction(async (client) => placeRecoveryArchiveLegalHold(
      async (text, values) => {
        const result = await client.query(text, values)
        if (text === RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL) {
          markGenerationLocked()
          await holdMayContinue
        }
        return result as QueryResult
      },
      {
        holdId,
        workspaceId: fixture.workspaceId,
        baseId: fixture.baseId,
        sheetId: fixture.sheetId,
        generationId: fixture.generationId,
        reasonCode: 'TEST_HOLD',
        placedByActorId: fixture.actorId,
      },
    ))
    await generationLocked
    const pruneApplication = `${PREFIX}_prune_race`
    const blockedPrune = pruneEligibleRecoveryTokenBurns(
      transactionWithApplicationName(pruneApplication),
    )
    await waitForBlockedApplication(pruneApplication)
    continueHold()
    await holdPromise
    expect(await blockedPrune).toBe(0)
    await expect(q(
      `DELETE FROM public.meta_recovery_token_burns WHERE token_sha256=$1`,
      [sha(token)],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_token_burn_delete_not_authorized',
    })
    await transaction((query) => releaseRecoveryArchiveLegalHold(query, {
      holdId,
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      generationId: fixture.generationId,
      expectedRowVersion: '1',
      releasedByActorId: fixture.actorId,
    }))
    await expect(q(
      `DELETE FROM public.meta_recovery_token_burns WHERE token_sha256=$1`,
      [sha(token)],
    )).rejects.toMatchObject({
      code: '55000',
      message: 'recovery_token_burn_delete_not_authorized',
    })
    expect(await pruneEligibleRecoveryTokenBurns(transaction)).toBe(1)

    const remaining = await q(
      `SELECT token_sha256, burn_kind
         FROM public.meta_recovery_token_burns
        WHERE sheet_id=$1
        ORDER BY token_sha256`,
      [fixture.sheetId],
    )
    expect(remaining.rows).toEqual([{ token_sha256: legacyToken, burn_kind: null }])

    let statusMismatchAuthorityCalled = false
    await expect(readRecoveryArchiveRestoreJobStatus(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: `${fixture.actorId}_foreign`,
      jobId: accepted.id,
      recheckAuthority: async () => {
        statusMismatchAuthorityCalled = true
        return true
      },
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND',
    ))
    expect(statusMismatchAuthorityCalled).toBe(false)
    await expect(readRecoveryArchiveRestoreJobStatus(transaction, {
      workspaceId: fixture.workspaceId,
      baseId: fixture.baseId,
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
      jobId: accepted.id,
      recheckAuthority: async () => false,
    })).rejects.toEqual(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED',
    ))
  })
})
