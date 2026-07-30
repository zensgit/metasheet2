/**
 * W4C-3a phase 1 (#4556 / OD-W4C-56=(a)) — core-owned atomic P07 enqueue
 * persistence seam for LegacyImportExecutionPlanV1.
 *
 * Authority: amendment sections 3, 5.1, 6.
 *
 * Inserts, inside one caller-owned SERIALIZABLE transaction:
 *   - one V1 attendance_import_jobs row (server-minted id, frozen public envelope);
 *   - exactly one congruent plan manifest;
 *   - the complete dense chunk set (zero only for operational_only_idempotent_replay).
 *
 * Creates no operation / result / terminal-response / cleanup rows at enqueue.
 * Accepts only pure structured inputs — no SQL text, client factories, or
 * callback injection surfaces.
 *
 * This module owns authorization rechecks, the complete enqueue lock set,
 * precondition capture, late server ID minting, and atomic persistence. Source
 * parsing, worker replay, and plugin caller cutover remain outside this slice.
 */
import crypto from 'node:crypto'
import {
  buildLegacyImportExecutionPlanPackageV1,
  computeLegacyImportGroupStateFingerprintV1,
  computeLegacyImportRecordPreconditionFingerprintV1,
  computeLegacyImportChunkVectorDigestV1,
  computeLegacyImportPlanDigestV1,
  computeLegacyImportSourceOrdinalDigestV1,
  parseLegacyImportExecutionPlanManifestV1,
  parseLegacyImportPublicJobEnvelopeV1,
  reassembleLegacyImportPlanChunksV1,
  sha256HexOfCanonicalJsonV1,
  type AttendanceLegacyOperationalBranchV1,
  type LegacyImportExecutionPlanChunkV1,
  type LegacyImportExecutionPlanManifestV1,
  type LegacyImportGroupEffectPlanV1,
  type LegacyImportGroupEffectPlacementV1,
  type LegacyImportItemPlanV1,
  type LegacyImportPublicJobEnvelopeV1,
  type LegacyImportRecordWritePlanV1,
  AttendanceLegacyExecutionPlanError,
} from './w4c3a-legacy-execution-plan'
import type {
  AttendanceW4TransactionClientV1,
  VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import {
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceImportReservationLocksV1,
  acquireAttendanceOperationalBulkTargetLockV1,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  requireVerifiedAttendanceOperationIdentityV1,
  requireVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  recheckAttendanceActorLivenessInTransactionV1,
  requireAuthorizedCapabilityForEntrypointV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
  type AttendanceOperationItemFingerprintEntryV1,
} from './w4c0-fingerprints'

export class AttendanceLegacyPlanEnqueueError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyPlanEnqueueError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyPlanEnqueueError(code)
}

export type AttendanceLegacyImportJobInsertV1 = {
  readonly jobId: string
  readonly orgId: string
  readonly batchId: string
  readonly createdBy: string
  readonly idempotencyKey: string | null
  readonly total: number
  readonly payload: LegacyImportPublicJobEnvelopeV1
  readonly w4Entrypoint: 'import_batch'
  readonly w4BatchCommandId: string
  readonly w4SourceKind: 'import_batch'
  readonly w4SourceRef: string
  readonly w4ActorId: string
  readonly w4ActorPosture: string
  readonly w4TokenSubjectUserId: string | null
  readonly w4CommandFingerprint: string
  readonly w4AcceptedWritePosture: string
  readonly w4ItemCount: number
  readonly w4ItemSequenceFingerprint: string
  readonly w4ItemSetFingerprint: string
  readonly w4IdentityProofVector: unknown
  readonly w4DistinctTargetCount: number
  readonly w4OperationalBranch: AttendanceLegacyOperationalBranchV1
  readonly w4LegacyInputFingerprint: string
  readonly w4LegacyPlanDigest: string
}

export type PersistAttendanceLegacyImportPlanEnqueueInputV1 = {
  readonly job: AttendanceLegacyImportJobInsertV1
  /** Fully digests-bound manifest (or seed that will be re-validated). */
  readonly manifest: LegacyImportExecutionPlanManifestV1
  readonly chunks: readonly LegacyImportExecutionPlanChunkV1[]
}

export type PersistAttendanceLegacyImportPlanEnqueueResultV1 = {
  readonly jobId: string
  readonly planDigest: string
  readonly chunkCount: number
}

export type LegacyImportItemDraftV1 =
  | Omit<
      Extract<LegacyImportItemPlanV1, { kind: 'apply' }>,
      'itemId' | 'recordWriteRef'
    >
  | Omit<Extract<LegacyImportItemPlanV1, { kind: 'skip' }>, 'itemId'>

export type LegacyImportRecordWriteDraftV1 = Omit<
  LegacyImportRecordWritePlanV1,
  | 'recordWriteId'
  | 'targetRevision'
  | 'existingRecordPreconditionFingerprint'
  | 'expectedSourceOwnership'
  | 'recordId'
>

export type LegacyImportGroupEffectDraftV1 =
  | (Omit<
      Extract<LegacyImportGroupEffectPlanV1, { kind: 'ensure_group' }>,
      'groupId'
    > & {
      readonly firstSourceOrdinal: number
    })
  | (Omit<
      Extract<LegacyImportGroupEffectPlanV1, { kind: 'ensure_member' }>,
      'memberId'
    > & {
      readonly firstSourceOrdinal: number
    })

export type AttendanceLegacyImportJobSeedV1 = Omit<
  AttendanceLegacyImportJobInsertV1,
  'jobId' | 'w4LegacyPlanDigest'
>

export type LegacyImportExecutionPlanManifestSeedV1 = Omit<
  LegacyImportExecutionPlanManifestV1,
  | 'jobId'
  | 'identityProofVectorDigest'
  | 'groupRevision'
  | 'groupStateFingerprint'
  | 'sourceOrdinalDigest'
  | 'chunkVectorDigest'
>

export type ReserveAttendanceLegacyImportPlanJobInputV1 = {
  readonly batchIdentity: unknown
  readonly itemIdentities: ReadonlyArray<{
    readonly identity: unknown
    readonly commandFingerprint: string
  }>
  readonly job: AttendanceLegacyImportJobSeedV1
  readonly manifestSeed: LegacyImportExecutionPlanManifestSeedV1
  readonly items: readonly LegacyImportItemDraftV1[]
  readonly recordWrites: readonly LegacyImportRecordWriteDraftV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectDraftV1[]
}

export type ReserveAttendanceLegacyImportPlanJobResultV1 =
  | PersistAttendanceLegacyImportPlanEnqueueResultV1 & {
      readonly kind: 'created'
    }
  | {
      readonly kind: 'existing'
      readonly jobId: string
      readonly status: string
    }

function requireLowerHex64(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(code)
  return value
}

function privateExecutorCongruent(
  row: Record<string, unknown>,
  job: AttendanceLegacyImportJobSeedV1,
): boolean {
  try {
    return (
      row.w4_actor_id === job.w4ActorId &&
      row.w4_actor_posture === job.w4ActorPosture &&
      ((row.w4_token_subject_user_id as string | null) ?? null) ===
        (job.w4TokenSubjectUserId ?? null) &&
      row.created_by === job.createdBy &&
      row.w4_source_ref === job.w4SourceRef &&
      row.w4_command_fingerprint === job.w4CommandFingerprint &&
      row.w4_accepted_write_posture === job.w4AcceptedWritePosture &&
      Number(row.w4_item_count) === job.w4ItemCount &&
      row.w4_item_sequence_fingerprint === job.w4ItemSequenceFingerprint &&
      row.w4_item_set_fingerprint === job.w4ItemSetFingerprint &&
      canonicalAttendanceJsonV1(row.w4_identity_proof_vector) ===
        canonicalAttendanceJsonV1(job.w4IdentityProofVector) &&
      Number(row.w4_distinct_target_count) === job.w4DistinctTargetCount &&
      row.w4_operational_branch === job.w4OperationalBranch &&
      row.w4_legacy_input_fingerprint === job.w4LegacyInputFingerprint
    )
  } catch {
    return false
  }
}

async function requireReplayBatchCongruence(
  trx: AttendanceW4TransactionClientV1,
  job: AttendanceLegacyImportJobSeedV1,
  manifest: LegacyImportExecutionPlanManifestSeedV1,
): Promise<void> {
  const batch = manifest.batch
  if (batch.kind !== 'idempotent_replay') {
    fail('W4C3A_ENQUEUE_REPLAY_BATCH_INVALID')
  }
  const rows = await trx.query(
    `SELECT id::text AS id, row_count, status, meta
       FROM attendance_import_batches
      WHERE org_id = $1 AND idempotency_key = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 2
      FOR UPDATE`,
    [job.orgId, batch.idempotencyKey],
  )
  if (rows.rows.length !== 1) fail('W4C3A_ENQUEUE_REPLAY_BATCH_CHANGED')
  const row = rows.rows[0] as Record<string, unknown>
  if (
    row.id !== batch.replayBatchId ||
    row.status !== 'committed' ||
    Number(row.row_count) !== batch.totalRowCount
  ) {
    fail('W4C3A_ENQUEUE_REPLAY_BATCH_CHANGED')
  }
  const counts = await trx.query(
    `SELECT
       COUNT(*) FILTER (WHERE record_id IS NOT NULL)::int AS imported,
       COUNT(*) FILTER (WHERE record_id IS NULL)::int AS skipped
     FROM attendance_import_items
     WHERE batch_id = $1::uuid AND org_id = $2`,
    [batch.replayBatchId, job.orgId],
  )
  const countRow = (counts.rows[0] ?? {}) as Record<string, unknown>
  if (
    Number(countRow.imported ?? 0) !== batch.importedCount ||
    Number(countRow.skipped ?? 0) !== batch.skippedCount
  ) {
    fail('W4C3A_ENQUEUE_REPLAY_BATCH_CHANGED')
  }
  const meta = row.meta ?? {}
  const metaObject =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : Object.create(null)
  if (
    metaObject.engine !== batch.engine ||
    metaObject.recordUpsertStrategy !== batch.recordUpsertStrategy ||
    canonicalAttendanceJsonV1(meta) !== canonicalAttendanceJsonV1(batch.metadata)
  ) {
    fail('W4C3A_ENQUEUE_REPLAY_BATCH_CHANGED')
  }
  const digest = sha256HexOfCanonicalJsonV1({
    replayBatchId: batch.replayBatchId,
    totalRowCount: batch.totalRowCount,
    importedCount: batch.importedCount,
    skippedCount: batch.skippedCount,
    engine: batch.engine,
    recordUpsertStrategy: batch.recordUpsertStrategy,
    metadata: batch.metadata,
    idempotencyKey: batch.idempotencyKey,
    requesterVisibility: { kind: 'org' },
  })
  if (digest !== batch.replayPreconditionDigest) {
    fail('W4C3A_ENQUEUE_REPLAY_BATCH_CHANGED')
  }
}

async function recheckAttendanceFullImportAuthorizationInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  auth: AuthorizedAttendanceWriteContextV1,
): Promise<void> {
  await recheckAttendanceActorLivenessInTransactionV1(trx, auth)
  const permission = await trx.query(
    `SELECT 1
       WHERE EXISTS (
         SELECT 1
           FROM user_roles
          WHERE user_id = $1 AND role_id = 'admin'
       )
       OR EXISTS (
         SELECT 1
           FROM user_permissions
          WHERE user_id = $1
            AND permission_code IN ('attendance:import', 'attendance:admin')
       )
       OR EXISTS (
         SELECT 1
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
            AND rp.permission_code IN ('attendance:import', 'attendance:admin')
       )
       LIMIT 1`,
    [auth.actorId],
  )
  if (permission.rows.length !== 1) {
    fail('W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED')
  }
}

function validateAttendanceLegacyImportPlanEnqueuePackageV1(
  input: PersistAttendanceLegacyImportPlanEnqueueInputV1,
): {
  readonly job: AttendanceLegacyImportJobInsertV1
  readonly envelope: LegacyImportPublicJobEnvelopeV1
  readonly manifest: LegacyImportExecutionPlanManifestV1
  readonly planDigest: string
  readonly reassembled: ReturnType<typeof reassembleLegacyImportPlanChunksV1>
} {
  if (typeof input !== 'object' || input === null) {
    fail('W4C3A_ENQUEUE_INPUT_INVALID')
  }
  if (
    'sql' in (input as object) ||
    'callback' in (input as object) ||
    'client' in (input as object)
  ) {
    fail('W4C3A_ENQUEUE_INJECTION_REJECTED')
  }
  const job = input.job
  const envelope = parseLegacyImportPublicJobEnvelopeV1(job.payload)
  const manifest = parseLegacyImportExecutionPlanManifestV1(input.manifest)
  if (manifest.jobId !== job.jobId) fail('W4C3A_ENQUEUE_JOB_ID_MISMATCH')
  if (manifest.orgId !== job.orgId) fail('W4C3A_ENQUEUE_ORG_MISMATCH')
  if (manifest.batchId !== job.batchId || manifest.batchId !== job.w4BatchCommandId) {
    fail('W4C3A_ENQUEUE_BATCH_MISMATCH')
  }
  if (manifest.sourceKind !== job.w4SourceKind) fail('W4C3A_ENQUEUE_SOURCE_KIND_MISMATCH')
  if (manifest.sourceRef !== job.w4SourceRef) fail('W4C3A_ENQUEUE_SOURCE_REF_MISMATCH')
  if (manifest.createdBy !== job.createdBy) fail('W4C3A_ENQUEUE_CREATED_BY_MISMATCH')
  if (manifest.actorId !== job.w4ActorId) fail('W4C3A_ENQUEUE_ACTOR_MISMATCH')
  if (manifest.actorPosture !== job.w4ActorPosture) fail('W4C3A_ENQUEUE_ACTOR_POSTURE_MISMATCH')
  if ((manifest.tokenSubjectUserId ?? null) !== (job.w4TokenSubjectUserId ?? null)) {
    fail('W4C3A_ENQUEUE_TOKEN_SUBJECT_MISMATCH')
  }
  if (manifest.acceptedWritePosture !== job.w4AcceptedWritePosture) {
    fail('W4C3A_ENQUEUE_POSTURE_MISMATCH')
  }
  if (manifest.commandFingerprint !== job.w4CommandFingerprint) {
    fail('W4C3A_ENQUEUE_COMMAND_FP_MISMATCH')
  }
  if (manifest.legacyInputFingerprint !== job.w4LegacyInputFingerprint) {
    fail('W4C3A_ENQUEUE_LEGACY_INPUT_FP_MISMATCH')
  }
  if (manifest.operationalBranch !== job.w4OperationalBranch) {
    fail('W4C3A_ENQUEUE_BRANCH_MISMATCH')
  }
  if (manifest.w4ItemCount !== job.w4ItemCount) fail('W4C3A_ENQUEUE_ITEM_COUNT_MISMATCH')
  if (manifest.w4DistinctTargetCount !== job.w4DistinctTargetCount) {
    fail('W4C3A_ENQUEUE_TARGET_COUNT_MISMATCH')
  }
  if (manifest.w4ItemSequenceFingerprint !== job.w4ItemSequenceFingerprint) {
    fail('W4C3A_ENQUEUE_SEQ_FP_MISMATCH')
  }
  if (manifest.w4ItemSetFingerprint !== job.w4ItemSetFingerprint) {
    fail('W4C3A_ENQUEUE_SET_FP_MISMATCH')
  }
  if (envelope.idempotencyKey !== job.idempotencyKey) {
    fail('W4C3A_ENQUEUE_IDEMPOTENCY_KEY_MISMATCH')
  }
  if (manifest.batch.idempotencyKey !== (job.idempotencyKey ?? null)) {
    fail('W4C3A_ENQUEUE_BATCH_IDEMPOTENCY_KEY_MISMATCH')
  }

  const reassembled = reassembleLegacyImportPlanChunksV1(
    input.chunks,
    manifest.sourceRowCount,
  )
  if (manifest.operationalBranch === 'operational_only_idempotent_replay') {
    if (input.chunks.length !== 0) fail('W4C3A_ENQUEUE_REPLAY_CHUNKS_NONEMPTY')
    if (
      job.total < 1 ||
      manifest.batch.kind !== 'idempotent_replay' ||
      job.total !== manifest.batch.totalRowCount
    ) {
      fail('W4C3A_ENQUEUE_REPLAY_TOTAL_INVALID')
    }
  } else if (
    job.total !== manifest.sourceRowCount ||
    input.chunks.length < 1
  ) {
    fail(
      job.total !== manifest.sourceRowCount
        ? 'W4C3A_ENQUEUE_TOTAL_MISMATCH'
        : 'W4C3A_ENQUEUE_CHUNKS_MISSING',
    )
  }

  const planDigest = requireLowerHex64(
    job.w4LegacyPlanDigest,
    'W4C3A_ENQUEUE_PLAN_DIGEST_INVALID',
  )
  const descriptors = input.chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    firstSourceOrdinal: chunk.firstSourceOrdinal,
    sourceRowCount: chunk.sourceRowCount,
    chunkDigest: chunk.chunkDigest,
  }))
  if (computeLegacyImportChunkVectorDigestV1(descriptors) !== manifest.chunkVectorDigest) {
    fail('W4C3A_ENQUEUE_CHUNK_VECTOR_DIGEST_MISMATCH')
  }
  if (
    computeLegacyImportSourceOrdinalDigestV1(reassembled.items) !==
    manifest.sourceOrdinalDigest
  ) {
    fail('W4C3A_ENQUEUE_SOURCE_ORDINAL_DIGEST_MISMATCH')
  }
  if (
    computeLegacyImportPlanDigestV1({
      manifest,
      items: reassembled.items,
      recordWrites: reassembled.recordWrites,
      groupEffects: reassembled.groupEffects,
    }) !== planDigest
  ) {
    fail('W4C3A_ENQUEUE_PLAN_DIGEST_MISMATCH')
  }
  if (
    manifest.batch.engine !== envelope.__importEngine ||
    manifest.batch.recordUpsertStrategy !== envelope.recordUpsertStrategy ||
    (
      manifest.batch.kind === 'normal' &&
      manifest.batch.itemsInsertStrategy !== envelope.itemsInsertStrategy
    )
  ) {
    fail('W4C3A_ENQUEUE_PUBLIC_ENVELOPE_MISMATCH')
  }
  return { job, envelope, manifest, planDigest, reassembled }
}

function canonicalDateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  fail('W4C3A_ENQUEUE_RECORD_PRECONDITION_INVALID')
}

function canonicalInstantValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) {
    fail('W4C3A_ENQUEUE_RECORD_PRECONDITION_INVALID')
  }
  return parsed.toISOString()
}

type FrozenAttendanceRecordWriteDraftV1 = Readonly<{
  readonly draft: LegacyImportRecordWriteDraftV1
  readonly targetRevision: number
  readonly preconditionFingerprint: string
  readonly expectedSourceOwnership: string | null
  readonly existingRecordId: string | null
}>

async function lockAndFreezeAttendanceRecordPreconditionsV1(
  trx: AttendanceW4TransactionClientV1,
  org: ReturnType<typeof requireVerifiedAttendanceOrgIdentityV1>,
  branch: AttendanceLegacyOperationalBranchV1,
  recordWrites: readonly LegacyImportRecordWriteDraftV1[],
): Promise<readonly FrozenAttendanceRecordWriteDraftV1[]> {
  if (branch === 'strict_targeted') {
    const targets = recordWrites.map((write) =>
      createVerifiedAttendanceCalculationTargetIdentityV1({
        org,
        userId: write.userId,
        workDate: write.workDate,
      }),
    )
    await acquireAttendanceCalculationTargetLocks(trx, targets)
  } else if (branch === 'operational_only_batch_limit') {
    await acquireAttendanceOperationalBulkTargetLockV1(
      trx,
      parseCanonicalAttendanceRolloutOrgKeyV1(org.orgId),
    )
  } else if (recordWrites.length > 0) {
    fail('W4C3A_ENQUEUE_BRANCH_TARGET_SHAPE_INVALID')
  }
  if (recordWrites.length === 0) return Object.freeze([])

  const userIds = recordWrites.map((write) => write.userId)
  const workDates = recordWrites.map((write) => write.workDate)
  await trx.query(
    `INSERT INTO attendance_record_target_revisions (
       org_id, user_id, work_date, revision, created_at, updated_at
     )
     SELECT $1, target.user_id, target.work_date, 0, now(), now()
       FROM unnest($2::text[], $3::date[]) AS target(user_id, work_date)
     ON CONFLICT (org_id, user_id, work_date) DO NOTHING`,
    [org.orgId, userIds, workDates],
  )
  const revisionRows = await trx.query(
    `SELECT revision.user_id, revision.work_date::text AS work_date,
            revision.revision::text AS revision
       FROM attendance_record_target_revisions revision
       JOIN unnest($2::text[], $3::date[]) AS target(user_id, work_date)
         ON target.user_id = revision.user_id
        AND target.work_date = revision.work_date
      WHERE revision.org_id = $1
      ORDER BY revision.user_id, revision.work_date
      FOR SHARE OF revision`,
    [org.orgId, userIds, workDates],
  )
  const revisionByTarget = new Map<string, number>()
  for (const row of revisionRows.rows as Array<Record<string, unknown>>) {
    revisionByTarget.set(
      `${String(row.user_id)}\u0000${canonicalDateValue(row.work_date)}`,
      Number(row.revision),
    )
  }
  if (revisionByTarget.size !== recordWrites.length) {
    fail('W4C3A_ENQUEUE_RECORD_REVISION_MISSING')
  }

  const recordRows = await trx.query(
    `SELECT record.id::text AS id, record.org_id, record.user_id,
            record.work_date::text AS work_date, record.first_in_at,
            record.last_out_at, record.work_minutes, record.late_minutes,
            record.early_leave_minutes, record.status, record.is_workday,
            record.meta, record.source_batch_id::text AS source_batch_id
       FROM attendance_records record
       JOIN unnest($2::text[], $3::date[]) AS target(user_id, work_date)
         ON target.user_id = record.user_id
        AND target.work_date = record.work_date
      WHERE record.org_id = $1
      ORDER BY record.user_id, record.work_date`,
    [org.orgId, userIds, workDates],
  )
  const recordByTarget = new Map<string, Record<string, unknown>>()
  for (const row of recordRows.rows as Array<Record<string, unknown>>) {
    recordByTarget.set(
      `${String(row.user_id)}\u0000${canonicalDateValue(row.work_date)}`,
      row,
    )
  }

  const frozen: FrozenAttendanceRecordWriteDraftV1[] = []
  for (const write of recordWrites) {
    const key = `${write.userId}\u0000${write.workDate}`
    const targetRevision = revisionByTarget.get(key)
    if (targetRevision === undefined) fail('W4C3A_ENQUEUE_RECORD_REVISION_MISSING')
    const row = recordByTarget.get(key)
    const precondition =
      row === undefined
        ? {
            exists: false,
            id: null,
            orgId: null,
            userId: null,
            workDate: null,
            firstInAt: null,
            lastOutAt: null,
            workMinutes: null,
            lateMinutes: null,
            earlyLeaveMinutes: null,
            status: null,
            isWorkday: null,
            meta: null,
            sourceBatchId: null,
          }
        : {
            exists: true,
            id: String(row.id),
            orgId: String(row.org_id),
            userId: String(row.user_id),
            workDate: canonicalDateValue(row.work_date),
            firstInAt: canonicalInstantValue(row.first_in_at),
            lastOutAt: canonicalInstantValue(row.last_out_at),
            workMinutes:
              row.work_minutes === null ? null : Number(row.work_minutes),
            lateMinutes:
              row.late_minutes === null ? null : Number(row.late_minutes),
            earlyLeaveMinutes:
              row.early_leave_minutes === null
                ? null
                : Number(row.early_leave_minutes),
            status: row.status === null ? null : String(row.status),
            isWorkday:
              row.is_workday === null ? null : Boolean(row.is_workday),
            meta: row.meta ?? null,
            sourceBatchId:
              row.source_batch_id === null ? null : String(row.source_batch_id),
          }
    frozen.push(
      Object.freeze({
        draft: write,
        targetRevision,
        preconditionFingerprint:
          computeLegacyImportRecordPreconditionFingerprintV1(precondition),
        expectedSourceOwnership:
          row === undefined || row.source_batch_id === null
            ? null
            : String(row.source_batch_id),
        existingRecordId: row === undefined ? null : String(row.id),
      }),
    )
  }
  return Object.freeze(frozen)
}

type FrozenAttendanceGroupReadSetV1 = Readonly<{
  readonly revision: number | null
  readonly groups: readonly Readonly<{
    readonly id: string
    readonly orgId: string
    readonly name: string
    readonly code: string | null
    readonly timezone: string
    readonly ruleSetId: string | null
  }>[]
  readonly groupIdByRef: ReadonlyMap<string, string>
  readonly existingMemberships: ReadonlySet<string>
}>

async function lockAndFreezeAttendanceGroupReadSetV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  groupEffects: readonly LegacyImportGroupEffectDraftV1[],
): Promise<FrozenAttendanceGroupReadSetV1> {
  if (groupEffects.length === 0) {
    return Object.freeze({
      revision: null,
      groups: Object.freeze([]),
      groupIdByRef: new Map<string, string>(),
      existingMemberships: new Set<string>(),
    })
  }

  await trx.query(
    `INSERT INTO attendance_group_effect_revisions (
       org_id, revision, created_at, updated_at
     ) VALUES ($1, 0, now(), now())
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId],
  )
  const revisionResult = await trx.query(
    `SELECT revision::text AS revision
       FROM attendance_group_effect_revisions
      WHERE org_id = $1
      FOR SHARE`,
    [orgId],
  )
  const revisionValue =
    revisionResult.rows.length === 1
      ? Number((revisionResult.rows[0] as Record<string, unknown>).revision)
      : Number.NaN
  if (
    revisionResult.rows.length !== 1 ||
    !Number.isSafeInteger(revisionValue) ||
    revisionValue < 0
  ) {
    fail('W4C3A_ENQUEUE_GROUP_REVISION_INVALID')
  }
  const revision = revisionValue

  const ensureGroups = groupEffects.filter(
    (
      effect,
    ): effect is Extract<
      LegacyImportGroupEffectDraftV1,
      { kind: 'ensure_group' }
    > =>
      effect.kind === 'ensure_group',
  )
  const ensureMembers = groupEffects.filter(
    (
      effect,
    ): effect is Extract<
      LegacyImportGroupEffectDraftV1,
      { kind: 'ensure_member' }
    > =>
      effect.kind === 'ensure_member',
  )
  const candidateIds = ensureMembers
    .map((effect) => effect.groupRef)
    .filter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
    )
  const candidateNames = [
    ...ensureGroups.map((effect) => effect.normalizedName),
    ...ensureMembers.map((effect) => effect.groupRef.trim().toLowerCase()),
  ]
  const groupsResult = await trx.query(
    `SELECT id::text AS id, org_id, name, code, timezone,
            rule_set_id::text AS rule_set_id
       FROM attendance_groups
      WHERE org_id = $1
        AND (
          id::text = ANY($2::text[]) OR
          lower(btrim(name)) = ANY($3::text[])
        )
      ORDER BY id`,
    [orgId, candidateIds, candidateNames],
  )
  const groupRows = groupsResult.rows as Array<Record<string, unknown>>
  const groupById = new Map<string, Record<string, unknown>>()
  const groupByName = new Map<string, Record<string, unknown>>()
  for (const row of groupRows) {
    groupById.set(String(row.id), row)
    groupByName.set(String(row.name).trim().toLowerCase(), row)
  }

  const resolvedGroupRef = new Map<string, string>()
  for (const effect of ensureGroups) {
    const existingByName = groupByName.get(effect.normalizedName)
    if (existingByName !== undefined) {
      resolvedGroupRef.set(effect.normalizedName, String(existingByName.id))
    }
  }
  for (const [id] of groupById) resolvedGroupRef.set(id, id)
  for (const [name, row] of groupByName) {
    resolvedGroupRef.set(name, String(row.id))
  }

  const memberGroups: string[] = []
  const memberUsers: string[] = []
  for (const effect of ensureMembers) {
    const resolvedId =
      resolvedGroupRef.get(effect.groupRef) ??
      resolvedGroupRef.get(effect.groupRef.trim().toLowerCase())
    if (resolvedId !== undefined) {
      memberGroups.push(resolvedId)
      memberUsers.push(effect.userId)
    }
  }
  const membershipResult =
    memberGroups.length === 0
      ? { rows: [] as unknown[] }
      : await trx.query(
          `SELECT member.group_id::text AS group_id, member.user_id
             FROM attendance_group_members member
             JOIN unnest($2::uuid[], $3::text[]) AS target(group_id, user_id)
               ON target.group_id = member.group_id
              AND target.user_id = member.user_id
            WHERE member.org_id = $1
            ORDER BY member.group_id, member.user_id`,
          [orgId, memberGroups, memberUsers],
        )
  const existingMemberships = new Set(
    (membershipResult.rows as Array<Record<string, unknown>>).map(
      (row) => `${String(row.group_id)}\u0000${String(row.user_id)}`,
    ),
  )
  const fingerprint = computeLegacyImportGroupStateFingerprintV1({
    groups: groupRows.map((row) => ({
      id: String(row.id),
      orgId: String(row.org_id),
      name: String(row.name),
      code: row.code === null ? null : String(row.code),
      timezone: String(row.timezone),
      ruleSetId:
        row.rule_set_id === null ? null : String(row.rule_set_id),
    })),
    memberships: [],
  })
  // Prove the loaded group rows themselves are structurally canonical before
  // any late server ID is minted. The final fingerprint, including intended
  // membership existence bits and missing planned group IDs, is computed only
  // after minting in the caller below.
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    fail('W4C3A_ENQUEUE_GROUP_PRECONDITION_INVALID')
  }
  return Object.freeze({
    revision,
    groups: Object.freeze(
      groupRows.map((row) =>
        Object.freeze({
          id: String(row.id),
          orgId: String(row.org_id),
          name: String(row.name),
          code: row.code === null ? null : String(row.code),
          timezone: String(row.timezone),
          ruleSetId:
            row.rule_set_id === null ? null : String(row.rule_set_id),
        }),
      ),
    ),
    groupIdByRef: resolvedGroupRef,
    existingMemberships,
  })
}

function deterministicValidationUuid(label: string): string {
  const bytes = crypto.createHash('sha256').update(label, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`
}

function recordTargetRef(
  recordWrite: Pick<LegacyImportRecordWriteDraftV1, 'orgId' | 'userId' | 'workDate'>,
): string {
  return canonicalAttendanceJsonV1([
    recordWrite.orgId,
    recordWrite.userId,
    recordWrite.workDate,
  ])
}

function validateAttendanceLegacyImportPlanDraftBeforeSqlV1(
  input: ReserveAttendanceLegacyImportPlanJobInputV1,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(input.itemIdentities) ||
    !Array.isArray(input.items) ||
    !Array.isArray(input.recordWrites) ||
    !Array.isArray(input.groupEffects)
  ) {
    fail('W4C3A_ENQUEUE_DRAFT_INVALID')
  }
  const placeholderRecordIdByTarget = new Map<string, string>()
  const recordWrites = input.recordWrites.map((draft, index) => {
    const targetRef = recordTargetRef(draft)
    if (placeholderRecordIdByTarget.has(targetRef)) {
      fail('W4C3A_ENQUEUE_DRAFT_INVALID')
    }
    const recordWriteId = deterministicValidationUuid(`record-write:${index}`)
    placeholderRecordIdByTarget.set(targetRef, recordWriteId)
    return {
      ...draft,
      recordWriteId,
      targetRevision: 0,
      existingRecordPreconditionFingerprint: '0'.repeat(64),
      expectedSourceOwnership: null,
      recordId: deterministicValidationUuid(`record:${index}`),
    }
  })
  const items = input.items.map((draft, index): LegacyImportItemPlanV1 => {
    const itemId = deterministicValidationUuid(`item:${index}`)
    if (draft.kind === 'skip') return { ...draft, itemId }
    const recordWriteRef = placeholderRecordIdByTarget.get(draft.targetRef)
    if (recordWriteRef === undefined) fail('W4C3A_ENQUEUE_DRAFT_INVALID')
    return { ...draft, itemId, recordWriteRef }
  })
  const seenGroups = new Set<string>()
  const seenMembers = new Set<string>()
  const groupEffects: LegacyImportGroupEffectPlanV1[] = []
  const groupEffectPlacements: LegacyImportGroupEffectPlacementV1[] = []
  input.groupEffects.forEach((draft, index) => {
    const effectId = deterministicValidationUuid(`group-effect:${index}`)
    if (draft.kind === 'ensure_group') {
      if (seenGroups.has(draft.normalizedName)) {
        fail('W4C3A_ENQUEUE_DRAFT_INVALID')
      }
      seenGroups.add(draft.normalizedName)
      groupEffects.push({
        kind: 'ensure_group',
        groupId: effectId,
        normalizedName: draft.normalizedName,
        code: draft.code,
        timezone: draft.timezone,
        ruleSetId: draft.ruleSetId,
      })
    } else {
      const key = `${draft.groupRef.trim().toLowerCase()}\u0000${draft.userId}`
      if (seenMembers.has(key)) fail('W4C3A_ENQUEUE_DRAFT_INVALID')
      seenMembers.add(key)
      groupEffects.push({
        kind: 'ensure_member',
        memberId: effectId,
        groupRef: draft.groupRef,
        userId: draft.userId,
      })
    }
    groupEffectPlacements.push({
      effectId,
      firstSourceOrdinal: draft.firstSourceOrdinal,
    })
  })
  const placeholderJobId = deterministicValidationUuid('job')
  const packageInput = buildAttendanceLegacyImportPlanEnqueuePackageV1({
    job: {
      ...input.job,
      jobId: placeholderJobId,
    },
    manifestSeed: {
      ...input.manifestSeed,
      jobId: placeholderJobId,
      identityProofVectorDigest: '0'.repeat(64),
      groupRevision: groupEffects.length === 0 ? null : 0,
      groupStateFingerprint:
        groupEffects.length === 0 ? null : '0'.repeat(64),
    },
    items,
    recordWrites,
    groupEffects,
    groupEffectPlacements,
  })
  validateAttendanceLegacyImportPlanEnqueuePackageV1(packageInput)
}

function materializeAttendanceLegacyGroupEffectsV1(
  orgId: string,
  drafts: readonly LegacyImportGroupEffectDraftV1[],
  readSet: FrozenAttendanceGroupReadSetV1,
): {
  readonly effects: readonly LegacyImportGroupEffectPlanV1[]
  readonly placements: readonly LegacyImportGroupEffectPlacementV1[]
  readonly revision: number | null
  readonly fingerprint: string | null
} {
  if (drafts.length === 0) {
    return Object.freeze({
      effects: Object.freeze([]),
      placements: Object.freeze([]),
      revision: null,
      fingerprint: null,
    })
  }
  if (readSet.revision === null) fail('W4C3A_ENQUEUE_GROUP_REVISION_INVALID')
  const groupIdByRef = new Map(readSet.groupIdByRef)
  const effects: LegacyImportGroupEffectPlanV1[] = []
  const placements: LegacyImportGroupEffectPlacementV1[] = []
  for (const draft of drafts) {
    if (draft.kind !== 'ensure_group') continue
    const groupId = groupIdByRef.get(draft.normalizedName) ?? crypto.randomUUID()
    groupIdByRef.set(draft.normalizedName, groupId)
    effects.push({
      kind: 'ensure_group',
      groupId,
      normalizedName: draft.normalizedName,
      code: draft.code,
      timezone: draft.timezone,
      ruleSetId: draft.ruleSetId,
    })
    placements.push({
      effectId: groupId,
      firstSourceOrdinal: draft.firstSourceOrdinal,
    })
  }
  const memberships: Array<{
    readonly orgId: string
    readonly groupId: string
    readonly userId: string
    readonly exists: boolean
  }> = []
  for (const draft of drafts) {
    if (draft.kind !== 'ensure_member') continue
    const normalizedRef = draft.groupRef.trim().toLowerCase()
    const groupId =
      groupIdByRef.get(draft.groupRef) ?? groupIdByRef.get(normalizedRef)
    if (groupId === undefined) fail('W4C3A_ENQUEUE_GROUP_REFERENCE_INVALID')
    const memberId = crypto.randomUUID()
    effects.push({
      kind: 'ensure_member',
      memberId,
      groupRef: draft.groupRef,
      userId: draft.userId,
    })
    placements.push({
      effectId: memberId,
      firstSourceOrdinal: draft.firstSourceOrdinal,
    })
    memberships.push({
      orgId,
      groupId,
      userId: draft.userId,
      exists: readSet.existingMemberships.has(
        `${groupId}\u0000${draft.userId}`,
      ),
    })
  }
  return Object.freeze({
    effects: Object.freeze(effects),
    placements: Object.freeze(placements),
    revision: readSet.revision,
    fingerprint: computeLegacyImportGroupStateFingerprintV1({
      groups: readSet.groups,
      memberships,
    }),
  })
}

/**
 * Canonical durable P07 reservation. This is the only W4C-3a path that may
 * call the job/manifest/chunk insert seam: it verifies authorization and
 * identities, acquires the complete class-`10` set in one ordering domain,
 * rechecks operation/job/legacy-batch ownership, then persists the closed set.
 */
export async function reserveAttendanceLegacyImportPlanJobV1(
  trx: AttendanceW4TransactionClientV1,
  authorization: unknown,
  input: ReserveAttendanceLegacyImportPlanJobInputV1,
): Promise<ReserveAttendanceLegacyImportPlanJobResultV1> {
  validateAttendanceLegacyImportPlanDraftBeforeSqlV1(input)
  const isolationResult = await trx.query(
    `SELECT current_setting('transaction_isolation') AS isolation`,
    [],
  )
  if (
    isolationResult.rows.length !== 1 ||
    (isolationResult.rows[0] as Record<string, unknown>).isolation !==
      'serializable'
  ) {
    fail('W4C3A_ENQUEUE_SERIALIZABLE_REQUIRED')
  }
  const job = input.job
  const manifestSeed = input.manifestSeed

  const batchIdentity = requireVerifiedAttendanceOperationIdentityV1(
    input.batchIdentity,
  )
  if (
    batchIdentity.kind !== 'batch' ||
    batchIdentity.entrypoint !== 'import_batch' ||
    batchIdentity.sourceProof.sourceKind !== 'import_batch'
  ) {
    fail('W4C3A_ENQUEUE_BATCH_IDENTITY_INVALID')
  }
  const org = requireVerifiedAttendanceOrgIdentityV1(batchIdentity.org)
  const auth = requireAuthorizedCapabilityForEntrypointV1(
    authorization,
    'import_batch',
  )
  if (
    auth.orgId !== org.orgId ||
    job.orgId !== org.orgId ||
    manifestSeed.orgId !== org.orgId ||
    job.batchId !== batchIdentity.id ||
    manifestSeed.batchId !== batchIdentity.id ||
    job.w4BatchCommandId !== batchIdentity.id ||
    job.w4Entrypoint !== batchIdentity.entrypoint ||
    manifestSeed.sourceKind !== batchIdentity.entrypoint ||
    job.w4SourceKind !== batchIdentity.sourceProof.sourceKind ||
    manifestSeed.sourceRef !== auth.sourceRef ||
    job.w4SourceRef !== auth.sourceRef ||
    job.w4ActorId !== auth.actorId ||
    manifestSeed.actorId !== auth.actorId ||
    job.w4ActorPosture !== auth.actorPosture ||
    manifestSeed.actorPosture !== auth.actorPosture ||
    (job.w4TokenSubjectUserId ?? null) !== auth.tokenSubjectUserId ||
    (manifestSeed.tokenSubjectUserId ?? null) !== auth.tokenSubjectUserId ||
    job.w4AcceptedWritePosture !== org.acceptedWritePosture ||
    manifestSeed.acceptedWritePosture !== org.acceptedWritePosture ||
    manifestSeed.createdBy !== job.createdBy ||
    manifestSeed.commandFingerprint !== job.w4CommandFingerprint ||
    manifestSeed.legacyInputFingerprint !== job.w4LegacyInputFingerprint ||
    manifestSeed.operationalBranch !== job.w4OperationalBranch ||
    manifestSeed.w4ItemCount !== job.w4ItemCount ||
    manifestSeed.w4DistinctTargetCount !== job.w4DistinctTargetCount ||
    manifestSeed.w4ItemSequenceFingerprint !==
      job.w4ItemSequenceFingerprint ||
    manifestSeed.w4ItemSetFingerprint !== job.w4ItemSetFingerprint ||
    manifestSeed.batch.idempotencyKey !== job.idempotencyKey
  ) {
    fail('W4C3A_ENQUEUE_IDENTITY_MISMATCH')
  }
  await recheckAttendanceFullImportAuthorizationInTransactionV1(trx, auth)
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(org.orgId)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const currentPosture = await resolveSegmentCalculationPosture(trx, org.orgId)
  const currentOrg = createVerifiedAttendanceOrgIdentityV1({
    orgKey: org.orgId,
    posture: currentPosture,
  })
  if (currentOrg.acceptedWritePosture !== org.acceptedWritePosture) {
    fail('W4C3A_ENQUEUE_POSTURE_CHANGED')
  }

  requireLowerHex64(
    job.w4CommandFingerprint,
    'W4C3A_ENQUEUE_COMMAND_FP_INVALID',
  )
  const itemIdentities: VerifiedAttendanceOperationIdentityV1[] = []
  const fingerprintEntries: AttendanceOperationItemFingerprintEntryV1[] = []
  const proofVector: Array<Record<string, unknown>> = []
  if (manifestSeed.operationalBranch === 'strict_targeted') {
    if (
      !Array.isArray(input.itemIdentities) ||
      input.itemIdentities.length !== job.w4ItemCount
    ) {
      fail('W4C3A_ENQUEUE_ITEM_IDENTITIES_INVALID')
    }
    input.itemIdentities.forEach((item, ordinal) => {
      const identity = requireVerifiedAttendanceOperationIdentityV1(item.identity)
      const proof = identity.sourceProof
      const commandFingerprint = requireLowerHex64(
        item.commandFingerprint,
        'W4C3A_ENQUEUE_ITEM_IDENTITIES_INVALID',
      )
      if (
        identity.kind !== 'item' ||
        identity.org !== batchIdentity.org ||
        identity.entrypoint !== 'import_batch' ||
        proof.sourceRootId !== batchIdentity.id ||
        proof.ordinal !== String(ordinal) ||
        proof.semanticFingerprint === null
      ) {
        fail('W4C3A_ENQUEUE_ITEM_IDENTITIES_INVALID')
      }
      itemIdentities.push(identity)
      fingerprintEntries.push({
        ordinal: proof.ordinal,
        operationId: identity.id,
        commandFingerprint,
      })
      proofVector.push({
        ordinal,
        semanticFingerprint: proof.semanticFingerprint,
        derivedOperationId: identity.id,
        commandFingerprint,
      })
    })
    if (
      computeAttendanceItemSequenceFingerprintV1(fingerprintEntries) !==
        job.w4ItemSequenceFingerprint ||
      computeAttendanceItemSetFingerprintV1(fingerprintEntries) !==
        job.w4ItemSetFingerprint ||
      canonicalAttendanceJsonV1(proofVector) !==
        canonicalAttendanceJsonV1(job.w4IdentityProofVector)
    ) {
      fail('W4C3A_ENQUEUE_ITEM_PROOF_MISMATCH')
    }
  } else if (
    manifestSeed.operationalBranch === 'operational_only_batch_limit'
  ) {
    if (
      !Array.isArray(input.itemIdentities) ||
      input.itemIdentities.length !== job.w4ItemCount ||
      canonicalAttendanceJsonV1(job.w4IdentityProofVector) !== '[]'
    ) {
      fail('W4C3A_ENQUEUE_OPERATIONAL_PROOF_INVALID')
    }
    const applyItems = input.items.filter(
      (
        item,
      ): item is Extract<LegacyImportItemDraftV1, { kind: 'apply' }> =>
        item.kind === 'apply',
    )
    if (applyItems.length !== job.w4ItemCount) {
      fail('W4C3A_ENQUEUE_OPERATIONAL_PROOF_INVALID')
    }
    input.itemIdentities.forEach((item, ordinal) => {
      const identity = requireVerifiedAttendanceOperationIdentityV1(
        item.identity,
      )
      const proof = identity.sourceProof
      const commandFingerprint = requireLowerHex64(
        item.commandFingerprint,
        'W4C3A_ENQUEUE_ITEM_IDENTITIES_INVALID',
      )
      if (
        identity.kind !== 'item' ||
        identity.org !== batchIdentity.org ||
        identity.entrypoint !== 'import_batch' ||
        proof.sourceRootId !== batchIdentity.id ||
        proof.ordinal !== String(ordinal) ||
        proof.semanticFingerprint === null ||
        applyItems[ordinal]?.semanticOrdinal !== ordinal
      ) {
        fail('W4C3A_ENQUEUE_ITEM_IDENTITIES_INVALID')
      }
      fingerprintEntries.push({
        ordinal: proof.ordinal,
        operationId: identity.id,
        commandFingerprint,
      })
    })
    if (
      computeAttendanceItemSequenceFingerprintV1(fingerprintEntries) !==
        job.w4ItemSequenceFingerprint ||
      computeAttendanceItemSetFingerprintV1(fingerprintEntries) !==
        job.w4ItemSetFingerprint
    ) {
      fail('W4C3A_ENQUEUE_ITEM_PROOF_MISMATCH')
    }
  } else {
    if (
      !Array.isArray(input.itemIdentities) ||
      input.itemIdentities.length !== 0 ||
      canonicalAttendanceJsonV1(job.w4IdentityProofVector) !== '[]'
    ) {
      fail('W4C3A_ENQUEUE_OPERATIONAL_PROOF_INVALID')
    }
  }

  const legacyIdempotency =
    job.idempotencyKey === null
      ? null
      : parseCanonicalAttendanceLegacyIdempotencyKeyV1({
          orgId: org.orgId,
          idempotencyKey: job.idempotencyKey,
        })
  if (
    legacyIdempotency !== null &&
    legacyIdempotency.idempotencyKey !== job.idempotencyKey
  ) {
    fail('W4C3A_ENQUEUE_IDEMPOTENCY_KEY_MISMATCH')
  }

  await acquireAttendanceImportReservationLocksV1(
    trx,
    [batchIdentity, ...itemIdentities],
    legacyIdempotency,
  )

  const existingOperations = await trx.query(
    `SELECT 1
       FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = 'import_batch'
        AND (
          batch_command_id = $2::uuid OR
          operation_id = ANY($3::uuid[])
        )
      LIMIT 1`,
    [org.orgId, batchIdentity.id, itemIdentities.map((identity) => identity.id)],
  )
  const existingOperationBatch = await trx.query(
    `SELECT 1
       FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint = 'import_batch'
        AND batch_command_id = $2::uuid
      LIMIT 1`,
    [org.orgId, batchIdentity.id],
  )
  if (
    existingOperations.rows.length > 0 ||
    existingOperationBatch.rows.length > 0
  ) {
    fail('ATTENDANCE_OPERATION_BATCH_CONFLICT')
  }

  const existingJobs = await trx.query(
    `SELECT id::text AS id, status, created_by, idempotency_key,
            w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
            w4_source_ref, w4_command_fingerprint, w4_accepted_write_posture,
            w4_item_count, w4_item_sequence_fingerprint, w4_item_set_fingerprint,
            w4_identity_proof_vector,
            w4_distinct_target_count, w4_operational_branch,
            w4_legacy_input_fingerprint
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version = 1
        AND (
          (w4_entrypoint = 'import_batch' AND w4_batch_command_id = $2::uuid) OR
          ($3::text IS NOT NULL AND idempotency_key = $3)
        )
      ORDER BY id
      FOR UPDATE`,
    [org.orgId, batchIdentity.id, job.idempotencyKey],
  )
  if (existingJobs.rows.length > 1) {
    fail('W4C3A_ENQUEUE_JOB_RESERVATION_CONFLICT')
  }
  if (existingJobs.rows.length === 1) {
    const row = existingJobs.rows[0] as Record<string, unknown>
    const routeIdempotencyReplay =
      job.idempotencyKey !== null && row.idempotency_key === job.idempotencyKey
    const routeReplayCongruent =
      routeIdempotencyReplay &&
      row.w4_operational_branch === job.w4OperationalBranch &&
      row.w4_legacy_input_fingerprint === job.w4LegacyInputFingerprint
    if (
      !routeReplayCongruent &&
      !privateExecutorCongruent(row, job)
    ) {
      fail('W4C3A_ENQUEUE_JOB_RESERVATION_CONFLICT')
    }
    return {
      kind: 'existing',
      jobId: String(row.id),
      status: String(row.status),
    }
  }

  if (
    manifestSeed.operationalBranch ===
    'operational_only_idempotent_replay'
  ) {
    await requireReplayBatchCongruence(trx, job, manifestSeed)
  } else if (job.idempotencyKey !== null) {
    const legacyBatch = await trx.query(
      `SELECT id::text AS id
         FROM attendance_import_batches
        WHERE org_id = $1 AND idempotency_key = $2 AND status = 'committed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [org.orgId, job.idempotencyKey],
    )
    if (legacyBatch.rows.length > 0) {
      fail('W4C3A_ENQUEUE_LEGACY_BATCH_RACE')
    }
  }

  const frozenRecordWrites =
    await lockAndFreezeAttendanceRecordPreconditionsV1(
      trx,
      currentOrg,
      manifestSeed.operationalBranch,
      input.recordWrites,
    )
  const frozenGroupReadSet = await lockAndFreezeAttendanceGroupReadSetV1(
    trx,
    currentOrg.orgId,
    input.groupEffects,
  )

  // Contract step 11: no persisted effect identity exists before the complete
  // class-10/class-11/revision read set above is held and rechecked.
  const jobId = crypto.randomUUID()
  const recordWriteIdByTarget = new Map<string, string>()
  const recordWrites = frozenRecordWrites.map(
    (frozen): LegacyImportRecordWritePlanV1 => {
      const recordWriteId = crypto.randomUUID()
      recordWriteIdByTarget.set(recordTargetRef(frozen.draft), recordWriteId)
      return {
        ...frozen.draft,
        recordWriteId,
        targetRevision: frozen.targetRevision,
        existingRecordPreconditionFingerprint:
          frozen.preconditionFingerprint,
        expectedSourceOwnership: frozen.expectedSourceOwnership,
        recordId: frozen.existingRecordId ?? crypto.randomUUID(),
      }
    },
  )
  const items = input.items.map((draft): LegacyImportItemPlanV1 => {
    const itemId = crypto.randomUUID()
    if (draft.kind === 'skip') return { ...draft, itemId }
    const recordWriteRef = recordWriteIdByTarget.get(draft.targetRef)
    if (recordWriteRef === undefined) fail('W4C3A_ENQUEUE_DRAFT_INVALID')
    return { ...draft, itemId, recordWriteRef }
  })
  const materializedGroups = materializeAttendanceLegacyGroupEffectsV1(
    currentOrg.orgId,
    input.groupEffects,
    frozenGroupReadSet,
  )
  const proofDigestResult = await trx.query(
    `SELECT encode(
       digest(convert_to($1::jsonb::text, 'UTF8'), 'sha256'),
       'hex'
     ) AS d`,
    [JSON.stringify(job.w4IdentityProofVector)],
  )
  const identityProofVectorDigest = String(
    (proofDigestResult.rows[0] as { d?: unknown } | undefined)?.d ?? '',
  )
  requireLowerHex64(
    identityProofVectorDigest,
    'W4C3A_ENQUEUE_PROOF_DIGEST_MISMATCH',
  )
  const packageInput = buildAttendanceLegacyImportPlanEnqueuePackageV1({
    job: {
      ...job,
      jobId,
    },
    manifestSeed: {
      ...manifestSeed,
      jobId,
      identityProofVectorDigest,
      groupRevision: materializedGroups.revision,
      groupStateFingerprint: materializedGroups.fingerprint,
    },
    items,
    recordWrites,
    groupEffects: materializedGroups.effects,
    groupEffectPlacements: materializedGroups.placements,
  })

  const persisted = await persistAttendanceLegacyImportPlanEnqueueV1(
    trx,
    packageInput,
  )
  return {
    kind: 'created',
    ...persisted,
  }
}

/**
 * Atomic V1 job + manifest + chunks insert. Caller must already hold an open
 * SERIALIZABLE transaction on `trx` (and any class-10/11 locks required by the
 * governing enqueue contract). This seam performs only the three inserts and
 * relies on the deferred DB congruence trigger to reject incomplete sets.
 */
async function persistAttendanceLegacyImportPlanEnqueueV1(
  trx: AttendanceW4TransactionClientV1,
  input: PersistAttendanceLegacyImportPlanEnqueueInputV1,
): Promise<PersistAttendanceLegacyImportPlanEnqueueResultV1> {
  if (typeof trx !== 'object' || trx === null || typeof trx.query !== 'function') {
    fail('W4C3A_ENQUEUE_TRX_INVALID')
  }
  const { job, envelope, manifest, planDigest } =
    validateAttendanceLegacyImportPlanEnqueuePackageV1(input)

  // DB-owned identity proof vector digest (must match manifest).
  const proofDigestResult = await trx.query(
    `SELECT encode(
       digest(convert_to($1::jsonb::text, 'UTF8'), 'sha256'),
       'hex'
     ) AS d`,
    [JSON.stringify(job.w4IdentityProofVector)],
  )
  const identityProofVectorDigest = String(
    (proofDigestResult.rows[0] as { d: string } | undefined)?.d ?? '',
  )
  if (identityProofVectorDigest !== manifest.identityProofVectorDigest) {
    fail('W4C3A_ENQUEUE_PROOF_DIGEST_MISMATCH')
  }

  // Insert job with explicit server-minted id.
  await trx.query(
    `INSERT INTO attendance_import_jobs (
        id, org_id, batch_id, created_by, idempotency_key, status, progress, total, payload,
        w4_contract_version, w4_entrypoint, w4_batch_command_id, w4_source_kind,
        w4_source_ref, w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
        w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
        w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector,
        w4_legacy_plan_digest, w4_distinct_target_count, w4_operational_branch,
        w4_legacy_input_fingerprint
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, $5, 'queued', 0, $6, $7::jsonb,
        1, $8, $9::uuid, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb,
        $21, $22, $23, $24
      )`,
    [
      job.jobId,
      job.orgId,
      job.batchId,
      job.createdBy,
      job.idempotencyKey,
      job.total,
      canonicalAttendanceJsonV1(envelope),
      job.w4Entrypoint,
      job.w4BatchCommandId,
      job.w4SourceKind,
      job.w4SourceRef,
      job.w4ActorId,
      job.w4ActorPosture,
      job.w4TokenSubjectUserId,
      job.w4CommandFingerprint,
      job.w4AcceptedWritePosture,
      job.w4ItemCount,
      job.w4ItemSequenceFingerprint,
      job.w4ItemSetFingerprint,
      JSON.stringify(job.w4IdentityProofVector),
      planDigest,
      job.w4DistinctTargetCount,
      job.w4OperationalBranch,
      job.w4LegacyInputFingerprint,
    ],
  )

  const chunkCount = input.chunks.length
  // Persist manifest relational columns + exact-key root JSON (no effect arrays).
  const manifestJson = {
    schemaVersion: manifest.schemaVersion,
    orgId: manifest.orgId,
    jobId: manifest.jobId,
    batchId: manifest.batchId,
    sourceKind: manifest.sourceKind,
    sourceRef: manifest.sourceRef,
    createdBy: manifest.createdBy,
    actorId: manifest.actorId,
    actorPosture: manifest.actorPosture,
    tokenSubjectUserId: manifest.tokenSubjectUserId,
    acceptedWritePosture: manifest.acceptedWritePosture,
    identityProofVectorDigest: manifest.identityProofVectorDigest,
    commandFingerprint: manifest.commandFingerprint,
    legacyInputFingerprint: manifest.legacyInputFingerprint,
    operationalBranch: manifest.operationalBranch,
    legacyRowSourceKind: manifest.legacyRowSourceKind,
    sourceRowCount: manifest.sourceRowCount,
    sourceOrdinalDigest: manifest.sourceOrdinalDigest,
    w4ItemCount: manifest.w4ItemCount,
    w4DistinctTargetCount: manifest.w4DistinctTargetCount,
    w4ItemSequenceFingerprint: manifest.w4ItemSequenceFingerprint,
    w4ItemSetFingerprint: manifest.w4ItemSetFingerprint,
    legacySourceRowLimit: manifest.legacySourceRowLimit,
    groupRevision: manifest.groupRevision,
    groupStateFingerprint: manifest.groupStateFingerprint,
    chunkVectorDigest: manifest.chunkVectorDigest,
    batch: manifest.batch,
    artifactCleanup: manifest.artifactCleanup,
  }

  await trx.query(
    `INSERT INTO attendance_import_legacy_execution_plans (
        job_id, org_id, batch_id, plan_version, plan_digest, chunk_vector_digest,
        source_kind, source_ref, created_by, actor_id, actor_posture, token_subject_user_id,
        accepted_write_posture, identity_proof_vector_digest, command_fingerprint,
        legacy_input_fingerprint, operational_branch, legacy_row_source_kind,
        legacy_source_row_limit, source_row_count, source_ordinal_digest,
        w4_item_count, w4_distinct_target_count, w4_item_sequence_fingerprint,
        w4_item_set_fingerprint, group_revision, group_state_fingerprint,
        chunk_count, manifest
      ) VALUES (
        $1::uuid, $2, $3::uuid, 1, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23,
        $24, $25, $26,
        $27, $28::jsonb
      )`,
    [
      manifest.jobId,
      manifest.orgId,
      manifest.batchId,
      planDigest,
      manifest.chunkVectorDigest,
      manifest.sourceKind,
      manifest.sourceRef,
      manifest.createdBy,
      manifest.actorId,
      manifest.actorPosture,
      manifest.tokenSubjectUserId,
      manifest.acceptedWritePosture,
      manifest.identityProofVectorDigest,
      manifest.commandFingerprint,
      manifest.legacyInputFingerprint,
      manifest.operationalBranch,
      manifest.legacyRowSourceKind,
      manifest.legacySourceRowLimit,
      manifest.sourceRowCount,
      manifest.sourceOrdinalDigest,
      manifest.w4ItemCount,
      manifest.w4DistinctTargetCount,
      manifest.w4ItemSequenceFingerprint,
      manifest.w4ItemSetFingerprint,
      manifest.groupRevision,
      manifest.groupStateFingerprint,
      chunkCount,
      canonicalAttendanceJsonV1(manifestJson),
    ],
  )

  for (const chunk of input.chunks) {
    await trx.query(
      `INSERT INTO attendance_import_legacy_execution_plan_chunks (
          job_id, chunk_index, first_source_ordinal, source_row_count, chunk_digest, chunk
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
      [
        manifest.jobId,
        chunk.chunkIndex,
        chunk.firstSourceOrdinal,
        chunk.sourceRowCount,
        chunk.chunkDigest,
        canonicalAttendanceJsonV1({
          items: chunk.body.items,
          recordWrites: chunk.body.recordWrites,
          groupEffects: chunk.body.groupEffects,
        }),
      ],
    )
  }

  return {
    jobId: job.jobId,
    planDigest,
    chunkCount,
  }
}

/**
 * Convenience builder: given a verified seed + effect arrays, compute digests,
 * chunk, and produce the enqueue input. Does not touch the database.
 */
function buildAttendanceLegacyImportPlanEnqueuePackageV1(input: {
  readonly job: Omit<AttendanceLegacyImportJobInsertV1, 'w4LegacyPlanDigest'>
  readonly manifestSeed: Omit<
    LegacyImportExecutionPlanManifestV1,
    'sourceOrdinalDigest' | 'chunkVectorDigest'
  >
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
  readonly groupEffectPlacements: readonly LegacyImportGroupEffectPlacementV1[]
}): PersistAttendanceLegacyImportPlanEnqueueInputV1 {
  try {
    const built = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: input.manifestSeed,
      items: input.items,
      recordWrites: input.recordWrites,
      groupEffects: input.groupEffects,
      groupEffectPlacements: input.groupEffectPlacements,
    })
    return {
      job: {
        ...input.job,
        w4LegacyPlanDigest: built.planDigest,
      },
      manifest: built.manifest,
      chunks: built.chunks,
    }
  } catch (error) {
    if (error instanceof AttendanceLegacyExecutionPlanError) {
      throw new AttendanceLegacyPlanEnqueueError(error.code)
    }
    throw error
  }
}
