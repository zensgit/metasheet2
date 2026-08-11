import crypto from 'node:crypto'

import {
  sealAttendanceResultOperationBatchV1,
  sealAttendanceResultOperationV1,
} from './w4c0-operation-registry'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
} from './w4c1-segment-calculator'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  verifyAttendanceImportAttributionSnapshotV1,
  verifyAttendanceImportPolicySourceFingerprintV1,
  type AttendanceImportPolicySourceProjectionV1,
} from './w4c3a-import-proof'
import type {
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from './w4c0-write-boundary-types'
import type {
  AttendanceW4TransactionClientV1,
  VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import {
  applyAttendanceLegacyBatchEffectsV1,
  buildAttendanceLegacyAsyncJobSummaryV1,
} from './w4c3a-legacy-plan-batch-effects'
import { applyAttendanceLegacyGroupEffectsV1 } from './w4c3a-legacy-plan-group-effects'
import { applyAttendanceLegacyItemEffectsV1 } from './w4c3a-legacy-plan-item-effects'
import { applyAttendanceLegacyRecordEffectsV1 } from './w4c3a-legacy-plan-record-effects'
import type {
  RawImportEvidenceV1,
  LegacyImportRecordWritePlanV1,
} from './w4c3a-legacy-execution-plan'
import type {
  AttendanceLegacyPlanWorkerJobV1,
  VerifiedAttendanceLegacyPlanV1,
} from './w4c3a-legacy-plan-worker'
import { assertParentNotOperatorRetiredV1 } from './w4c3c-ops-retirement'
import { computeAttendanceW4ShadowDiff } from '../services/AttendanceW4CalculationDetail'

const PREIMAGE_FINGERPRINT_DOMAIN =
  'metasheet2:attendance:w4c3a:rollback-preimage-fingerprint:v1'

type QueryRow = Record<string, unknown>

export type AttendanceCanonicalImportRegistryClaimV1 = Readonly<{
  batchIdentity: VerifiedAttendanceOperationIdentityV1
  itemIdentities: readonly VerifiedAttendanceOperationIdentityV1[]
}>

export type AttendanceCanonicalImportRegistryStateV1 =
  | 'all_new'
  | 'all_completed_congruent'
  | 'conflict'

type CanonicalImportPolicyOutputV1 = Readonly<{
  status: string | null
  workMinutes: number | null
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
  leaveMinutes: number | null
  overtimeMinutes: number | null
}>

type CanonicalImportFrozenSourceV1 = Readonly<{
  sourceOrdinal: number
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  sourceFingerprint: string
  sourceDefinition: AttendanceImportPolicySourceProjectionV1
  ruleVersion: string
  engineVersion: string | null
  output: CanonicalImportPolicyOutputV1
}>

type CanonicalImportFrozenTargetV1 = Readonly<{
  sources: readonly CanonicalImportFrozenSourceV1[]
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  sourceDefinitionFingerprint: string | null
  freezeConflict: boolean
}>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code = 'W4C3A_IMPORT_FREEZE_INVALID',
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(code)
  const own = Object.getOwnPropertyNames(value).sort()
  const expected = [...keys].sort()
  if (
    own.length !== expected.length ||
    own.some((key, index) => key !== expected[index]) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error(code)
  }
  return value
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
  }
  return value
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
  }
  return Number(value)
}

function parseImportPolicyOutput(value: unknown): CanonicalImportPolicyOutputV1 {
  const row = exactRecord(value, [
    'status',
    'workMinutes',
    'lateMinutes',
    'earlyLeaveMinutes',
    'leaveMinutes',
    'overtimeMinutes',
  ])
  return Object.freeze({
    status: row.status === null ? null : nonEmptyString(row.status),
    workMinutes: nullableNonNegativeInteger(row.workMinutes),
    lateMinutes: nullableNonNegativeInteger(row.lateMinutes),
    earlyLeaveMinutes: nullableNonNegativeInteger(row.earlyLeaveMinutes),
    leaveMinutes: nullableNonNegativeInteger(row.leaveMinutes),
    overtimeMinutes: nullableNonNegativeInteger(row.overtimeMinutes),
  })
}

function parseImportContext(value: unknown): FrozenAttendanceContextV1 | null {
  if (value === null) return null
  const root = exactRecord(value, [
    'schemaVersion',
    'selector',
    'orgId',
    'userId',
    'workDate',
    'timezone',
    'shiftId',
    'isWorkday',
    'holidayKind',
    'calculationGroupId',
    'roundingMinutes',
    'severeLateThresholdMinutes',
    'absenceLateThresholdMinutes',
    'segments',
  ])
  if (
    root.schemaVersion !== 1 ||
    root.selector !== 'legacy' ||
    typeof root.isWorkday !== 'boolean' ||
    (root.holidayKind !== null && typeof root.holidayKind !== 'string') ||
    root.calculationGroupId !== null ||
    !Array.isArray(root.segments) ||
    root.segments.length < 1 ||
    root.segments.length > 3
  ) {
    throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
  }
  for (const key of ['orgId', 'userId', 'workDate', 'timezone', 'shiftId']) nonEmptyString(root[key])
  for (const key of ['roundingMinutes', 'severeLateThresholdMinutes', 'absenceLateThresholdMinutes']) {
    nullableNonNegativeInteger(root[key])
  }
  root.segments.forEach((value, index) => {
    const segment = exactRecord(value, [
      'index',
      'startTime',
      'endTime',
      'startDayOffset',
      'endDayOffset',
      'lateGraceMinutes',
      'earlyLeaveGraceMinutes',
    ])
    if (
      segment.index !== index ||
      segment.startDayOffset !== 0 ||
      (segment.endDayOffset !== 0 && segment.endDayOffset !== 1)
    ) {
      throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
    }
    nonEmptyString(segment.startTime)
    nonEmptyString(segment.endTime)
    nullableNonNegativeInteger(segment.lateGraceMinutes)
    nullableNonNegativeInteger(segment.earlyLeaveGraceMinutes)
  })
  return root as unknown as FrozenAttendanceContextV1
}

function parseCanonicalImportFreeze(write: LegacyImportRecordWritePlanV1): CanonicalImportFrozenTargetV1 {
  const attributionRoot = exactRecord(write.attributionSnapshot, ['schemaVersion', 'sources'])
  const policyRoot = exactRecord(write.policySnapshot, ['schemaVersion', 'sources'])
  if (
    attributionRoot.schemaVersion !== 2 ||
    policyRoot.schemaVersion !== 2 ||
    !Array.isArray(attributionRoot.sources) ||
    !Array.isArray(policyRoot.sources) ||
    attributionRoot.sources.length !== write.sourceOrdinals.length ||
    policyRoot.sources.length !== write.sourceOrdinals.length
  ) {
    throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
  }
  const policyByOrdinal = new Map<number, Omit<CanonicalImportFrozenSourceV1, 'attribution' | 'context'>>()
  for (const raw of policyRoot.sources) {
    const row = exactRecord(raw, [
      'sourceOrdinal',
      'sourceFingerprint',
      'sourceDefinition',
      'output',
    ])
    const sourceOrdinal = nullableNonNegativeInteger(row.sourceOrdinal)
    if (sourceOrdinal === null || policyByOrdinal.has(sourceOrdinal)) {
      throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
    }
    const sourceFingerprint = nonEmptyString(row.sourceFingerprint)
    const sourceDefinition = verifyAttendanceImportPolicySourceFingerprintV1({
      sourceDefinition: row.sourceDefinition,
      sourceFingerprint,
    })
    policyByOrdinal.set(sourceOrdinal, {
      sourceOrdinal,
      sourceFingerprint,
      sourceDefinition,
      ruleVersion: sourceDefinition.ruleVersion,
      engineVersion: sourceDefinition.engineVersion,
      output: parseImportPolicyOutput(row.output),
    })
  }
  const sources = attributionRoot.sources.map((raw, index) => {
    const row = exactRecord(raw, [
      'sourceOrdinal',
      'attribution',
      'context',
      'importAttributionReconstruction',
    ])
    const sourceOrdinal = nullableNonNegativeInteger(row.sourceOrdinal)
    const expectedOrdinal = write.sourceOrdinals[index]
    const policy = sourceOrdinal === null ? null : policyByOrdinal.get(sourceOrdinal)
    if (sourceOrdinal !== expectedOrdinal || !policy) {
      throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
    }
    const attribution = verifyAttendanceImportAttributionSnapshotV1({
      attribution: row.attribution,
      reconstruction: row.importAttributionReconstruction,
      expectedIdentity: {
        orgId: write.orgId,
        userId: write.userId,
        workDate: write.workDate,
      },
    })
    const context = parseImportContext(row.context)
    if (
      context !== null &&
      (context.orgId !== write.orgId ||
        context.userId !== write.userId ||
        context.workDate !== write.workDate ||
        (attribution.posture === 'resolved_v2' && context.shiftId !== attribution.value.shiftId))
    ) {
      throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
    }
    return Object.freeze({
      ...policy,
      attribution,
      context,
    })
  })
  if (policyByOrdinal.size !== sources.length) throw new Error('W4C3A_IMPORT_FREEZE_INVALID')
  const first = sources[0]
  const firstDefinition = canonicalAttendanceJsonV1({
    attribution: first.attribution,
    context: first.context,
    sourceDefinition: first.sourceDefinition,
  })
  const freezeConflict = sources.some(
    (source) =>
      canonicalAttendanceJsonV1({
        attribution: source.attribution,
        context: source.context,
        sourceDefinition: source.sourceDefinition,
      }) !==
      firstDefinition,
  )
  return Object.freeze({
    sources: Object.freeze(sources),
    attribution: first.attribution,
    context: first.context,
    sourceDefinitionFingerprint: computeAttendanceSourceDefinitionFingerprintV1({
      attribution: first.attribution,
      context: first.context,
    }),
    freezeConflict,
  })
}

/** Validates the sealed attribution and policy-source evidence before import execution. */
export function validateAttendanceCanonicalImportFreezeV1(
  write: LegacyImportRecordWritePlanV1,
): void {
  parseCanonicalImportFreeze(write)
}

function unsupportedImportAttribution(): AttendanceAttributionSnapshotV1 {
  return {
    posture: 'unsupported',
    sourceSchemaVersion: 1,
    reason: 'legacy_v1',
    sourceFingerprint: null,
  }
}

function normalizeInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
  }
  return parsed.toISOString()
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
  }
  return parsed
}

function preimageFingerprint(input: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(PREIMAGE_FINGERPRINT_DOMAIN, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalAttendanceJsonV1(input), 'utf8'),
      ]),
    )
    .digest('hex')
}

function frozenPresentPreimage(row: QueryRow): Record<string, unknown> {
  // A new durable import source may reactivate an import-rollback/review
  // tombstone (OD-W4C-19). Operator retirement remains terminal.
  assertParentNotOperatorRetiredV1(row)
  const projectionOwner = String(row.projection_owner)
  const currentCalculationId =
    row.current_calculation_id === null ? null : String(row.current_calculation_id)
  if (
    (projectionOwner !== 'legacy_untracked' && projectionOwner !== 'w4') ||
    (projectionOwner === 'legacy_untracked' && currentCalculationId !== null) ||
    (projectionOwner === 'w4' && currentCalculationId === null)
  ) {
    throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
  }
  const visibilityState = String(row.visibility_state)
  const visibilityReason = String(row.visibility_reason)
  if (
    (visibilityState !== 'active' && visibilityState !== 'retired') ||
    (visibilityState === 'active' && visibilityReason !== 'active') ||
    (visibilityState === 'retired' && visibilityReason === 'active')
  ) {
    throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
  }
  if (typeof row.status !== 'string' || row.status.length === 0) {
    throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
  }
  const fingerprintInput = {
    projection: {
      status: row.status,
      firstInAt: normalizeInstant(row.first_in_at),
      lastOutAt: normalizeInstant(row.last_out_at),
      workMinutes: nonNegativeInteger(row.work_minutes),
      lateMinutes: nonNegativeInteger(row.late_minutes),
      earlyLeaveMinutes: nonNegativeInteger(row.early_leave_minutes),
    },
    projectionOwner,
    currentCalculationId,
    visibilityState,
    visibilityReason,
  }
  return {
    posture: 'present',
    ...fingerprintInput,
    compatibilityFingerprint: preimageFingerprint(fingerprintInput),
  }
}

async function captureParentPreimages(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const snapshots = new Map<string, Record<string, unknown>>()
  for (const write of plan.recordWrites) {
    const result = await trx.query(
      `SELECT id::text AS id, first_in_at, last_out_at, work_minutes,
              late_minutes, early_leave_minutes, status,
              current_calculation_id::text AS current_calculation_id,
              projection_owner, visibility_state, visibility_reason
         FROM attendance_records
        WHERE id = $1::uuid AND org_id = $2 AND user_id = $3 AND work_date = $4::date`,
      [write.recordId, write.orgId, write.userId, write.workDate],
    )
    if (result.rows.length === 0) {
      snapshots.set(write.recordWriteId, { posture: 'absent' })
      continue
    }
    if (result.rows.length !== 1) {
      throw new Error('W4C3A_IMPORT_PREIMAGE_INVALID')
    }
    snapshots.set(write.recordWriteId, frozenPresentPreimage(result.rows[0] as QueryRow))
  }
  return snapshots
}

function identityProofRows(job: AttendanceLegacyPlanWorkerJobV1): readonly Record<string, unknown>[] {
  if (!Array.isArray(job.identityProofVector)) {
    throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
  }
  return job.identityProofVector as readonly Record<string, unknown>[]
}

function isCompletedBatchRowCongruent(
  row: QueryRow,
  job: AttendanceLegacyPlanWorkerJobV1,
  batchIdentity: VerifiedAttendanceOperationIdentityV1,
): boolean {
  return (
    row.batch_command_id === batchIdentity.id &&
    row.state === 'completed' &&
    row.accepted_write_posture === job.acceptedWritePosture &&
    row.command_fingerprint === job.commandFingerprint &&
    Number(row.item_count) === job.itemCount &&
    row.item_sequence_fingerprint === job.itemSequenceFingerprint &&
    row.item_set_fingerprint === job.itemSetFingerprint &&
    row.response_snapshot !== null &&
    row.response_snapshot !== undefined
  )
}

function isCompletedItemRowCongruent(
  row: QueryRow,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    batchIdentity: VerifiedAttendanceOperationIdentityV1
    identity: VerifiedAttendanceOperationIdentityV1
    proof: Record<string, unknown>
  }>,
): boolean {
  return (
    input.identity.kind === 'item' &&
    row.operation_id === input.identity.id &&
    row.batch_command_id === input.batchIdentity.id &&
    row.state === 'completed' &&
    row.accepted_write_posture === input.job.acceptedWritePosture &&
    Number(row.input_ordinal) === Number(input.proof.ordinal) &&
    row.proof_semantic_fingerprint === input.proof.semanticFingerprint &&
    row.command_fingerprint === input.proof.commandFingerprint &&
    row.response_snapshot !== null &&
    row.response_snapshot !== undefined
  )
}

/**
 * Section 8.2 read-only classification. It runs under the complete class-10
 * set and before the operational job row is locked. Enqueue transport rows are
 * never interpreted as operation completion evidence.
 */
export async function inspectAttendanceCanonicalImportRegistryV1(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    identities: readonly VerifiedAttendanceOperationIdentityV1[]
  }>,
): Promise<AttendanceCanonicalImportRegistryStateV1> {
  const batchIdentity = input.identities.find((identity) => identity.kind === 'batch')
  const itemIdentities = input.identities.filter((identity) => identity.kind === 'item')
  if (!batchIdentity) throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')

  // Keep the row-lock order explicit. Promise.all on one pg client happens to
  // serialize today, but that transport detail is not a lock-order contract.
  const batchResult = await trx.query(
    `SELECT batch_command_id::text AS batch_command_id, state,
            accepted_write_posture, command_fingerprint, item_count,
            item_sequence_fingerprint, item_set_fingerprint, response_snapshot
       FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint = 'import_batch'
        AND batch_command_id = $2::uuid
      FOR UPDATE`,
    [input.job.orgId, batchIdentity.id],
  )
  const itemResult =
    itemIdentities.length === 0
      ? { rows: [] }
      : await trx.query(
          `SELECT operation_id::text AS operation_id,
                  batch_command_id::text AS batch_command_id, state,
                  accepted_write_posture, input_ordinal,
                  proof_semantic_fingerprint, command_fingerprint,
                  response_snapshot
             FROM attendance_result_operations
            WHERE org_id = $1 AND entrypoint = 'import_batch'
              AND operation_id = ANY($2::uuid[])
            ORDER BY operation_id
            FOR UPDATE`,
          [input.job.orgId, itemIdentities.map((identity) => identity.id)],
        )

  if (input.job.acceptedWritePosture === 'legacy_projection_only') {
    return batchResult.rows.length === 0 && itemResult.rows.length === 0
      ? 'all_new'
      : 'conflict'
  }
  if (itemIdentities.length !== input.job.itemCount) {
    throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
  }
  if (batchResult.rows.length === 0 && itemResult.rows.length === 0) {
    return 'all_new'
  }
  if (
    batchResult.rows.length !== 1 ||
    itemResult.rows.length !== itemIdentities.length ||
    !isCompletedBatchRowCongruent(batchResult.rows[0] as QueryRow, input.job, batchIdentity)
  ) {
    return 'conflict'
  }
  const proofRows = identityProofRows(input.job)
  const rowsById = new Map(
    itemResult.rows.map((row) => [String((row as QueryRow).operation_id), row as QueryRow]),
  )
  for (let index = 0; index < itemIdentities.length; index += 1) {
    const identity = itemIdentities[index]
    const proof = proofRows[index]
    const row = rowsById.get(identity.id)
    if (!proof || !row || !isCompletedItemRowCongruent(row, {
      job: input.job,
      batchIdentity,
      identity,
      proof,
    })) {
      return 'conflict'
    }
  }
  return 'all_completed_congruent'
}

export async function claimAttendanceCanonicalImportRegistryV1(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    plan: VerifiedAttendanceLegacyPlanV1
    identities: readonly VerifiedAttendanceOperationIdentityV1[]
  }>,
): Promise<AttendanceCanonicalImportRegistryClaimV1 | null> {
  if (
    input.plan.manifest.batch.kind === 'idempotent_replay' ||
    input.job.acceptedWritePosture === 'legacy_projection_only'
  ) {
    return null
  }
  // The operation registry is durable product state. Reject malformed frozen
  // inputs before the first registry read/write so a structurally invalid plan
  // cannot leave a claimed batch behind for recovery to misinterpret.
  for (const write of input.plan.recordWrites) {
    parseCanonicalImportFreeze(write)
  }
  const batchIdentity = input.identities.find((identity) => identity.kind === 'batch')
  const itemIdentities = input.identities.filter((identity) => identity.kind === 'item')
  if (!batchIdentity || itemIdentities.length !== input.job.itemCount) {
    throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
  }
  const existingBatch = await trx.query(
    `SELECT state FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = $2::uuid`,
    [input.job.orgId, batchIdentity.id],
  )
  const existingItems = await trx.query(
    `SELECT operation_id::text AS operation_id, state
       FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = 'import_batch'
        AND operation_id = ANY($2::uuid[])`,
    [input.job.orgId, itemIdentities.map((identity) => identity.id)],
  )
  if (existingBatch.rows.length !== 0 || existingItems.rows.length !== 0) {
    throw new Error('W4C3A_IMPORT_OPERATION_CONFLICT')
  }
  const subjectUsers = [...new Set(input.plan.recordWrites.map((write) => write.userId))].sort()
  const subjectScope = canonicalAttendanceJsonV1({ kind: 'explicit_users', userIds: subjectUsers })
  await trx.query(
    `INSERT INTO attendance_result_operation_batches (
        org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id,
        source_ref, actor_id, actor_posture, token_subject_user_id, capability,
        subject_scope, accepted_write_posture, command_fingerprint,
        item_count, item_sequence_fingerprint, item_set_fingerprint, state
      ) VALUES ($1,'import_batch',$2::uuid,'import_batch',$3::uuid,$4,$5,$6,$7,
                'import',$8::jsonb,$9,$10,$11,$12,$13,'claimed')`,
    [
      input.job.orgId,
      batchIdentity.id,
      batchIdentity.sourceProof.sourceRootId,
      input.job.sourceRef,
      input.job.actorId,
      input.job.actorPosture,
      input.job.tokenSubjectUserId,
      subjectScope,
      input.job.acceptedWritePosture,
      input.job.commandFingerprint,
      input.job.itemCount,
      input.job.itemSequenceFingerprint,
      input.job.itemSetFingerprint,
    ],
  )
  const proofRows = identityProofRows(input.job)
  const applyItems = input.plan.items
    .filter((item) => item.kind === 'apply')
    .slice()
    .sort((left, right) => left.semanticOrdinal - right.semanticOrdinal)
  for (let index = 0; index < itemIdentities.length; index += 1) {
    const identity = itemIdentities[index]
    const proof = proofRows[index]
    const item = applyItems[index]
    if (
      !proof ||
      !item ||
      Number(proof.ordinal) !== item.semanticOrdinal ||
      proof.derivedOperationId !== identity.id ||
      typeof proof.commandFingerprint !== 'string'
    ) {
      throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
    }
    await trx.query(
      `INSERT INTO attendance_result_operations (
          org_id, entrypoint, operation_id, batch_command_id, input_ordinal,
          identity_source_kind, source_root_id, proof_semantic_fingerprint,
          proof_user_id, proof_work_date, source_ref, actor_id, actor_posture,
          token_subject_user_id, capability, subject_scope, command_fingerprint,
          accepted_write_posture, state, normalized_business_input_snapshot
        ) VALUES ($1,'import_batch',$2::uuid,$3::uuid,$4,'import_item',$5::uuid,$6,
                  NULL,NULL,$7,$8,$9,$10,'import',$11::jsonb,$12,$13,'claimed',$14::jsonb)`,
      [
        input.job.orgId,
        identity.id,
        batchIdentity.id,
        item.semanticOrdinal,
        identity.sourceProof.sourceRootId,
        identity.sourceProof.semanticFingerprint,
        input.job.sourceRef,
        input.job.actorId,
        input.job.actorPosture,
        input.job.tokenSubjectUserId,
        subjectScope,
        proof.commandFingerprint,
        input.job.acceptedWritePosture,
        canonicalAttendanceJsonV1(item.rawEvidence),
      ],
    )
  }
  return Object.freeze({ batchIdentity, itemIdentities: Object.freeze(itemIdentities) })
}

function evidenceForSources(
  batchId: string,
  sourceEvidence: readonly RawImportEvidenceV1[],
): AttendanceEvidenceV1[] {
  return sourceEvidence.flatMap((raw) =>
    raw.punches.map((punch) => ({
      kind: 'punch' as const,
      ref: `import:${batchId}:${raw.sourceOrdinal}:${punch.direction}`,
      direction: punch.direction,
      occurredAt: punch.occurredAt,
      source: 'import' as const,
    })),
  )
}

function importedMetricConflict(
  sourceEvidence: readonly RawImportEvidenceV1[],
  freeze: CanonicalImportFrozenTargetV1,
  canonical: ReturnType<typeof calculateAttendanceSegmentsV1>,
): boolean {
  if (freeze.freezeConflict) return true
  const projection = canonical.dailyProjection
  if (canonical.outcome !== 'completed' || projection === null) {
    return (
      sourceEvidence.some(
        (raw) =>
          raw.fields.status.present ||
          Object.values(raw.metrics).some((metric) => metric.present),
      ) ||
      freeze.sources.some((source) =>
        Object.values(source.output).some((value) => value !== null),
      )
    )
  }
  const expected = {
    status: projection.status,
    workMinutes: projection.workedMinutes,
    lateMinutes: projection.lateMinutes,
    earlyLeaveMinutes: projection.earlyLeaveMinutes,
    leaveMinutes: canonical.segments.some((segment) => segment.excusedByLeave) ? null : 0,
    overtimeMinutes: canonical.segments.reduce(
      (total, segment) => total + segment.overtimeExtensionMinutes,
      0,
    ),
  } as const
  for (const raw of sourceEvidence) {
    const comparisons = [
      [raw.fields.status, expected.status],
      [raw.metrics.workMinutes, expected.workMinutes],
      [raw.metrics.lateMinutes, expected.lateMinutes],
      [raw.metrics.earlyLeaveMinutes, expected.earlyLeaveMinutes],
      [raw.metrics.leaveMinutes, expected.leaveMinutes],
      [raw.metrics.overtimeMinutes, expected.overtimeMinutes],
    ] as const
    for (const [presence, expected] of comparisons) {
      if (
        presence.present &&
        (presence.value === null || expected === null || presence.value !== expected)
      ) {
        return true
      }
    }
  }
  for (const source of freeze.sources) {
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (source.output[key] === null || source.output[key] !== expected[key]) return true
    }
  }
  return false
}

function projectedDailyFingerprint(projection: Readonly<{
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
}>): string {
  return crypto
    .createHash('sha256')
    .update('metasheet2:attendance:w4:projected-daily:v1\0', 'utf8')
    .update(canonicalAttendanceJsonV1(projection), 'utf8')
    .digest('hex')
}

async function nextCalculationVersion(
  trx: AttendanceW4TransactionClientV1,
  recordId: string,
): Promise<number> {
  const result = await trx.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM attendance_record_calculations
      WHERE attendance_record_id = $1::uuid`,
    [recordId],
  )
  const version = Number(result.rows[0]?.next)
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('W4C3A_IMPORT_CALCULATION_VERSION_INVALID')
  }
  return version
}

function requireCompatibilityProjection(write: LegacyImportRecordWritePlanV1): Readonly<{
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  isWorkday: boolean
}> {
  if (
    typeof write.status !== 'string' ||
    !Number.isSafeInteger(write.workMinutes) ||
    !Number.isSafeInteger(write.lateMinutes) ||
    !Number.isSafeInteger(write.earlyLeaveMinutes) ||
    typeof write.isWorkday !== 'boolean'
  ) {
    throw new Error('W4C3A_IMPORT_COMPATIBILITY_PROJECTION_INVALID')
  }
  return Object.freeze({
    status: write.status,
    firstInAt: write.firstInAt,
    lastOutAt: write.lastOutAt,
    workMinutes: Number(write.workMinutes),
    lateMinutes: Number(write.lateMinutes),
    earlyLeaveMinutes: Number(write.earlyLeaveMinutes),
    isWorkday: write.isWorkday,
  })
}

async function ensureAuthoritativeParent(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    write: LegacyImportRecordWritePlanV1
    canonical: ReturnType<typeof calculateAttendanceSegmentsV1>
    outcome: 'completed' | 'review_required'
  }>,
): Promise<void> {
  const existing = await trx.query(
    `SELECT id::text AS id
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2 AND user_id = $3 AND work_date = $4::date
      FOR UPDATE`,
    [input.write.recordId, input.write.orgId, input.write.userId, input.write.workDate],
  )
  if (existing.rows.length === 1) return
  if (existing.rows.length !== 0) throw new Error('W4C3A_IMPORT_PARENT_INVALID')
  const compatibility = requireCompatibilityProjection(input.write)
  const projection =
    input.outcome === 'completed' && input.canonical.dailyProjection !== null
      ? input.canonical.dailyProjection
      : compatibility
  await trx.query(
    `INSERT INTO attendance_records (
        id, org_id, user_id, work_date, timezone,
        first_in_at, last_out_at, work_minutes, late_minutes,
        early_leave_minutes, status, is_workday, meta, source_batch_id,
        projection_owner, current_calculation_id, visibility_state, visibility_reason,
        created_at, updated_at
      ) VALUES (
        $1::uuid,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::uuid,
        'legacy_untracked',NULL,$15,$16,now(),now()
      )`,
    [
      input.write.recordId,
      input.write.orgId,
      input.write.userId,
      input.write.workDate,
      input.write.timezone,
      projection.firstInAt,
      projection.lastOutAt,
      'workedMinutes' in projection ? projection.workedMinutes : projection.workMinutes,
      projection.lateMinutes,
      projection.earlyLeaveMinutes,
      projection.status,
      compatibility.isWorkday,
      canonicalAttendanceJsonV1(input.write.compatibilityMetadata),
      input.write.sourceBatchId,
      input.outcome === 'completed' ? 'active' : 'retired',
      input.outcome === 'completed' ? 'active' : 'review_placeholder',
    ],
  )
}

async function appendLegacyBaselineIfRequired(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    write: LegacyImportRecordWritePlanV1
    preimage: Record<string, unknown>
  }>,
): Promise<void> {
  if (input.preimage.posture !== 'present') return
  if (input.preimage.projectionOwner !== 'legacy_untracked') return
  const existing = await trx.query(
    `SELECT 1
       FROM attendance_record_calculations
      WHERE org_id = $1 AND attendance_record_id = $2::uuid
        AND calculation_kind = 'legacy_baseline'
      LIMIT 1`,
    [input.job.orgId, input.write.recordId],
  )
  if (existing.rows.length !== 0) return
  const fingerprint = nonEmptyString(input.preimage.compatibilityFingerprint)
  const projection = exactRecord(input.preimage.projection, [
    'status',
    'firstInAt',
    'lastOutAt',
    'workMinutes',
    'lateMinutes',
    'earlyLeaveMinutes',
  ], 'W4C3A_IMPORT_PREIMAGE_INVALID')
  const version = await nextCalculationVersion(trx, input.write.recordId)
  await trx.query(
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, source_batch_id, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, parent_preimage_snapshot, actor_id, correlation_id
      ) VALUES (
        $1::uuid,$2,$3::uuid,$4,'legacy_baseline','authoritative','legacy_import',
        $5,1,NULL,NULL,$6::char(64),$6::char(64),$6::char(64),$7::jsonb,$8::jsonb,'[]'::jsonb,'[]'::jsonb,
        '[]'::jsonb,NULL,$9::jsonb,'append','legacy_shadow','baseline',
        'legacy_projection_baseline','none',0,$10,$11,$12,$13,$14,$15,$6::text,$9::jsonb,$16,$17
      )`,
    [
      crypto.randomUUID(),
      input.job.orgId,
      input.write.recordId,
      version,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      fingerprint,
      canonicalAttendanceJsonV1(unsupportedImportAttribution()),
      canonicalAttendanceJsonV1({ schemaVersion: 1, kind: 'legacy_projection_baseline' }),
      canonicalAttendanceJsonV1(input.preimage),
      projection.status,
      projection.firstInAt,
      projection.lastOutAt,
      projection.workMinutes,
      projection.lateMinutes,
      projection.earlyLeaveMinutes,
      input.job.actorId,
      `attendance-import:${input.job.batchId}:baseline`,
    ],
  )
}

async function insertCalculationSegments(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    orgId: string
    recordId: string
    calculationId: string
    segments: ReturnType<typeof calculateAttendanceSegmentsV1>['segments']
  }>,
): Promise<void> {
  for (const segment of input.segments) {
    await trx.query(
      `INSERT INTO attendance_record_segments (
          org_id, record_id, calculation_id, segment_index,
          expected_start_at, expected_end_at, actual_in_at, actual_out_at,
          work_minutes, late_minutes, early_leave_minutes,
          status, status_reasons, matched_evidence_refs, unmatched_evidence_refs
        ) VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)`,
      [
        input.orgId,
        input.recordId,
        input.calculationId,
        segment.segmentIndex,
        segment.expectedStartAt,
        segment.expectedEndAt,
        segment.actualInAt,
        segment.actualOutAt,
        segment.workedMinutes,
        segment.lateMinutes,
        segment.earlyLeaveMinutes,
        segment.status,
        canonicalAttendanceJsonV1(segment.reasons),
        canonicalAttendanceJsonV1(segment.matchedEvidenceRefs),
        canonicalAttendanceJsonV1(segment.unmatchedEvidenceRefs),
      ],
    )
  }
}

async function appendCanonicalCalculation(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    plan: VerifiedAttendanceLegacyPlanV1
    write: LegacyImportRecordWritePlanV1
    preimage: Record<string, unknown>
    identitiesBySemanticOrdinal: ReadonlyMap<number, VerifiedAttendanceOperationIdentityV1>
  }>,
): Promise<Readonly<{
  calculationId: string
  responseByOperationId: Readonly<Record<string, unknown>>
  resultSemanticFingerprint: string
  resultProvenanceFingerprint: string
}>> {
  const sourceItems = input.plan.items
    .filter(
      (item): item is Extract<(typeof input.plan.items)[number], { kind: 'apply' }> =>
        item.kind === 'apply' && input.write.sourceOrdinals.includes(item.ordinal),
    )
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal)
  if (sourceItems.length === 0) throw new Error('W4C3A_IMPORT_TARGET_EVIDENCE_MISSING')
  const sourceEvidence = sourceItems.map((item) => item.rawEvidence)
  const freeze = parseCanonicalImportFreeze(input.write)
  const attribution = freeze.attribution
  const context = freeze.context
  const evidence = evidenceForSources(input.job.batchId, sourceEvidence)
  const canonical = calculateAttendanceSegmentsV1({
    attribution,
    context,
    evidence,
    approvedFacts: [],
  })
  const metricConflict = importedMetricConflict(sourceEvidence, freeze, canonical)
  const outcome = metricConflict ? 'review_required' : canonical.outcome
  const outcomeReasonCode = metricConflict
    ? 'import_metric_conflict'
    : canonical.outcomeReasonCode
  const completed = outcome === 'completed' && canonical.dailyProjection !== null
  const mode = input.job.acceptedWritePosture === 'authoritative' ? 'authoritative' : 'shadow'
  if (mode === 'authoritative') {
    await ensureAuthoritativeParent(trx, {
      write: input.write,
      canonical,
      outcome,
    })
    if (completed) {
      await appendLegacyBaselineIfRequired(trx, {
        job: input.job,
        write: input.write,
        preimage: input.preimage,
      })
    }
  }
  const provenance = sourceEvidence[sourceEvidence.length - 1].provenance
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution,
    context,
    evidence,
    approvedFacts: [],
    manualOverride: null,
    mergePolicy: 'append',
    calculationTier: mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(provenance)
  const version = await nextCalculationVersion(trx, input.write.recordId)
  const terminalIdentity = input.identitiesBySemanticOrdinal.get(
    sourceItems[sourceItems.length - 1].semanticOrdinal,
  )
  if (!terminalIdentity) throw new Error('W4C3A_IMPORT_OPERATION_IDENTITY_MISSING')
  const calculationId = crypto.randomUUID()
  const projection = completed ? canonical.dailyProjection : null
  const compatibilityProjection = requireCompatibilityProjection(input.write)
  const resolvedWorkDate = attribution.posture === 'resolved_v2'
    ? attribution.value.workDate
    : null
  const shadowDiff = mode === 'shadow'
    ? computeAttendanceW4ShadowDiff({
        legacy: {
          workDate: input.write.workDate,
          status: compatibilityProjection.status,
          firstInAt: compatibilityProjection.firstInAt,
          lastOutAt: compatibilityProjection.lastOutAt,
          workMinutes: compatibilityProjection.workMinutes,
          lateMinutes: compatibilityProjection.lateMinutes,
          earlyLeaveMinutes: compatibilityProjection.earlyLeaveMinutes,
        },
        calculated: projection
          ? {
              workDate: resolvedWorkDate,
              status: projection.status,
              firstInAt: projection.firstInAt,
              lastOutAt: projection.lastOutAt,
              workMinutes: projection.workedMinutes,
              lateMinutes: projection.lateMinutes,
              earlyLeaveMinutes: projection.earlyLeaveMinutes,
            }
          : null,
        segmentCount: completed ? canonical.segments.length : 0,
        outcome,
        workDateMismatch: resolvedWorkDate !== null && resolvedWorkDate !== input.write.workDate,
        contextMismatch: outcomeReasonCode === 'context_mismatch',
        inputMismatch: outcomeReasonCode === 'input_schema_invalid' || outcomeReasonCode === 'import_metric_conflict',
      })
    : null
  await trx.query(
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, source_batch_id, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, parent_preimage_snapshot, shadow_diff_code, shadow_diff,
        actor_id, correlation_id
      ) VALUES (
        $1::uuid,$2,$3::uuid,$4,'calculation',$5,'legacy_import',$6,1,$7::uuid,$8::uuid,
        $9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,'[]'::jsonb,NULL,$16::jsonb,
        'append',$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31::jsonb,$32,$33
      )`,
    [
      calculationId,
      input.job.orgId,
      input.write.recordId,
      version,
      mode,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      input.job.batchId,
      terminalIdentity.id,
      semanticFingerprint,
      provenanceFingerprint,
      freeze.sourceDefinitionFingerprint,
      canonicalAttendanceJsonV1(attribution),
      context === null ? null : canonicalAttendanceJsonV1(context),
      canonicalAttendanceJsonV1(context?.segments ?? []),
      canonicalAttendanceJsonV1(evidence),
      canonicalAttendanceJsonV1({
        provenance,
        policySnapshot: input.write.policySnapshot,
        compatibilitySnapshot: {
          kind: 'legacy_import',
          projection: requireCompatibilityProjection(input.write),
        },
        rawEvidence: sourceEvidence,
      }),
      mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow',
      outcome,
      outcomeReasonCode,
      completed && mode === 'authoritative' ? 'set_active' : 'none',
      completed ? canonical.segments.length : 0,
      projection?.status ?? null,
      projection?.firstInAt ?? null,
      projection?.lastOutAt ?? null,
      projection?.workedMinutes ?? null,
      projection?.lateMinutes ?? null,
      projection?.earlyLeaveMinutes ?? null,
      projection ? projectedDailyFingerprint(projection) : null,
      canonicalAttendanceJsonV1(input.preimage),
      shadowDiff?.code ?? null,
      shadowDiff ? canonicalAttendanceJsonV1(shadowDiff) : null,
      input.job.actorId,
      `attendance-import:${input.job.batchId}`,
    ],
  )
  if (completed) {
    await insertCalculationSegments(trx, {
      orgId: input.job.orgId,
      recordId: input.write.recordId,
      calculationId,
      segments: canonical.segments,
    })
  }
  if (completed && mode === 'authoritative' && projection) {
    await trx.query(
      `UPDATE attendance_records
          SET status = $3, first_in_at = $4, last_out_at = $5,
              work_minutes = $6, late_minutes = $7, early_leave_minutes = $8,
              timezone = $9, projection_owner = 'w4', current_calculation_id = $10::uuid,
              visibility_state = 'active', visibility_reason = 'active', updated_at = now()
        WHERE id = $1::uuid AND org_id = $2`,
      [
        input.write.recordId,
        input.job.orgId,
        projection.status,
        projection.firstInAt,
        projection.lastOutAt,
        projection.workedMinutes,
        projection.lateMinutes,
        projection.earlyLeaveMinutes,
        context?.timezone ?? input.write.timezone,
        calculationId,
      ],
    )
  }
  const responseByOperationId: Record<string, unknown> = {}
  for (const item of sourceItems) {
    const identity = input.identitiesBySemanticOrdinal.get(item.semanticOrdinal)
    if (!identity) throw new Error('W4C3A_IMPORT_OPERATION_IDENTITY_MISSING')
    const response = Object.freeze({
      schemaVersion: 1,
      recordId: input.write.recordId,
      calculationId,
      outcome,
      reasonCode: outcomeReasonCode,
    })
    responseByOperationId[identity.id] = response
  }
  return Object.freeze({
    calculationId,
    responseByOperationId: Object.freeze(responseByOperationId),
    resultSemanticFingerprint: semanticFingerprint,
    resultProvenanceFingerprint: provenanceFingerprint,
  })
}

export async function executeAttendanceCanonicalImportPlanV1(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: AttendanceLegacyPlanWorkerJobV1
    plan: VerifiedAttendanceLegacyPlanV1
    registryClaim: AttendanceCanonicalImportRegistryClaimV1 | null
  }>,
): Promise<unknown> {
  const startedAt = Date.now()
  if (input.plan.manifest.batch.kind === 'idempotent_replay') {
    return buildAttendanceLegacyAsyncJobSummaryV1({
      plan: input.plan,
      effectResult: { groupCreated: 0, groupMembersAdded: 0 },
      elapsedMs:
        input.plan.manifest.batch.replaySelector === 'precheck_hit'
          ? 0
          : Math.max(0, Date.now() - startedAt),
    })
  }
  if (input.registryClaim !== null) {
    for (const write of input.plan.recordWrites) {
      parseCanonicalImportFreeze(write)
    }
  }
  const preimages =
    input.registryClaim === null
      ? new Map<string, Record<string, unknown>>()
      : await captureParentPreimages(trx, input.plan)
  const groupResult = await applyAttendanceLegacyGroupEffectsV1(trx, input.plan)
  await applyAttendanceLegacyBatchEffectsV1(trx, input.plan, groupResult)
  if (input.registryClaim === null || input.job.acceptedWritePosture === 'shadow') {
    await applyAttendanceLegacyRecordEffectsV1(trx, input.plan)
  }
  if (input.registryClaim !== null) {
    const identitiesBySemanticOrdinal = new Map<number, VerifiedAttendanceOperationIdentityV1>()
    const proofRows = identityProofRows(input.job)
    for (let index = 0; index < input.registryClaim.itemIdentities.length; index += 1) {
      identitiesBySemanticOrdinal.set(
        Number(proofRows[index]?.ordinal),
        input.registryClaim.itemIdentities[index],
      )
    }
    const byItem: Record<string, unknown> = {}
    const seals: Array<Readonly<{
      identity: VerifiedAttendanceOperationIdentityV1
      response: unknown
      recordId: string
      calculationId: string
      semanticFingerprint: string
      provenanceFingerprint: string
    }>> = []
    for (const write of input.plan.recordWrites) {
      const preimage = preimages.get(write.recordWriteId)
      if (!preimage) throw new Error('W4C3A_IMPORT_PREIMAGE_MISSING')
      const appended = await appendCanonicalCalculation(trx, {
        job: input.job,
        plan: input.plan,
        write,
        preimage,
        identitiesBySemanticOrdinal,
      })
      Object.assign(byItem, appended.responseByOperationId)
      for (const [operationId, response] of Object.entries(appended.responseByOperationId)) {
        const identity = input.registryClaim.itemIdentities.find((candidate) => candidate.id === operationId)
        if (!identity) throw new Error('W4C3A_IMPORT_OPERATION_IDENTITY_MISSING')
        seals.push({
          identity,
          response,
          recordId: write.recordId,
          calculationId: appended.calculationId,
          semanticFingerprint: appended.resultSemanticFingerprint,
          provenanceFingerprint: appended.resultProvenanceFingerprint,
        })
      }
    }
    await applyAttendanceLegacyItemEffectsV1(trx, input.plan)
    for (const seal of seals) {
      await sealAttendanceResultOperationV1(trx, seal.identity, {
        responseSnapshot: seal.response,
        resolvedRecordId: seal.recordId,
        resolvedCalculationId: seal.calculationId,
        resultSemanticFingerprint: seal.semanticFingerprint,
        resultProvenanceFingerprint: seal.provenanceFingerprint,
      })
    }
    await sealAttendanceResultOperationBatchV1(trx, input.registryClaim.batchIdentity, {
      order: input.registryClaim.itemIdentities.map((identity) => identity.id),
      byItem,
    })
  } else {
    await applyAttendanceLegacyItemEffectsV1(trx, input.plan)
  }
  return buildAttendanceLegacyAsyncJobSummaryV1({
    plan: input.plan,
    effectResult: groupResult,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  })
}
