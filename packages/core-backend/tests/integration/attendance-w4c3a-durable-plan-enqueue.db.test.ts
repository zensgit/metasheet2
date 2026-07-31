import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import {
  type LegacyImportGroupEffectDraftV1,
  type LegacyImportItemDraftV1,
  type LegacyImportRecordWriteDraftV1,
} from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import { reserveAttendanceLegacyImportPlanJobV1 } from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
  computeLegacyImportAsyncJobSummaryDigestV1,
  type LegacyImportAsyncJobSummaryV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'
import {
  attendanceResultOperationPreflightV1,
  sealAttendanceResultOperationBatchV1,
  sealAttendanceResultOperationV1,
} from '../../src/attendance/w4c0-operation-registry'
import { normalizeAttendanceSourceOperationEnvelopeV1 } from '../../src/attendance/w4c0-source-commands'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceImportReservationLocksV1,
  buildAttendanceCalculationRolloutAdvisoryKey,
  buildAttendanceLegacyIdempotencyAdvisoryKey,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  buildAttendanceOperationalBulkTargetAdvisoryKey,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { createAttendanceLegacyPlanWorkerV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import {
  createAttendanceLegacyPlanWorkerRepositoryV1,
  type AttendanceLegacyPlanWorkerRepositoryJobV1,
} from '../../src/attendance/w4c3a-legacy-plan-worker-repository'
import { rawImportEvidenceV1 } from '../utils/attendance-w4c3a-raw-evidence'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const require = createRequire(import.meta.url)
const syncCompatibility = (
  require('../../../../plugins/plugin-attendance/index.cjs') as {
    __attendanceW4C3aSyncCompatibilityForTests: {
      acquireAttendanceSyncImportReservationLocks(
        client: {
          query(
            text: string,
            values?: unknown[],
          ): Promise<unknown>
        },
        input: {
          orgId: string
          idempotencyKey: string
          witness: {
            rolloutKey: string
            legacyIdempotencyKey: string
            helperWaitMs: number
            transactionLockTimeoutMs: number
          }
        },
      ): Promise<void>
      loadAttendanceV1ImportReservationForSync(
        client: {
          query(
            text: string,
            values?: unknown[],
          ): Promise<unknown>
        },
        orgId: string,
        idempotencyKey: string,
      ): Promise<{ kind: 'in_progress' | 'conflict' } | null>
      assertAttendanceV1ImportReservationAllowsSync(
        reservation: { kind: 'in_progress' | 'conflict' } | null,
      ): void
      runAttendanceSyncImportSerializableTransaction<T>(
        db: {
          transaction(
            run: (trx: {
              query(text: string, values?: unknown[]): Promise<unknown>
            }) => Promise<T>,
          ): Promise<T>
        },
        runAttempt: (
          trx: { query(text: string, values?: unknown[]): Promise<unknown> },
          attempt: number,
        ) => Promise<T>,
      ): Promise<T>
    }
  }
).__attendanceW4C3aSyncCompatibilityForTests
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const ORG = crypto.randomUUID()
const POSTURE_ORG = crypto.randomUUID()
const ROLLOUT_ENQUEUE_FIRST_ORG = crypto.randomUUID()
const ROLLOUT_TRANSITION_FIRST_ORG = crypto.randomUUID()
const SYNC_RACE_ORG = crypto.randomUUID()
const ADMIN_A = `w4c3a-admin-a-${run}`
const ADMIN_B = `w4c3a-admin-b-${run}`
const LEGACY_WILDCARD_ADMIN = `w4c3a-legacy-wildcard-${run}`
const ROLE_WILDCARD_ADMIN = `w4c3a-role-wildcard-${run}`
const TARGET_USER = crypto.randomUUID()
const SECOND_TARGET_USER = crypto.randomUUID()
const SOURCE_REF = `w4c3a-source-${run}`
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)

function terminalResponse(
  idempotencyKey: string | null,
): LegacyImportAsyncJobSummaryV1 {
  return {
    __jobType: 'commit',
    idempotencyKey,
    __importEngine: 'standard',
    recordUpsertStrategy: 'unnest',
    itemsInsertStrategy: 'unnest',
    summary: {
      processedRows: 2,
      failedRows: 0,
      elapsedMs: 10,
      chunkConfig: { size: 500 },
    },
  }
}

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return String((error as Error).message)
}

function ignoreForcedScratchDrop(error: Error): void {
  if (errorCode(error) !== '57P01') throw error
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
      activation_status text NOT NULL DEFAULT 'activated',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE user_orgs (
      user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    )`)
  await pool.query(`
    CREATE TABLE user_permissions (
      user_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE user_roles (
      user_id text NOT NULL, role_id text NOT NULL, PRIMARY KEY (user_id, role_id)
    )`)
  await pool.query(`
    CREATE TABLE role_permissions (
      role_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (role_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE user_namespace_admissions (
      user_id text NOT NULL, namespace text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      PRIMARY KEY (user_id, namespace)
    )`)
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean,
      meta jsonb, source_batch_id uuid, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, idempotency_key text,
      status text NOT NULL, row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      record_id uuid
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL,
      code text, timezone text NOT NULL DEFAULT 'UTC', rule_set_id text
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL,
      group_id uuid NOT NULL, user_id text NOT NULL
    )`)
}

function normalBatch(idempotencyKey: string | null, sourceRowCount: number) {
  return {
    kind: 'normal' as const,
    source: 'manual',
    ruleSetId: null,
    mappingSnapshot: {},
    sourceRowCount,
    status: 'committed',
    idempotencyKey,
    visibilityRule: 'org',
    engine: 'standard',
    chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
    recordUpsertStrategy: 'unnest',
    itemsInsertStrategy: 'unnest',
    mappingProfileId: null,
    compatibilityMetadata: {},
    groupSync: null,
    itemReturnPolicy: { returnItems: false, itemsLimit: null },
    skippedSamplePolicy: { limit: 50 },
    resultSlots: {
      groupCreated: 'ensure_group_returned_row_count',
      groupMembersAdded: 'ensure_member_inserted_row_count',
    },
  }
}

async function loadOrgWitness(pool: Pool, orgId: string): Promise<VerifiedAttendanceOrgIdentityV1> {
  const posture = await resolveSegmentCalculationPosture(trx(pool as unknown as PoolClient), orgId)
  return createVerifiedAttendanceOrgIdentityV1({ orgKey: orgId, posture })
}

function auth(actorId: string, orgId: string) {
  return createAuthorizedAttendanceWriteContextV1({
    actorId,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: actorId,
    orgId,
    subjectScope: { kind: 'self', userId: actorId },
    capability: 'import',
    sourceRef: SOURCE_REF,
  })
}

function importBatchEnvelope(orgId: string, batchId: string) {
  return normalizeAttendanceSourceOperationEnvelopeV1({
    schemaVersion: 1,
    orgId,
    correlationId: `w4c3a-race-${run}`,
    command: null,
    batch: {
      schemaVersion: 1,
      kind: 'import_batch',
      payload: {
        batchCommandId: batchId,
        transportKind: 'csv_upload',
        batchFingerprint: HEX_A,
      },
      items: [
        {
          ordinal: 0,
          subjectUserId: TARGET_USER,
          semanticFingerprint: HEX_C,
          normalizedBusinessInput: {
            workDate: '2026-07-30',
            workMinutes: 480,
          },
        },
      ],
    },
  })
}

function noTargetInput(
  org: VerifiedAttendanceOrgIdentityV1,
  batchId: string,
  actorId: string,
  createdBy: string,
  idempotencyKey: string | null = null,
  commandFingerprint = HEX_A,
  legacyInputFingerprint = HEX_B,
) {
  const items: readonly LegacyImportItemDraftV1[] = [
    {
      kind: 'skip', ordinal: 0, semanticOrdinal: null, resolvedUserId: null,
      resolvedWorkDate: null, reasonCode: 'validation', warnings: [], previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(0),
    },
    {
      kind: 'skip', ordinal: 1, semanticOrdinal: null, resolvedUserId: null,
      resolvedWorkDate: null, reasonCode: 'duplicate', warnings: [], previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(1),
    },
  ]
  const batch = normalBatch(idempotencyKey, items.length)
  const identity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'batch', entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const input = {
    batchIdentity: identity,
    itemIdentities: [],
    job: {
      orgId: org.orgId, batchId, createdBy, idempotencyKey, total: items.length,
      payload: {
        __jobType: 'commit', idempotencyKey, __importEngine: 'standard',
        recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1,
      },
      w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId,
      w4SourceKind: 'import_batch' as const, w4SourceRef: SOURCE_REF,
      w4ActorId: actorId, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: actorId,
      w4CommandFingerprint: commandFingerprint, w4AcceptedWritePosture: org.acceptedWritePosture,
      w4ItemCount: 0, w4ItemSequenceFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1, w4IdentityProofVector: [],
      w4DistinctTargetCount: 0, w4OperationalBranch: 'operational_only_no_target' as const,
      w4LegacyInputFingerprint: legacyInputFingerprint,
    },
    manifestSeed: {
      schemaVersion: 1 as const,
      orgId: org.orgId, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF,
      createdBy, actorId, actorPosture: 'platform_admin', tokenSubjectUserId: actorId,
      acceptedWritePosture: org.acceptedWritePosture, commandFingerprint, legacyInputFingerprint,
      operationalBranch: 'operational_only_no_target' as const, legacyRowSourceKind: 'direct_rows' as const,
      sourceRowCount: items.length, w4ItemCount: 0, w4DistinctTargetCount: 0,
      w4ItemSequenceFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1, legacySourceRowLimit: null,
      batch, artifactCleanup: { kind: 'none' as const },
    },
    items, recordWrites: [], groupEffects: [],
  }
  return { input, identity }
}

function strictInput(org: VerifiedAttendanceOrgIdentityV1, batchId: string, actorId: string) {
  const semanticFingerprint = HEX_C
  const commandFingerprint = HEX_D
  const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'batch', entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const itemIdentity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'item', entrypoint: 'import_batch',
    source: { sourceKind: 'import_item', batchCommandId: batchId, ordinal: 0, semanticFingerprint },
  })
  const fingerprints = [{ ordinal: '0', operationId: itemIdentity.id, commandFingerprint }]
  const recordWrite: LegacyImportRecordWriteDraftV1 = {
    orgId: org.orgId, userId: TARGET_USER, workDate: '2026-07-30', sourceOrdinals: [0],
    mergeMode: 'merge', firstInAt: '2026-07-30T01:00:00.000Z', lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal', isWorkday: true,
    timezone: 'Asia/Shanghai',
    compatibilityMetadata: {}, policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {},
    attributionSnapshot: {}, sourceBatchId: batchId, resultSlots: {},
  }
  const item: LegacyImportItemDraftV1 = {
    kind: 'apply', ordinal: 0, semanticOrdinal: 0,
    targetRef: JSON.stringify([org.orgId, TARGET_USER, '2026-07-30']),
    previewSnapshot: { status: 'normal' },
    rawEvidence: rawImportEvidenceV1(0, {
      userId: TARGET_USER,
      workDate: '2026-07-30',
      timezone: 'Asia/Shanghai',
      firstInAt: '2026-07-30T01:00:00.000Z',
      lastOutAt: '2026-07-30T09:00:00.000Z',
      status: 'normal',
      isWorkday: true,
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    }),
  }
  const batch = normalBatch(null, 1)
  const proofVector = [{ ordinal: 0, semanticFingerprint, derivedOperationId: itemIdentity.id, commandFingerprint }]
  const input = {
    batchIdentity, itemIdentities: [{ identity: itemIdentity, commandFingerprint }],
    job: {
      orgId: org.orgId, batchId, createdBy: actorId, idempotencyKey: null, total: 1,
      payload: { __jobType: 'commit', idempotencyKey: null, __importEngine: 'standard', recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1 },
      w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId, w4SourceKind: 'import_batch' as const,
      w4SourceRef: SOURCE_REF, w4ActorId: actorId, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: actorId,
      w4CommandFingerprint: commandFingerprint, w4AcceptedWritePosture: org.acceptedWritePosture,
      w4ItemCount: 1, w4ItemSequenceFingerprint: computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints), w4IdentityProofVector: proofVector,
      w4DistinctTargetCount: 1, w4OperationalBranch: 'strict_targeted' as const, w4LegacyInputFingerprint: HEX_A,
    },
    manifestSeed: {
      schemaVersion: 1 as const,
      orgId: org.orgId, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF, createdBy: actorId,
      actorId, actorPosture: 'platform_admin', tokenSubjectUserId: actorId, acceptedWritePosture: org.acceptedWritePosture,
      commandFingerprint, legacyInputFingerprint: HEX_A, operationalBranch: 'strict_targeted' as const,
      legacyRowSourceKind: 'direct_rows' as const, sourceRowCount: 1, w4ItemCount: 1, w4DistinctTargetCount: 1,
      w4ItemSequenceFingerprint: computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints), legacySourceRowLimit: null,
      batch, artifactCleanup: { kind: 'none' as const },
    },
    items: [item], recordWrites: [recordWrite], groupEffects: [],
  }
  return { input, batchIdentity }
}

function strictTwoItemInput(
  org: VerifiedAttendanceOrgIdentityV1,
  batchId: string,
  actorId: string,
) {
  const itemDrafts = [
    {
      userId: TARGET_USER,
      workDate: '2026-07-30',
      semanticFingerprint: HEX_B,
      commandFingerprint: HEX_C,
    },
    {
      userId: SECOND_TARGET_USER,
      workDate: '2026-07-31',
      semanticFingerprint: HEX_C,
      commandFingerprint: HEX_D,
    },
  ] as const
  const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const itemIdentities = itemDrafts.map((draft, ordinal) => ({
    identity: createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'import_batch',
      source: {
        sourceKind: 'import_item',
        batchCommandId: batchId,
        ordinal,
        semanticFingerprint: draft.semanticFingerprint,
      },
    }),
    commandFingerprint: draft.commandFingerprint,
  }))
  const fingerprintEntries = itemIdentities.map((item, ordinal) => ({
    ordinal: String(ordinal),
    operationId: item.identity.id,
    commandFingerprint: item.commandFingerprint,
  }))
  const proofVector = itemIdentities.map((item, ordinal) => ({
    ordinal,
    semanticFingerprint: itemDrafts[ordinal].semanticFingerprint,
    derivedOperationId: item.identity.id,
    commandFingerprint: item.commandFingerprint,
  }))
  const items: readonly LegacyImportItemDraftV1[] = itemDrafts.map(
    (draft, ordinal) => ({
      kind: 'apply',
      ordinal,
      semanticOrdinal: ordinal,
      targetRef: JSON.stringify([org.orgId, draft.userId, draft.workDate]),
      previewSnapshot: { status: 'normal' },
      rawEvidence: rawImportEvidenceV1(ordinal, {
        userId: draft.userId,
        workDate: draft.workDate,
        timezone: 'Asia/Shanghai',
        firstInAt: `${draft.workDate}T01:00:00.000Z`,
        lastOutAt: `${draft.workDate}T09:00:00.000Z`,
        status: 'normal',
        isWorkday: true,
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
      }),
    }),
  )
  const recordWrites: readonly LegacyImportRecordWriteDraftV1[] =
    itemDrafts.map((draft, ordinal) => ({
      orgId: org.orgId,
      userId: draft.userId,
      workDate: draft.workDate,
      sourceOrdinals: [ordinal],
      mergeMode: 'merge',
      firstInAt: `${draft.workDate}T01:00:00.000Z`,
      lastOutAt: `${draft.workDate}T09:00:00.000Z`,
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
      isWorkday: true,
      timezone: 'Asia/Shanghai',
      compatibilityMetadata: {},
      policySnapshot: {},
      profileSnapshot: {},
      multiPunchSnapshot: {},
      attributionSnapshot: {},
      sourceBatchId: batchId,
      resultSlots: {},
    }))
  const sequenceFingerprint =
    computeAttendanceItemSequenceFingerprintV1(fingerprintEntries)
  const setFingerprint =
    computeAttendanceItemSetFingerprintV1(fingerprintEntries)
  const batch = normalBatch(null, itemDrafts.length)

  return {
    input: {
      batchIdentity,
      itemIdentities,
      job: {
        orgId: org.orgId,
        batchId,
        createdBy: actorId,
        idempotencyKey: null,
        total: itemDrafts.length,
        payload: {
          __jobType: 'commit',
          idempotencyKey: null,
          __importEngine: 'standard',
          recordUpsertStrategy: 'unnest',
          itemsInsertStrategy: 'unnest',
          __w4ContractVersion: 1,
        },
        w4Entrypoint: 'import_batch' as const,
        w4BatchCommandId: batchId,
        w4SourceKind: 'import_batch' as const,
        w4SourceRef: SOURCE_REF,
        w4ActorId: actorId,
        w4ActorPosture: 'platform_admin',
        w4TokenSubjectUserId: actorId,
        w4CommandFingerprint: HEX_A,
        w4AcceptedWritePosture: org.acceptedWritePosture,
        w4ItemCount: itemDrafts.length,
        w4ItemSequenceFingerprint: sequenceFingerprint,
        w4ItemSetFingerprint: setFingerprint,
        w4IdentityProofVector: proofVector,
        w4DistinctTargetCount: itemDrafts.length,
        w4OperationalBranch: 'strict_targeted' as const,
        w4LegacyInputFingerprint: HEX_B,
      },
      manifestSeed: {
        schemaVersion: 1 as const,
        orgId: org.orgId,
        batchId,
        sourceKind: 'import_batch' as const,
        sourceRef: SOURCE_REF,
        createdBy: actorId,
        actorId,
        actorPosture: 'platform_admin',
        tokenSubjectUserId: actorId,
        acceptedWritePosture: org.acceptedWritePosture,
        commandFingerprint: HEX_A,
        legacyInputFingerprint: HEX_B,
        operationalBranch: 'strict_targeted' as const,
        legacyRowSourceKind: 'direct_rows' as const,
        sourceRowCount: itemDrafts.length,
        w4ItemCount: itemDrafts.length,
        w4DistinctTargetCount: itemDrafts.length,
        w4ItemSequenceFingerprint: sequenceFingerprint,
        w4ItemSetFingerprint: setFingerprint,
        legacySourceRowLimit: null,
        batch,
        artifactCleanup: { kind: 'none' as const },
      },
      items,
      recordWrites,
      groupEffects: [],
    },
    proofVector,
  }
}

async function runSerializable<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query('SELECT pg_backend_pid() AS pid')
  return Number(result.rows[0].pid)
}

async function waitUntilAdvisoryBlocked(
  pool: Pool,
  pid: number,
  timeoutMs = 8000,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    const result = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE pid = $1 AND locktype = 'advisory' AND granted = false`,
      [pid],
    )
    if (Number(result.rows[0].n) > 0) return
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waiter never blocked on an advisory lock')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function residue(pool: Pool, batchId: string): Promise<{ jobs: number; manifests: number; chunks: number }> {
  const jobs = await pool.query('SELECT count(*)::int AS n FROM attendance_import_jobs WHERE batch_id = $1', [batchId])
  const manifests = await pool.query(`
    SELECT count(*)::int AS n FROM attendance_import_legacy_execution_plans p
    WHERE p.batch_id = $1`, [batchId])
  const chunks = await pool.query(`
    SELECT count(*)::int AS n FROM attendance_import_legacy_execution_plan_chunks c
    JOIN attendance_import_legacy_execution_plans p ON p.job_id = c.job_id
    WHERE p.batch_id = $1`, [batchId])
  return { jobs: jobs.rows[0].n, manifests: manifests.rows[0].n, chunks: chunks.rows[0].n }
}

describeIfDatabase('W4C-3a enqueue foundation (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_enqueue_${run}`
  let adminPool: Pool
  let pool: Pool
  let migrationPool: Pool
  let db: Kysely<unknown>
  let legacyOrgWitness: VerifiedAttendanceOrgIdentityV1
  const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    migrationPool = new Pool({ connectionString: scratchUrl.toString() })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    await createBase(pool)
    await w4c0Up(db)
    await w4c3aUp(db)
    await pool.query(
      `INSERT INTO users (id) VALUES ($1), ($2), ($3), ($4), ($5), ($6)`,
      [
        ADMIN_A,
        ADMIN_B,
        LEGACY_WILDCARD_ADMIN,
        ROLE_WILDCARD_ADMIN,
        TARGET_USER,
        SECOND_TARGET_USER,
      ],
    )
    for (const orgId of [
      ORG,
      POSTURE_ORG,
      ROLLOUT_ENQUEUE_FIRST_ORG,
      ROLLOUT_TRANSITION_FIRST_ORG,
      SYNC_RACE_ORG,
    ]) {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id) VALUES
         ($1, $2), ($3, $2), ($4, $2), ($5, $2), ($6, $2), ($7, $2)`,
        [
          ADMIN_A,
          orgId,
          ADMIN_B,
          LEGACY_WILDCARD_ADMIN,
          ROLE_WILDCARD_ADMIN,
          TARGET_USER,
          SECOND_TARGET_USER,
        ],
      )
    }
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES
       ($1, 'attendance:import'), ($2, 'attendance:import')`,
      [ADMIN_A, ADMIN_B],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
       ($1, 'attendance_admin'), ($2, 'attendance_admin'),
       ($3, 'attendance_legacy'), ($4, 'attendance_operator')`,
      [ADMIN_A, ADMIN_B, LEGACY_WILDCARD_ADMIN, ROLE_WILDCARD_ADMIN],
    )
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES
       ('attendance_admin', 'attendance:import'),
       ('attendance_legacy', 'attendance:read'),
       ('attendance_operator', 'attendance:*')`,
    )
    await pool.query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES
       ($1, 'attendance', true),
       ($2, 'attendance', true),
       ($3, 'attendance', true),
       ($4, 'attendance', true)`,
      [ADMIN_A, ADMIN_B, LEGACY_WILDCARD_ADMIN, ROLE_WILDCARD_ADMIN],
    )
    await pool.query(
      `UPDATE users SET permissions = '["attendance:*"]'::jsonb WHERE id = $1`,
      [LEGACY_WILDCARD_ADMIN],
    )
    for (const orgId of [
      ROLLOUT_ENQUEUE_FIRST_ORG,
      ROLLOUT_TRANSITION_FIRST_ORG,
    ]) {
      await pool.query(
        `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'legacy', 'w4c3a-race', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
        [orgId, ADMIN_A],
      )
    }
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [
      POSTURE_ORG,
      ROLLOUT_ENQUEUE_FIRST_ORG,
      ROLLOUT_TRANSITION_FIRST_ORG,
    ].join(',')
    legacyOrgWitness = await loadOrgWitness(pool, ORG)
  }, 90000)

  afterAll(async () => {
    if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
    for (const current of [pool, migrationPool, adminPool]) {
      current?.on('error', ignoreForcedScratchDrop)
    }
    await db?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  it('commits a valid no-target all-skip job, manifest, and chunk atomically', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    const result = await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input),
    )
    expect(result.kind).toBe('created')
    const rows = await pool.query(
      `SELECT j.status, j.total, j.w4_operational_branch, j.w4_item_count,
              p.chunk_count, count(c.job_id)::int AS chunks,
              jsonb_array_length(c.chunk->'items')::int AS source_items
         FROM attendance_import_jobs j
         JOIN attendance_import_legacy_execution_plans p ON p.job_id = j.id
         JOIN attendance_import_legacy_execution_plan_chunks c ON c.job_id = j.id
        WHERE j.batch_id = $1
        GROUP BY j.status, j.total, j.w4_operational_branch, j.w4_item_count, p.chunk_count, c.chunk` ,
      [batchId],
    )
    expect(rows.rows).toEqual([{ status: 'queued', total: 2, w4_operational_branch: 'operational_only_no_target', w4_item_count: 0, chunk_count: 1, chunks: 1, source_items: 2 }])
  })

  it('validates every strict proof-vector predicate and rehydrates every persisted item identity', async () => {
    const batchId = crypto.randomUUID()
    const planned = strictTwoItemInput(
      legacyOrgWitness,
      batchId,
      ADMIN_A,
    )
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ADMIN_A, ORG),
          planned.input,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'created' })

    const persisted = await pool.query(
      `SELECT org_id, w4_batch_command_id::text AS root,
              w4_accepted_write_posture AS posture,
              w4_item_count AS item_count,
              w4_distinct_target_count AS distinct_target_count,
              w4_identity_proof_vector AS vector
         FROM attendance_import_jobs
        WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [ORG, batchId],
    )
    expect(persisted.rows).toHaveLength(1)
    const row = persisted.rows[0] as {
      org_id: string
      root: string
      posture: string
      item_count: number
      distinct_target_count: number
      vector: Array<{
        ordinal: number
        semanticFingerprint: string
        derivedOperationId: string
        commandFingerprint: string
      }>
    }
    expect(row.vector).toEqual(planned.proofVector)

    const validate = async (input: {
      sourceKind?: string | null
      root?: string | null
      vector?: unknown
      itemCount?: number | null
      branch?: string | null
      distinctTargetCount?: number | null
    }): Promise<boolean> => {
      const result = await pool.query(
        `SELECT attendance_w4_job_proof_vector_valid(
           $1, $2::uuid, $3::jsonb, $4, $5, $6
         ) AS valid`,
        [
          'sourceKind' in input ? input.sourceKind : 'import_batch',
          'root' in input ? input.root : row.root,
          JSON.stringify('vector' in input ? input.vector : row.vector),
          'itemCount' in input ? input.itemCount : row.item_count,
          'branch' in input ? input.branch : 'strict_targeted',
          'distinctTargetCount' in input
            ? input.distinctTargetCount
            : row.distinct_target_count,
        ],
      )
      return result.rows[0].valid as boolean
    }
    const first = row.vector[0]
    const second = row.vector[1]
    const withoutOrdinal = { ...first } as Record<string, unknown>
    delete withoutOrdinal.ordinal
    const withExtraKey = { ...first, extra: true }
    const matrix: Array<{
      label: string
      input: Parameters<typeof validate>[0]
      expected: boolean
    }> = [
      { label: 'valid strict vector', input: {}, expected: true },
      {
        label: 'reordered entries',
        input: { vector: [second, first] },
        expected: false,
      },
      {
        label: 'duplicated ordinal',
        input: { vector: [first, { ...second, ordinal: 0 }] },
        expected: false,
      },
      {
        label: 'missing entry',
        input: { vector: [first] },
        expected: false,
      },
      {
        label: 'extra entry',
        input: { vector: [first, second, { ...second, ordinal: 2 }] },
        expected: false,
      },
      {
        label: 'missing exact key',
        input: { vector: [withoutOrdinal, second] },
        expected: false,
      },
      {
        label: 'extra exact key',
        input: { vector: [withExtraKey, second] },
        expected: false,
      },
      {
        label: 'string ordinal',
        input: { vector: [{ ...first, ordinal: '0' }, second] },
        expected: false,
      },
      {
        label: 'non-string semantic fingerprint',
        input: { vector: [{ ...first, semanticFingerprint: 1 }, second] },
        expected: false,
      },
      {
        label: 'non-string derived operation id',
        input: { vector: [{ ...first, derivedOperationId: 1 }, second] },
        expected: false,
      },
      {
        label: 'non-string command fingerprint',
        input: { vector: [{ ...first, commandFingerprint: 1 }, second] },
        expected: false,
      },
      {
        label: 'malformed semantic fingerprint',
        input: {
          vector: [{ ...first, semanticFingerprint: 'g'.repeat(64) }, second],
        },
        expected: false,
      },
      {
        label: 'malformed command fingerprint',
        input: {
          vector: [{ ...first, commandFingerprint: 'g'.repeat(64) }, second],
        },
        expected: false,
      },
      {
        label: 'derived operation drift',
        input: {
          vector: [{ ...first, derivedOperationId: crypto.randomUUID() }, second],
        },
        expected: false,
      },
      {
        label: 'root drift',
        input: { root: crypto.randomUUID() },
        expected: false,
      },
      {
        label: 'namespace drift',
        input: { sourceKind: 'integration_batch' },
        expected: false,
      },
      {
        label: 'unknown source kind',
        input: { sourceKind: 'unknown' },
        expected: false,
      },
      {
        label: 'branch drift',
        input: { branch: 'operational_only_no_target' },
        expected: false,
      },
      {
        label: 'unknown branch',
        input: { branch: 'unknown' },
        expected: false,
      },
      {
        label: 'null source kind',
        input: { sourceKind: null },
        expected: false,
      },
      {
        label: 'null root',
        input: { root: null },
        expected: false,
      },
      {
        label: 'null vector',
        input: { vector: null },
        expected: false,
      },
      {
        label: 'non-array vector',
        input: { vector: {} },
        expected: false,
      },
      {
        label: 'null item count',
        input: { itemCount: null },
        expected: false,
      },
      {
        label: 'zero item count',
        input: { itemCount: 0 },
        expected: false,
      },
      {
        label: 'item count above strict limit',
        input: { itemCount: 5001 },
        expected: false,
      },
      {
        label: 'item-count drift',
        input: { itemCount: 1 },
        expected: false,
      },
      {
        label: 'null distinct-target count',
        input: { distinctTargetCount: null },
        expected: false,
      },
      {
        label: 'zero distinct-target count',
        input: { distinctTargetCount: 0 },
        expected: false,
      },
      {
        label: 'valid folded distinct-target count',
        input: { distinctTargetCount: 1 },
        expected: true,
      },
      {
        label: 'distinct-target count above strict limit',
        input: { distinctTargetCount: 5001 },
        expected: false,
      },
      {
        label: 'distinct-target count above item count',
        input: { distinctTargetCount: 3 },
        expected: false,
      },
    ]
    for (const leg of matrix) {
      await expect(validate(leg.input), leg.label).resolves.toBe(leg.expected)
    }

    const checkBinding = await pool.query(
      `SELECT c.convalidated,
              pg_get_constraintdef(c.oid, true) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'attendance_import_jobs'
          AND c.conname = 'chk_aij_w4_proof_vector'
          AND c.contype = 'c'`,
    )
    expect(checkBinding.rows).toHaveLength(1)
    expect(checkBinding.rows[0].convalidated).toBe(true)
    expect(checkBinding.rows[0].definition).toContain(
      'attendance_w4_job_proof_vector_valid(w4_source_kind, w4_batch_command_id, w4_identity_proof_vector, w4_item_count, w4_operational_branch, w4_distinct_target_count)',
    )

    const rejectedJobId = crypto.randomUUID()
    const rejectedBatchId = crypto.randomUUID()
    const checkClient = await pool.connect()
    try {
      await checkClient.query('BEGIN')
      await checkClient.query(
        `SELECT set_config(
           'attendance.w4c3a_enqueue_job_id',
           $1::uuid::text,
           true
         )`,
        [rejectedJobId],
      )
      await expect(
        checkClient.query(
          `INSERT INTO attendance_import_jobs (
             id, org_id, batch_id, created_by, idempotency_key, status, progress, total, payload,
             w4_contract_version, w4_entrypoint, w4_batch_command_id, w4_source_kind,
             w4_source_ref, w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
             w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
             w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector,
             w4_legacy_plan_digest, w4_distinct_target_count, w4_operational_branch,
             w4_legacy_input_fingerprint
           )
           SELECT $3::uuid, org_id, $4::uuid, created_by, $5, status, progress, total, payload,
                  w4_contract_version, w4_entrypoint, $4::uuid, w4_source_kind,
                  w4_source_ref, w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
                  w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
                  w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector,
                  w4_legacy_plan_digest, w4_distinct_target_count, w4_operational_branch,
                  w4_legacy_input_fingerprint
             FROM attendance_import_jobs
            WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
          [
            ORG,
            batchId,
            rejectedJobId,
            rejectedBatchId,
            `w4c3a-invalid-check-${run}`,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_aij_w4_proof_vector',
      })
    } finally {
      await checkClient.query('ROLLBACK').catch(() => undefined)
      checkClient.release()
    }

    row.vector.forEach((entry, index) => {
      const durableRow = {
        orgId: row.org_id,
        entrypoint: 'import_batch',
        kind: 'item' as const,
        operationId: entry.derivedOperationId,
        acceptedWritePosture: row.posture,
        identitySourceKind: 'import_item',
        sourceRootId: row.root,
        inputOrdinal: entry.ordinal,
        proofSemanticFingerprint: entry.semanticFingerprint,
        proofUserId: null,
        proofWorkDate: null,
      }
      const identity =
        rehydrateVerifiedAttendanceOperationIdentityV1(durableRow)
      expect(identity.id).toBe(entry.derivedOperationId)
      expect(identity.sourceProof).toMatchObject({
        sourceKind: 'import_item',
        sourceRootId: row.root,
        ordinal: String(index),
        semanticFingerprint: entry.semanticFingerprint,
      })

      const drifted = [
        { ...durableRow, operationId: crypto.randomUUID() },
        { ...durableRow, inputOrdinal: (entry.ordinal + 1) % row.vector.length },
        {
          ...durableRow,
          proofSemanticFingerprint:
            entry.semanticFingerprint === HEX_A ? HEX_B : HEX_A,
        },
      ]
      for (const candidate of drifted) {
        expect(() =>
          rehydrateVerifiedAttendanceOperationIdentityV1(candidate),
        ).toThrow('W4C0_IDENTITY_PROOF_DRIFT')
      }
    })
  })

  it('freezes legacy name-first and code-fallback group references as durable UUIDs', async () => {
    const nameWinnerId = crypto.randomUUID()
    const shadowedCodeId = crypto.randomUUID()
    const codeOnlyId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone)
       VALUES
         ($1, $4, 'Ops', NULL, 'Asia/Taipei'),
         ($2, $4, 'Secondary', 'OPS', 'Asia/Taipei'),
         ($3, $4, 'Engineering', 'ENG', 'Asia/Taipei')`,
      [nameWinnerId, shadowedCodeId, codeOnlyId, ORG],
    )
    const batchId = crypto.randomUUID()
    const { input } = strictInput(legacyOrgWitness, batchId, ADMIN_A)
    const groupEffects: readonly LegacyImportGroupEffectDraftV1[] = [
      {
        kind: 'ensure_member',
        groupRef: ' ops ',
        userId: TARGET_USER,
        firstSourceOrdinal: 0,
      },
      {
        kind: 'ensure_member',
        groupRef: 'eng',
        userId: ADMIN_B,
        firstSourceOrdinal: 0,
      },
    ]

    await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(
        trx(client),
        auth(ADMIN_A, ORG),
        { ...input, groupEffects },
      ),
    )
    const stored = await pool.query(
      `SELECT chunk
         FROM attendance_import_legacy_execution_plan_chunks c
         JOIN attendance_import_jobs j ON j.id = c.job_id
        WHERE j.batch_id = $1`,
      [batchId],
    )
    const effects = (stored.rows[0].chunk as {
      groupEffects: Array<Record<string, unknown>>
    }).groupEffects

    expect(effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'ensure_member',
        groupRef: nameWinnerId,
        userId: TARGET_USER,
      membershipExistedAtPrepare: false,
      }),
      expect.objectContaining({
        kind: 'ensure_member',
        groupRef: codeOnlyId,
        userId: ADMIN_B,
      membershipExistedAtPrepare: false,
      }),
    ]))
    expect(effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ groupRef: shadowedCodeId }),
    ]))
  })

  it('omits ensure_group for a frozen existing group and keeps only a requested member effect', async () => {
    const existingGroupId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone)
       VALUES ($1, $2, 'Existing Team', 'EXISTING', 'Asia/Taipei')`,
      [existingGroupId, ORG],
    )

    const reserve = async (
      batchId: string,
      groupEffects: readonly LegacyImportGroupEffectDraftV1[],
    ) => {
      const { input } = strictInput(legacyOrgWitness, batchId, ADMIN_A)
      await runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ADMIN_A, ORG),
          { ...input, groupEffects },
        ),
      )
      return pool.query(
        `SELECT m.group_revision, m.group_state_fingerprint, c.chunk
           FROM attendance_import_legacy_execution_plans m
           JOIN attendance_import_jobs j ON j.id = m.job_id
           LEFT JOIN attendance_import_legacy_execution_plan_chunks c
             ON c.job_id = m.job_id AND c.chunk_index = 0
          WHERE j.batch_id = $1`,
        [batchId],
      )
    }

    const existingOnly = await reserve(crypto.randomUUID(), [
      {
        kind: 'ensure_group',
        normalizedName: 'existing team',
        displayName: 'Existing Team',
        code: 'EXISTING',
        timezone: 'Asia/Taipei',
        ruleSetId: null,
        firstSourceOrdinal: 0,
      },
    ])
    const existingOnlyEffects = (
      existingOnly.rows[0].chunk as {
        groupEffects: Array<Record<string, unknown>>
      }
    ).groupEffects
    expect(existingOnlyEffects).toEqual([])
    expect(existingOnly.rows[0].group_revision).toBeNull()
    expect(existingOnly.rows[0].group_state_fingerprint).toBeNull()

    const withMember = await reserve(crypto.randomUUID(), [
      {
        kind: 'ensure_group',
        normalizedName: 'existing team',
        displayName: 'Existing Team',
        code: 'EXISTING',
        timezone: 'Asia/Taipei',
        ruleSetId: null,
        firstSourceOrdinal: 0,
      },
      {
        kind: 'ensure_member',
        groupRef: 'existing',
        userId: TARGET_USER,
        firstSourceOrdinal: 0,
      },
    ])
    const memberEffects = (
      withMember.rows[0].chunk as {
        groupEffects: Array<Record<string, unknown>>
      }
    ).groupEffects
    expect(memberEffects).toEqual([
      expect.objectContaining({
        kind: 'ensure_member',
        groupRef: existingGroupId,
        userId: TARGET_USER,
        membershipExistedAtPrepare: false,
      }),
    ])
    expect(withMember.rows[0].group_revision).not.toBeNull()
    expect(withMember.rows[0].group_state_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('freezes a same-plan ensure-group code reference to the minted group UUID', async () => {
    const batchId = crypto.randomUUID()
    const { input } = strictInput(legacyOrgWitness, batchId, ADMIN_A)
    const groupEffects: readonly LegacyImportGroupEffectDraftV1[] = [
      {
        kind: 'ensure_group',
        normalizedName: 'night shift',
        displayName: 'Night Shift',
        code: 'NIGHT',
        timezone: 'Asia/Taipei',
        ruleSetId: null,
        firstSourceOrdinal: 0,
      },
      {
        kind: 'ensure_member',
        groupRef: 'night',
        userId: TARGET_USER,
        firstSourceOrdinal: 0,
      },
    ]

    await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(
        trx(client),
        auth(ADMIN_A, ORG),
        { ...input, groupEffects },
      ),
    )
    const stored = await pool.query(
      `SELECT chunk
         FROM attendance_import_legacy_execution_plan_chunks c
         JOIN attendance_import_jobs j ON j.id = c.job_id
        WHERE j.batch_id = $1`,
      [batchId],
    )
    const effects = (stored.rows[0].chunk as {
      groupEffects: Array<Record<string, unknown>>
    }).groupEffects
    const group = effects.find((effect) => effect.kind === 'ensure_group')
    const member = effects.find((effect) => effect.kind === 'ensure_member')

    expect(group?.groupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(member?.groupRef).toBe(group?.groupId)
  })

  it('persists exact transient fingerprints for a 5001-item operational batch and rejects one-hex mutations before persistence', async () => {
    const buildInput = (batchId: string) => {
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org: legacyOrgWitness,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchId },
      })
      const itemIdentities: Array<{ identity: unknown; commandFingerprint: string }> = []
      const items: LegacyImportItemDraftV1[] = []
      const recordWrites: LegacyImportRecordWriteDraftV1[] = []
      const fingerprintEntries: Array<{ ordinal: string; operationId: string; commandFingerprint: string }> = []
      for (let ordinal = 0; ordinal < 5001; ordinal += 1) {
        const userId = crypto.randomUUID()
        const workDate = `2027-01-${String((ordinal % 28) + 1).padStart(2, '0')}`
        const semanticFingerprint = crypto
          .createHash('sha256')
          .update(`w4c3a-operational-semantic:${ordinal}`, 'utf8')
          .digest('hex')
        const identity = createVerifiedAttendanceOperationIdentityV1({
          org: legacyOrgWitness,
          kind: 'item',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_item',
            batchCommandId: batchId,
            ordinal,
            semanticFingerprint,
          },
        })
        itemIdentities.push({ identity, commandFingerprint: HEX_C })
        fingerprintEntries.push({
          ordinal: String(ordinal),
          operationId: identity.id,
          commandFingerprint: HEX_C,
        })
        const targetRef = JSON.stringify([legacyOrgWitness.orgId, userId, workDate])
        items.push({
          kind: 'apply', ordinal, semanticOrdinal: ordinal, targetRef, previewSnapshot: {},
          rawEvidence: rawImportEvidenceV1(ordinal, {
            userId,
            workDate,
            timezone: 'Asia/Shanghai',
            status: 'normal',
            isWorkday: true,
            workMinutes: 0,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
          }),
        })
        recordWrites.push({
          orgId: legacyOrgWitness.orgId,
          userId,
          workDate,
          sourceOrdinals: [ordinal],
          mergeMode: 'merge',
          firstInAt: null,
          lastOutAt: null,
          workMinutes: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          status: 'normal',
          isWorkday: true,
          timezone: 'Asia/Shanghai',
          compatibilityMetadata: {},
          policySnapshot: {},
          profileSnapshot: {},
          multiPunchSnapshot: {},
          attributionSnapshot: {},
          sourceBatchId: batchId,
          resultSlots: {},
        })
      }
      const sequenceFingerprint = computeAttendanceItemSequenceFingerprintV1(fingerprintEntries)
      const setFingerprint = computeAttendanceItemSetFingerprintV1(fingerprintEntries)
      const batch = normalBatch(null, 5001)
      return {
        input: {
          batchIdentity,
          itemIdentities,
          job: {
            orgId: ORG, batchId, createdBy: ADMIN_A, idempotencyKey: null, total: 5001,
            payload: {
              __jobType: 'commit', idempotencyKey: null, __importEngine: 'standard',
              recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1,
            },
            w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId, w4SourceKind: 'import_batch' as const,
            w4SourceRef: SOURCE_REF, w4ActorId: ADMIN_A, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: ADMIN_A,
            w4CommandFingerprint: HEX_A, w4AcceptedWritePosture: legacyOrgWitness.acceptedWritePosture,
            w4ItemCount: 5001, w4ItemSequenceFingerprint: sequenceFingerprint, w4ItemSetFingerprint: setFingerprint,
            w4IdentityProofVector: [], w4DistinctTargetCount: 5001,
            w4OperationalBranch: 'operational_only_batch_limit' as const, w4LegacyInputFingerprint: HEX_B,
          },
          manifestSeed: {
            schemaVersion: 1 as const, orgId: ORG, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF,
            createdBy: ADMIN_A, actorId: ADMIN_A, actorPosture: 'platform_admin', tokenSubjectUserId: ADMIN_A,
            acceptedWritePosture: legacyOrgWitness.acceptedWritePosture, commandFingerprint: HEX_A,
            legacyInputFingerprint: HEX_B, operationalBranch: 'operational_only_batch_limit' as const,
            legacyRowSourceKind: 'direct_rows' as const, sourceRowCount: 5001, w4ItemCount: 5001,
            w4DistinctTargetCount: 5001, w4ItemSequenceFingerprint: sequenceFingerprint,
            w4ItemSetFingerprint: setFingerprint, legacySourceRowLimit: null, batch,
            artifactCleanup: { kind: 'none' as const },
          },
          items,
          recordWrites,
          groupEffects: [],
        },
        sequenceFingerprint,
        setFingerprint,
      }
    }

    const invalidBatchId = crypto.randomUUID()
    const invalid = buildInput(invalidBatchId)
    const mutatedSequence = `${invalid.sequenceFingerprint[0] === 'a' ? 'b' : 'a'}${invalid.sequenceFingerprint.slice(1)}`
    const invalidInput = {
      ...invalid.input,
      job: { ...invalid.input.job, w4ItemSequenceFingerprint: mutatedSequence },
      manifestSeed: { ...invalid.input.manifestSeed, w4ItemSequenceFingerprint: mutatedSequence },
    }
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), invalidInput),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_ITEM_PROOF_MISMATCH' })
    expect(await residue(pool, invalidBatchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })

    const validBatchId = crypto.randomUUID()
    const valid = buildInput(validBatchId)
    const bulkKey = buildAttendanceOperationalBulkTargetAdvisoryKey(
      parseCanonicalAttendanceRolloutOrgKeyV1(ORG),
    )
    const keyParts = (key: bigint) => {
      const unsigned = BigInt.asUintN(64, key)
      return {
        classid: (unsigned >> 32n).toString(),
        objid: (unsigned & 0xffffffffn).toString(),
      }
    }
    const expectedBulkKey = keyParts(bulkKey)
    const created = await runSerializable(pool, async (client) => {
      const before = await client.query(
        `SELECT classid::text, objid::text, mode, granted
           FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
      )
      const result = await reserveAttendanceLegacyImportPlanJobV1(
        trx(client), auth(ADMIN_A, ORG), valid.input,
      )
      const after = await client.query(
        `SELECT classid::text, objid::text, mode, granted
           FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
      )
      const matchingBefore = before.rows.filter(
        (row) => row.classid === expectedBulkKey.classid && row.objid === expectedBulkKey.objid,
      )
      const matchingAfter = after.rows.filter(
        (row) => row.classid === expectedBulkKey.classid && row.objid === expectedBulkKey.objid,
      )
      expect(matchingBefore).toHaveLength(0)
      expect(matchingAfter).toHaveLength(1)
      expect(matchingAfter[0]).toMatchObject({ mode: 'ExclusiveLock', granted: true })
      return result
    })
    expect(created.kind).toBe('created')
    const persisted = await pool.query(
      `SELECT j.w4_item_count, j.w4_distinct_target_count, j.w4_operational_branch,
              j.w4_item_sequence_fingerprint AS job_sequence,
              j.w4_item_set_fingerprint AS job_set,
              j.w4_identity_proof_vector,
              p.source_row_count, p.chunk_count,
              p.w4_item_sequence_fingerprint AS manifest_sequence,
              p.w4_item_set_fingerprint AS manifest_set,
              count(c.chunk_index)::int AS persisted_chunks,
              coalesce(sum(jsonb_array_length(c.chunk->'items')), 0)::int AS persisted_items
         FROM attendance_import_jobs j
         JOIN attendance_import_legacy_execution_plans p ON p.job_id = j.id
         JOIN attendance_import_legacy_execution_plan_chunks c ON c.job_id = j.id
        WHERE j.batch_id = $1
        GROUP BY j.w4_item_count, j.w4_distinct_target_count, j.w4_operational_branch,
                 j.w4_item_sequence_fingerprint, j.w4_item_set_fingerprint,
                 j.w4_identity_proof_vector, p.source_row_count, p.chunk_count,
                 p.w4_item_sequence_fingerprint, p.w4_item_set_fingerprint`,
      [validBatchId],
    )
    expect(persisted.rows).toEqual([{
      w4_item_count: 5001,
      w4_distinct_target_count: 5001,
      w4_operational_branch: 'operational_only_batch_limit',
      job_sequence: valid.sequenceFingerprint,
      job_set: valid.setFingerprint,
      w4_identity_proof_vector: [],
      source_row_count: 5001,
      chunk_count: 11,
      manifest_sequence: valid.sequenceFingerprint,
      manifest_set: valid.setFingerprint,
      persisted_chunks: 11,
      persisted_items: 5001,
    }])
  })

  it('fails closed after authorization loss with zero job, manifest, or chunk rows', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [ADMIN_A])
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input),
    )).rejects.toMatchObject({ code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [ADMIN_A])
  })

  it('rechecks namespace admission and legacy wildcard permissions inside the enqueue transaction', async () => {
    const deniedBatchId = crypto.randomUUID()
    const denied = noTargetInput(legacyOrgWitness, deniedBatchId, ADMIN_A, ADMIN_A)
    await pool.query(
      `UPDATE user_namespace_admissions
          SET enabled = false
        WHERE user_id = $1 AND namespace = 'attendance'`,
      [ADMIN_A],
    )
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ADMIN_A, ORG),
          denied.input,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED',
    })
    expect(await residue(pool, deniedBatchId)).toEqual({
      jobs: 0,
      manifests: 0,
      chunks: 0,
    })
    await pool.query(
      `UPDATE user_namespace_admissions
          SET enabled = true
        WHERE user_id = $1 AND namespace = 'attendance'`,
      [ADMIN_A],
    )

    const wildcardBatchId = crypto.randomUUID()
    const wildcard = noTargetInput(
      legacyOrgWitness,
      wildcardBatchId,
      LEGACY_WILDCARD_ADMIN,
      LEGACY_WILDCARD_ADMIN,
    )
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(LEGACY_WILDCARD_ADMIN, ORG),
          wildcard.input,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'created' })
    expect(await residue(pool, wildcardBatchId)).toEqual({
      jobs: 1,
      manifests: 1,
      chunks: 1,
    })

    const roleWildcardBatchId = crypto.randomUUID()
    const roleWildcard = noTargetInput(
      legacyOrgWitness,
      roleWildcardBatchId,
      ROLE_WILDCARD_ADMIN,
      ROLE_WILDCARD_ADMIN,
    )
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ROLE_WILDCARD_ADMIN, ORG),
          roleWildcard.input,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'created' })
    expect(await residue(pool, roleWildcardBatchId)).toEqual({
      jobs: 1,
      manifests: 1,
      chunks: 1,
    })
  })

  it('replays a completed route-idempotency job for a second authorized admin without createdBy equality', async () => {
    const batchId = crypto.randomUUID()
    const idempotencyKey = `idem-${run}`
    const first = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A, idempotencyKey)
    const created = await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), first.input),
    )
    if (created.kind !== 'created') throw new Error('expected first enqueue to create a job')
    const response = terminalResponse(idempotencyKey)
    await runSerializable(pool, async (client) => {
      await client.query(`UPDATE attendance_import_jobs SET status = 'completed', progress = total, finished_at = now() WHERE id = $1`, [created.jobId])
      await client.query(
        `INSERT INTO attendance_import_legacy_terminal_responses (job_id, org_id, response_variant, response_digest, response)
         VALUES ($1, $2, 'first_execution', $3, $4::jsonb)`,
        [
          created.jobId,
          ORG,
          computeLegacyImportAsyncJobSummaryDigestV1(response),
          JSON.stringify(response),
        ],
      )
    })
    const second = noTargetInput(legacyOrgWitness, batchId, ADMIN_B, ADMIN_B, idempotencyKey)
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_B, ORG), second.input),
    )).resolves.toMatchObject({ kind: 'existing', jobId: created.jobId, status: 'completed' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 1, manifests: 1, chunks: 1 })
  })

  it('replays one completed response from a new worker instance without duplicate callback execution', async () => {
    const batchId = crypto.randomUUID()
    const planned = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    const created = await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(
        trx(client),
        auth(ADMIN_A, ORG),
        planned.input,
      ),
    )
    if (created.kind !== 'created') throw new Error('expected enqueue to create a job')

    let effectCount = 0
    const makeWorker = () => createAttendanceLegacyPlanWorkerV1<PoolClient>({
      readCandidateJob: (jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(
          trx(pool as unknown as PoolClient),
        ).readCandidateJob(jobId),
      runSerializable: (work) => runSerializable(pool, work),
      acquireClass00: (client, orgId) =>
        acquireAttendanceCalculationRolloutLock(
          trx(client),
          parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
          'shared',
        ),
      resolveWritePosture: async (client, orgId) => {
        const posture = await resolveSegmentCalculationPosture(trx(client), orgId)
        return posture.effectiveState === 'suspended'
          ? 'suspended'
          : posture.writePosture
      },
      readAuthorizationJob: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .readAuthorizationJob(jobId, ORG),
      lockJob: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .lockJob(jobId, ORG),
      authorizeFullImport: async () => true,
      reservationIdentities: (job) => [
        createVerifiedAttendanceOperationIdentityV1({
          org: legacyOrgWitness,
          kind: 'batch',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_batch',
            batchCommandId: job.batchId,
          },
        }),
      ],
      acquireClass10: (client, _job, identities) =>
        acquireAttendanceImportReservationLocksV1(trx(client), identities, null),
      loadPlan: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .loadPlan(jobId, ORG),
      recheckReplayPrecondition: async () => true,
      targetIdentities: () => [],
      acquireClass11: (client, _plan, identities) =>
        acquireAttendanceCalculationTargetLocks(trx(client), identities),
      recheckPreconditions: async () => true,
      executeVerifiedPlan: async () => {
        effectCount += 1
        return terminalResponse(null)
      },
      storeCompletedResponseAndTerminalize: (
        client,
        job,
        plan,
        response,
        responseDigest,
      ) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .storeCompletedResponseAndTerminalize(
            job as AttendanceLegacyPlanWorkerRepositoryJobV1,
            plan,
            response,
            responseDigest,
          ),
      loadCompletedResponse: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .loadCompletedResponse(jobId, ORG),
      markSuspendedQueued: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .markSuspendedQueued(jobId, ORG),
      clearResumedSuspendedReason: (client, jobId) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .clearResumedSuspendedReason(jobId, ORG),
      markPlanFailed: (client, jobId, reason) =>
        createAttendanceLegacyPlanWorkerRepositoryV1(trx(client))
          .markPlanFailed(jobId, ORG, reason),
    })

    const first = await makeWorker().process(created.jobId)
    expect(first).toEqual({ kind: 'completed', response: terminalResponse(null) })
    expect(effectCount).toBe(1)

    const replay = await makeWorker().process(created.jobId)
    expect(replay).toEqual(first)
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first))
    expect(effectCount).toBe(1)

    const persisted = await pool.query(
      `SELECT j.status,
              count(r.job_id)::int AS terminal_responses,
              count(c.job_id)::int AS cleanup_commands
         FROM attendance_import_jobs j
         LEFT JOIN attendance_import_legacy_terminal_responses r
           ON r.job_id = j.id AND r.org_id = j.org_id
         LEFT JOIN attendance_import_upload_cleanup_commands c
           ON c.job_id = j.id AND c.org_id = j.org_id
        WHERE j.id = $1 AND j.org_id = $2
        GROUP BY j.status`,
      [created.jobId, ORG],
    )
    expect(persisted.rows).toEqual([{
      status: 'completed',
      terminal_responses: 1,
      cleanup_commands: 0,
    }])
  })

  it('rejects conflicting private executor fields without adding a second job', async () => {
    const batchId = crypto.randomUUID()
    const first = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), first.input),
    )
    const conflicting = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A, null, HEX_D, HEX_B)
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), conflicting.input),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_JOB_RESERVATION_CONFLICT' })
    expect((await pool.query(`SELECT count(*)::int AS n FROM attendance_import_jobs WHERE batch_id = $1`, [batchId])).rows[0].n).toBe(1)
  })

  it('does not persist a strict plan from a stale snapshot after an intervening committed record change', async () => {
    const batchId = crypto.randomUUID()
    const recordId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_records (id, org_id, user_id, work_date, work_minutes, status, is_workday, meta)
       VALUES ($1, $2, $3, '2026-07-30', 480, 'normal', true, '{}'::jsonb)`,
      [recordId, ORG, TARGET_USER],
    )
    const { input } = strictInput(legacyOrgWitness, batchId, ADMIN_A)
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await client.query(`SELECT current_setting('transaction_isolation')`)
      await pool.query(`UPDATE attendance_records SET work_minutes = 481 WHERE id = $1`, [recordId])
      let failure: unknown
      try {
        await reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input)
      } catch (error) {
        failure = error
      }
      expect(['40001', '40P01', 'W4C3A_ENQUEUE_RECORD_PRECONDITION_CHANGED']).toContain(errorCode(failure))
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    const revision = await pool.query(
      `SELECT revision::int FROM attendance_record_target_revisions WHERE org_id = $1 AND user_id = $2 AND work_date = '2026-07-30'`,
      [ORG, TARGET_USER],
    )
    expect(revision.rows[0].revision).toBe(2)
  })

  it('rolls back all enqueue residue when the caller rolls back after the three inserts', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await expect(runSerializable(pool, async (client) => {
      await reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input)
      throw new Error('ROLLBACK_AFTER_ENQUEUE')
    })).rejects.toThrow('ROLLBACK_AFTER_ENQUEUE')
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
  })

  it('fails closed when the current rollout posture changes after the org witness was captured', async () => {
    const legacyPosture = await loadOrgWitness(pool, POSTURE_ORG)
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyPosture, batchId, ADMIN_A, ADMIN_A)
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3a-test', 'TEST', $2, 1, NULL, 'synthetic_staging')`,
      [POSTURE_ORG, ADMIN_A],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [POSTURE_ORG],
    )
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, POSTURE_ORG), input),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_POSTURE_CHANGED' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'legacy', prior_state = 'shadow', version = 3 WHERE org_id = $1`,
      [POSTURE_ORG],
    )
  })

  it('serializes complete-plan enqueue against the locked transition contract harness in both commit orders', async () => {
    // No production rollout-transition writer ships yet. This harness exercises
    // the locked scan/update sequence required of that future writer, so it proves
    // enqueue-side lock compatibility without claiming transition cutover.
    const enqueueFirstBatch = crypto.randomUUID()
    const enqueueFirstOrg = await loadOrgWitness(
      pool,
      ROLLOUT_ENQUEUE_FIRST_ORG,
    )
    const enqueueFirstInput = strictInput(
      enqueueFirstOrg,
      enqueueFirstBatch,
      ADMIN_A,
    )
    const enqueue = await pool.connect()
    const transition = await pool.connect()
    try {
      await enqueue.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await expect(
        reserveAttendanceLegacyImportPlanJobV1(
          trx(enqueue),
          auth(ADMIN_A, ROLLOUT_ENQUEUE_FIRST_ORG),
          enqueueFirstInput.input,
        ),
      ).resolves.toMatchObject({ kind: 'created' })

      await transition.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const transitionPid = await backendPid(transition)
      const transitionAcquire = acquireAttendanceCalculationRolloutLock(
        trx(transition),
        parseCanonicalAttendanceRolloutOrgKeyV1(
          ROLLOUT_ENQUEUE_FIRST_ORG,
        ),
        'exclusive',
      )
      void transitionAcquire.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, transitionPid)
      expect(await residue(pool, enqueueFirstBatch)).toEqual({
        jobs: 0,
        manifests: 0,
        chunks: 0,
      })

      await enqueue.query('COMMIT')
      await transitionAcquire
      await transition.query(
        `SELECT status, w4_accepted_write_posture
           FROM attendance_import_jobs
          WHERE org_id = $1 AND w4_contract_version = 1
            AND status IN ('queued', 'running')
          ORDER BY id
          FOR UPDATE`,
        [ROLLOUT_ENQUEUE_FIRST_ORG],
      )
      let transitionFailure: unknown
      try {
        await transition.query(
          `UPDATE attendance_calculation_rollout_state
              SET state = 'shadow', prior_state = 'legacy', version = 2
            WHERE org_id = $1`,
          [ROLLOUT_ENQUEUE_FIRST_ORG],
        )
        await transition.query('COMMIT')
      } catch (error) {
        transitionFailure = error
      }
      expect(errorCode(transitionFailure)).toBe('40001')
      await transition.query('ROLLBACK').catch(() => undefined)

      await transition.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await acquireAttendanceCalculationRolloutLock(
        trx(transition),
        parseCanonicalAttendanceRolloutOrgKeyV1(
          ROLLOUT_ENQUEUE_FIRST_ORG,
        ),
        'exclusive',
      )
      const frozen = await transition.query(
        `SELECT status, w4_accepted_write_posture
           FROM attendance_import_jobs
          WHERE org_id = $1 AND w4_contract_version = 1
            AND status IN ('queued', 'running')
          ORDER BY id
          FOR UPDATE`,
        [ROLLOUT_ENQUEUE_FIRST_ORG],
      )
      expect(frozen.rows).toEqual([
        {
          status: 'queued',
          w4_accepted_write_posture: 'legacy_projection_only',
        },
      ])
      await transition.query('ROLLBACK')
    } finally {
      await enqueue.query('ROLLBACK').catch(() => undefined)
      await transition.query('ROLLBACK').catch(() => undefined)
      enqueue.release()
      transition.release()
    }

    const transitionFirstBatch = crypto.randomUUID()
    const transitionFirstOrg = await loadOrgWitness(
      pool,
      ROLLOUT_TRANSITION_FIRST_ORG,
    )
    const transitionFirstInput = strictInput(
      transitionFirstOrg,
      transitionFirstBatch,
      ADMIN_A,
    )
    const transitionFirst = await pool.connect()
    const waitingEnqueue = await pool.connect()
    try {
      await transitionFirst.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await acquireAttendanceCalculationRolloutLock(
        trx(transitionFirst),
        parseCanonicalAttendanceRolloutOrgKeyV1(
          ROLLOUT_TRANSITION_FIRST_ORG,
        ),
        'exclusive',
      )
      await transitionFirst.query(
        `SELECT id
           FROM attendance_import_jobs
          WHERE org_id = $1 AND w4_contract_version = 1
            AND status IN ('queued', 'running')
          ORDER BY id
          FOR UPDATE`,
        [ROLLOUT_TRANSITION_FIRST_ORG],
      )
      await transitionFirst.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'shadow', prior_state = 'legacy', version = 2
          WHERE org_id = $1`,
        [ROLLOUT_TRANSITION_FIRST_ORG],
      )

      await waitingEnqueue.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const enqueuePid = await backendPid(waitingEnqueue)
      const enqueuePromise = reserveAttendanceLegacyImportPlanJobV1(
        trx(waitingEnqueue),
        auth(ADMIN_A, ROLLOUT_TRANSITION_FIRST_ORG),
        transitionFirstInput.input,
      )
      void enqueuePromise.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, enqueuePid)
      await transitionFirst.query('COMMIT')

      await expect(enqueuePromise).rejects.toMatchObject({
        code: '40001',
      })
      await waitingEnqueue.query('ROLLBACK').catch(() => undefined)
      // Caller cutover and its bounded retry are not shipped. Rebuild the witness
      // explicitly to prove only the state a future whole-transaction retry sees.
      const refreshedOrg = await loadOrgWitness(
        pool,
        ROLLOUT_TRANSITION_FIRST_ORG,
      )
      const refreshedInput = strictInput(
        refreshedOrg,
        transitionFirstBatch,
        ADMIN_A,
      )
      await expect(
        runSerializable(pool, (client) =>
          reserveAttendanceLegacyImportPlanJobV1(
            trx(client),
            auth(ADMIN_A, ROLLOUT_TRANSITION_FIRST_ORG),
            refreshedInput.input,
          ),
        ),
      ).resolves.toMatchObject({ kind: 'created' })
    } finally {
      await transitionFirst.query('ROLLBACK').catch(() => undefined)
      await waitingEnqueue.query('ROLLBACK').catch(() => undefined)
      transitionFirst.release()
      waitingEnqueue.release()
    }
    expect(await residue(pool, transitionFirstBatch)).toEqual({
      jobs: 1,
      manifests: 1,
      chunks: 1,
    })
    const refreshedJob = await pool.query(
      `SELECT w4_accepted_write_posture
         FROM attendance_import_jobs
        WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [ROLLOUT_TRANSITION_FIRST_ORG, transitionFirstBatch],
    )
    expect(refreshedJob.rows).toEqual([
      { w4_accepted_write_posture: 'shadow' },
    ])
  }, 30000)

  it('serializes complete-plan enqueue with synchronous operation claims in both commit orders', async () => {
    const sealClaim = async (
      client: PoolClient,
      claim: Awaited<ReturnType<typeof attendanceResultOperationPreflightV1>>,
    ): Promise<void> => {
      if (claim.kind !== 'claimed') throw new Error('expected a fresh claim')
      const itemIds = claim.itemIdentities.map((identity) => identity.id)
      for (const identity of claim.itemIdentities) {
        await sealAttendanceResultOperationV1(trx(client), identity, {
          responseSnapshot: { sync: true },
        })
      }
      await sealAttendanceResultOperationBatchV1(
        trx(client),
        claim.batchIdentity,
        {
          order: itemIds,
          byItem: Object.fromEntries(
            itemIds.map((itemId) => [itemId, { sync: true }]),
          ),
        },
      )
    }

    const org = await loadOrgWitness(pool, SYNC_RACE_ORG)
    const syncFirstBatch = crypto.randomUUID()
    const syncFirstInput = strictInput(org, syncFirstBatch, ADMIN_A)
    const syncFirst = await pool.connect()
    const waitingEnqueue = await pool.connect()
    try {
      await syncFirst.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const claim = await attendanceResultOperationPreflightV1(
        trx(syncFirst),
        auth(ADMIN_A, SYNC_RACE_ORG),
        importBatchEnvelope(SYNC_RACE_ORG, syncFirstBatch).registryInput,
      )

      await waitingEnqueue.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const enqueuePid = await backendPid(waitingEnqueue)
      const enqueuePromise = reserveAttendanceLegacyImportPlanJobV1(
        trx(waitingEnqueue),
        auth(ADMIN_A, SYNC_RACE_ORG),
        syncFirstInput.input,
      )
      void enqueuePromise.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, enqueuePid)
      await sealClaim(syncFirst, claim)
      await syncFirst.query('COMMIT')

      await expect(enqueuePromise).rejects.toMatchObject({
        code: '40001',
      })
      await waitingEnqueue.query('ROLLBACK')
      // This explicit fresh transaction proves the committed conflict result; it
      // does not claim that an enqueue caller/retry wrapper has shipped.
      await expect(
        runSerializable(pool, (client) =>
          reserveAttendanceLegacyImportPlanJobV1(
            trx(client),
            auth(ADMIN_A, SYNC_RACE_ORG),
            syncFirstInput.input,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'ATTENDANCE_OPERATION_BATCH_CONFLICT',
      })
    } finally {
      await syncFirst.query('ROLLBACK').catch(() => undefined)
      await waitingEnqueue.query('ROLLBACK').catch(() => undefined)
      syncFirst.release()
      waitingEnqueue.release()
    }
    expect(await residue(pool, syncFirstBatch)).toEqual({
      jobs: 0,
      manifests: 0,
      chunks: 0,
    })

    const enqueueFirstBatch = crypto.randomUUID()
    const enqueueFirstInput = strictInput(org, enqueueFirstBatch, ADMIN_A)
    const enqueueFirst = await pool.connect()
    const waitingSync = await pool.connect()
    try {
      await enqueueFirst.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await expect(
        reserveAttendanceLegacyImportPlanJobV1(
          trx(enqueueFirst),
          auth(ADMIN_A, SYNC_RACE_ORG),
          enqueueFirstInput.input,
        ),
      ).resolves.toMatchObject({ kind: 'created' })

      await waitingSync.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const syncPid = await backendPid(waitingSync)
      const syncPromise = attendanceResultOperationPreflightV1(
        trx(waitingSync),
        auth(ADMIN_A, SYNC_RACE_ORG),
        importBatchEnvelope(SYNC_RACE_ORG, enqueueFirstBatch).registryInput,
      )
      void syncPromise.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, syncPid)
      await enqueueFirst.query('COMMIT')

      await expect(syncPromise).rejects.toMatchObject({
        code: '40001',
      })
      await waitingSync.query('ROLLBACK')
      // As above, retry is modeled explicitly because enqueue caller cutover is
      // still outside this Draft/HOLD evidence slice.
      await expect(
        runSerializable(pool, (client) =>
          attendanceResultOperationPreflightV1(
            trx(client),
            auth(ADMIN_A, SYNC_RACE_ORG),
            importBatchEnvelope(
              SYNC_RACE_ORG,
              enqueueFirstBatch,
            ).registryInput,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'ATTENDANCE_OPERATION_BATCH_CONFLICT',
      })
    } finally {
      await enqueueFirst.query('ROLLBACK').catch(() => undefined)
      await waitingSync.query('ROLLBACK').catch(() => undefined)
      enqueueFirst.release()
      waitingSync.release()
    }
    expect(await residue(pool, enqueueFirstBatch)).toEqual({
      jobs: 1,
      manifests: 1,
      chunks: 1,
    })
    const syncRows = await pool.query(
      `SELECT count(*)::int AS operations
         FROM attendance_result_operations
        WHERE org_id = $1 AND batch_command_id = $2::uuid`,
      [SYNC_RACE_ORG, enqueueFirstBatch],
    )
    expect(syncRows.rows).toEqual([{ operations: 0 }])
  }, 30000)

  it('replays the complete-plan P07 proof-vector rejection matrix on the successor schema', async () => {
    const org = await loadOrgWitness(pool, SYNC_RACE_ORG)
    const batchId = crypto.randomUUID()
    const { input } = strictTwoItemInput(org, batchId, ADMIN_A)
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ADMIN_A, SYNC_RACE_ORG),
          input,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'created' })

    const job = await pool.query(
      `SELECT id::text AS id,
              attendance_w4_job_proof_vector_valid(
                w4_source_kind,
                w4_batch_command_id,
                w4_identity_proof_vector,
                w4_item_count,
                w4_operational_branch,
                w4_distinct_target_count
              ) AS valid
         FROM attendance_import_jobs
        WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [SYNC_RACE_ORG, batchId],
    )
    expect(job.rows).toEqual([
      expect.objectContaining({ valid: true }),
    ])
    const jobId = String(job.rows[0].id)
    const wrongNamespaceId = crypto.randomUUID()
    const mutations = [
      `(
        SELECT jsonb_agg(value ORDER BY ordinal DESC)
        FROM jsonb_array_elements(w4_identity_proof_vector)
          WITH ORDINALITY AS entries(value, ordinal)
      )`,
      `w4_identity_proof_vector || jsonb_build_array(w4_identity_proof_vector -> 0)`,
      `w4_identity_proof_vector - 1`,
      `w4_identity_proof_vector || jsonb_build_array(w4_identity_proof_vector -> 1)`,
      `jsonb_set(w4_identity_proof_vector, '{0,semanticFingerprint}', to_jsonb('${HEX_A}'::text))`,
      `jsonb_set(w4_identity_proof_vector, '{0,derivedOperationId}', to_jsonb('${wrongNamespaceId}'::text))`,
    ]
    const client = await pool.connect()
    try {
      await client.query('SET session_replication_role = replica')
      for (const mutation of mutations) {
        await expect(
          client.query(
            `UPDATE attendance_import_jobs
                SET w4_identity_proof_vector = ${mutation}
              WHERE id = $1::uuid`,
            [jobId],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'chk_aij_w4_proof_vector',
        })
      }
    } finally {
      await client.query('SET session_replication_role = origin').catch(() => undefined)
      client.release()
    }

    const unchanged = await pool.query(
      `SELECT w4_identity_proof_vector
         FROM attendance_import_jobs
        WHERE id = $1::uuid`,
      [jobId],
    )
    expect(unchanged.rows[0].w4_identity_proof_vector).toEqual(
      input.job.w4IdentityProofVector,
    )
  })

  it('retries the complete sync transaction under SERIALIZABLE with zero failed-attempt residue', async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS w4c3a_sync_retry_probe (
         marker text PRIMARY KEY
       )`,
    )
    await pool.query('TRUNCATE w4c3a_sync_retry_probe')
    let bodyCalls = 0
    const result =
      await syncCompatibility.runAttendanceSyncImportSerializableTransaction(
        {
          transaction: async (runAttempt) => {
            const client = await pool.connect()
            try {
              await client.query('BEGIN')
              const value = await runAttempt({
                query: (text, values = []) => client.query(text, values),
              })
              await client.query('COMMIT')
              return value
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            } finally {
              client.release()
            }
          },
        },
        async (client, attempt) => {
          bodyCalls += 1
          const isolation = (await client.query(
            `SELECT current_setting('transaction_isolation') AS isolation`,
          )) as { rows: Array<{ isolation: string }> }
          expect(isolation.rows[0]?.isolation).toBe('serializable')
          await client.query(
            'INSERT INTO w4c3a_sync_retry_probe (marker) VALUES ($1)',
            [`attempt-${attempt}`],
          )
          if (attempt === 0) {
            throw Object.assign(new Error('synthetic serialization failure'), {
              code: '40001',
            })
          }
          return `attempt-${attempt}`
        },
      )

    expect(result).toBe('attempt-1')
    expect(bodyCalls).toBe(2)
    expect(
      (
        await pool.query(
          'SELECT marker FROM w4c3a_sync_retry_probe ORDER BY marker',
        )
      ).rows,
    ).toEqual([{ marker: 'attempt-1' }])
  })

  it('rechecks queued, running, and failed V1 reservations through the sync compatibility bridge with zero effects', async () => {
    const org = await loadOrgWitness(pool, SYNC_RACE_ORG)
    const idempotencyKey = `sync-reservation-${run}`
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(
      org,
      batchId,
      ADMIN_A,
      ADMIN_A,
      idempotencyKey,
    )
    await expect(
      runSerializable(pool, (client) =>
        reserveAttendanceLegacyImportPlanJobV1(
          trx(client),
          auth(ADMIN_A, SYNC_RACE_ORG),
          input,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'created' })

    const legacyKey = parseCanonicalAttendanceLegacyIdempotencyKeyV1({
      orgId: SYNC_RACE_ORG,
      idempotencyKey,
    })
    const witness = {
      rolloutKey: buildAttendanceCalculationRolloutAdvisoryKey(
        parseCanonicalAttendanceRolloutOrgKeyV1(SYNC_RACE_ORG),
      ).toString(),
      legacyIdempotencyKey:
        buildAttendanceLegacyIdempotencyAdvisoryKey(legacyKey).toString(),
      helperWaitMs: 5000,
      transactionLockTimeoutMs: 5000,
    }
    const probe = async (
      expectedKind: 'in_progress' | 'conflict',
      expectedCode: string,
    ): Promise<void> => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await syncCompatibility.acquireAttendanceSyncImportReservationLocks(
          client,
          {
            orgId: SYNC_RACE_ORG,
            idempotencyKey,
            witness,
          },
        )
        const reservation =
          await syncCompatibility.loadAttendanceV1ImportReservationForSync(
            client,
            SYNC_RACE_ORG,
            idempotencyKey,
          )
        expect(reservation).toEqual({ kind: expectedKind })
        expect(() =>
          syncCompatibility.assertAttendanceV1ImportReservationAllowsSync(
            reservation,
          ),
        ).toThrow(expect.objectContaining({ code: expectedCode }))
        await client.query('ROLLBACK')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }

    await probe('in_progress', 'ATTENDANCE_OPERATION_IN_PROGRESS')
    await pool.query(
      `UPDATE attendance_import_jobs
          SET status = 'running', started_at = now()
        WHERE org_id = $1
          AND idempotency_key = $2
          AND w4_contract_version = 1`,
      [SYNC_RACE_ORG, idempotencyKey],
    )
    await probe('in_progress', 'ATTENDANCE_OPERATION_IN_PROGRESS')
    await pool.query(
      `UPDATE attendance_import_jobs
          SET status = 'failed',
              error = NULL,
              w4_execution_reason_code =
                'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
              finished_at = now()
        WHERE org_id = $1
          AND idempotency_key = $2
          AND w4_contract_version = 1`,
      [SYNC_RACE_ORG, idempotencyKey],
    )
    await probe('conflict', 'ATTENDANCE_OPERATION_BATCH_CONFLICT')

    const effects = await pool.query(
      `SELECT
         (SELECT count(*)::int
            FROM attendance_import_batches
           WHERE id = $1::uuid OR idempotency_key = $2) AS batches,
         (SELECT count(*)::int
            FROM attendance_import_items
           WHERE batch_id = $1::uuid) AS items,
         (SELECT count(*)::int
            FROM attendance_records
           WHERE source_batch_id = $1::uuid) AS records,
         (SELECT count(*)::int
            FROM attendance_result_operations
           WHERE org_id = $3
             AND batch_command_id = $1::uuid) AS operations`,
      [batchId, idempotencyKey, SYNC_RACE_ORG],
    )
    expect(effects.rows).toEqual([
      { batches: 0, items: 0, records: 0, operations: 0 },
    ])
  })

  it('interlocks the class-10 reservation with the shipped two-int legacy idempotency lock in both orders', async () => {
    const idempotencyKey = `compat-${run}`
    const legacyKey = parseCanonicalAttendanceLegacyIdempotencyKeyV1({
      orgId: SYNC_RACE_ORG,
      idempotencyKey,
    })
    const legacyFirst = await pool.connect()
    const currentWaiter = await pool.connect()
    try {
      await legacyFirst.query('BEGIN')
      await legacyFirst.query(
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
        [SYNC_RACE_ORG, idempotencyKey],
      )
      await currentWaiter.query('BEGIN')
      const waiterPid = await backendPid(currentWaiter)
      const currentPromise = acquireAttendanceImportReservationLocksV1(
        trx(currentWaiter),
        [],
        legacyKey,
      )
      void currentPromise.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, waiterPid)
      await legacyFirst.query('COMMIT')
      await expect(currentPromise).resolves.toBeUndefined()
      await currentWaiter.query('COMMIT')
    } finally {
      await legacyFirst.query('ROLLBACK').catch(() => undefined)
      await currentWaiter.query('ROLLBACK').catch(() => undefined)
      legacyFirst.release()
      currentWaiter.release()
    }

    const currentFirst = await pool.connect()
    const legacyWaiter = await pool.connect()
    try {
      await currentFirst.query('BEGIN')
      await acquireAttendanceImportReservationLocksV1(
        trx(currentFirst),
        [],
        legacyKey,
      )
      await legacyWaiter.query('BEGIN')
      const waiterPid = await backendPid(legacyWaiter)
      const legacyPromise = legacyWaiter.query(
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
        [SYNC_RACE_ORG, idempotencyKey],
      )
      void legacyPromise.catch(() => undefined)
      await waitUntilAdvisoryBlocked(pool, waiterPid)
      await currentFirst.query('COMMIT')
      await expect(legacyPromise).resolves.toBeDefined()
      await legacyWaiter.query('COMMIT')
    } finally {
      await currentFirst.query('ROLLBACK').catch(() => undefined)
      await legacyWaiter.query('ROLLBACK').catch(() => undefined)
      currentFirst.release()
      legacyWaiter.release()
    }
  }, 30000)
})
