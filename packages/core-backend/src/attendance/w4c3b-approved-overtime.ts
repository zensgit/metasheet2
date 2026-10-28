/**
 * Bounded approved-OT candidate: prepare before terminal/financial DML, append
 * at the existing daily-record effect in the SAME execution. No policy lookup.
 * Shadow compares the actual legacy result; authoritative uses the locked
 * absent/legacy/current parent preimage. DG-OT-01 remains a separate gate. Errors must abort the execution.
 */
import {
  acquireAttendanceCalculationTargetLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
} from './w4c0-identity'
import {
  computeAttendanceCommandFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  type AttendanceInputProvenanceRefV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  type AttendanceSegmentCalculationResultV1,
} from './w4c1-segment-calculator'
import {
  writeAuthoritativeSegmentCalculationV1,
  type AttendanceAuthoritativeParentPreimageV1,
} from './w4c2-authoritative-calculation-core'
import {
  recordAttendanceRequestDecisionCalculationResultV1,
  requireAttendanceRequestDecisionCalculationWitnessV1,
  type AttendanceRequestDecisionCalculationWitnessV1,
  type AttendanceRequestOperationContextV1,
  type AttendanceRequestPluginTrxV1,
} from './w4c3b-request-operation-boundary'
import {
  buildBoundedApprovedOvertimeFactV1,
  refuse, json, same, frozenCopy, iso, readFrozenRequest,
  assertTerminalApproval,
  type FrozenInput, type Row,
} from './w4c3b-approved-overtime-inputs'
import {
  type AttendanceRequestTerminalBindResultV1,
  type lockAttendanceRequestSnapshotBeforeTerminalDecisionV1,
} from './w4c3b-request-snapshots'
import {
  prepareApprovedOvertimeShadowV1,
  appendApprovedOvertimeShadowV1,
  readNonCurrentApprovedOvertimeInputsV1,
  type PreparedOvertimeShadowV1,
} from './w4c3b-approved-overtime-shadow'
import { insertAuthoritativeReviewPlaceholderParentV1 } from './w4c2-live-scheduled-boundary'
import {
  readPreservedAuthoritativeCalculationInputsV1,
  type PreservedInputs,
} from './w4c2-preserved-calculation-inputs'
import { computeAttendanceImportRollbackPreimageFingerprintV1 } from './w4c3a-import-rollback'
import type {
  PreparedDailyProjectionV1,
} from './w4c0-write-boundary-types'

type Witness = AttendanceRequestDecisionCalculationWitnessV1
type BoundResult = Exclude<AttendanceRequestTerminalBindResultV1, { kind: 'legacy_skipped' }>
export type ApprovedOvertimePreTerminalSnapshotV1 = Exclude<
  Awaited<ReturnType<typeof lockAttendanceRequestSnapshotBeforeTerminalDecisionV1>>,
  { kind: 'legacy_skipped' }
>

declare const preparedOvertime: unique symbol
export type PreparedApprovedOvertimeCalculationV1 = { readonly [preparedOvertime]: true }

export interface PrepareApprovedOvertimeCalculationInputV1 {
  readonly facade: AttendanceRequestPluginTrxV1
  readonly operation: AttendanceRequestOperationContextV1
  readonly requestId: string
  readonly preTerminalSnapshot: ApprovedOvertimePreTerminalSnapshotV1
}

export interface AppendApprovedOvertimeCalculationInputV1 {
  readonly facade: AttendanceRequestPluginTrxV1
  readonly operation: AttendanceRequestOperationContextV1
  readonly prepared: PreparedApprovedOvertimeCalculationV1
  readonly bindResult: BoundResult
}

/** Calculation IDs and fingerprints stay in the core boundary, never this result. */
export interface ApprovedOvertimeCalculationResultV1 {
  readonly recordId: string
  readonly outcome: 'completed' | 'review_required'
  readonly dailyProjection: PreparedDailyProjectionV1 | null
}


interface AuthoritativePreparation {
  readonly kind: 'authoritative_bound'
  readonly facade: AttendanceRequestPluginTrxV1
  readonly operation: AttendanceRequestOperationContextV1
  readonly witness: Witness
  readonly frozen: FrozenInput
  readonly approvalInstanceId: string
  readonly approvalVersion: number
  readonly parent: Row
  readonly sourceParent: Row | null
  readonly preimage: AttendanceAuthoritativeParentPreimageV1
  readonly inputs: PreservedInputs
}

type Preparation = AuthoritativePreparation | {
  readonly kind: 'shadow'
  readonly facade: AttendanceRequestPluginTrxV1
  readonly operation: AttendanceRequestOperationContextV1
  readonly witness: Witness
  readonly shadow: PreparedOvertimeShadowV1
}

const preparations = new WeakMap<PreparedApprovedOvertimeCalculationV1, Preparation>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function liveWitness(facade: AttendanceRequestPluginTrxV1, operation: AttendanceRequestOperationContextV1): Witness {
  const witness = requireAttendanceRequestDecisionCalculationWitnessV1(facade, operation)
  if (witness.identity.entrypoint !== 'request_decision' || witness.identity.kind !== 'item'
    || witness.identity.org !== witness.org || witness.identity.id !== operation.operationId
    || witness.org.acceptedWritePosture !== operation.acceptedWritePosture) {
    refuse('ATTENDANCE_OVERTIME_OPERATION_MISMATCH')
  }
  if (operation.acceptedWritePosture !== 'authoritative' && operation.acceptedWritePosture !== 'shadow') refuse('ATTENDANCE_OVERTIME_POSTURE_UNSUPPORTED')
  return witness
}

async function readParent(witness: Witness, workDate: string): Promise<Row | null> {
  const result = await witness.trx.query(
    `SELECT id::text AS id, org_id, user_id, work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason, timezone, is_workday,
            status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
            meta, source_batch_id::text AS source_batch_id
       FROM attendance_records
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date FOR UPDATE`,
    [witness.org.orgId, witness.subjectUserId, workDate],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1) refuse('ATTENDANCE_OVERTIME_PARENT_AMBIGUOUS')
  const row = result.rows[0]
  const placeholder = row.visibility_state === 'retired' && row.visibility_reason === 'review_placeholder'
    && row.projection_owner === 'legacy_untracked' && row.current_calculation_id === null
  if (!placeholder && (row.visibility_state !== 'active' || row.visibility_reason !== 'active')) {
    refuse('ATTENDANCE_OVERTIME_RETIRED_PARENT')
  }
  const legacy = row.projection_owner === 'legacy_untracked' && row.current_calculation_id === null
  const owned = (row.projection_owner === 'w4' || row.projection_owner === 'w4_group')
    && typeof row.current_calculation_id === 'string' && UUID.test(row.current_calculation_id)
  if ((!legacy && !owned) || typeof row.id !== 'string' || !UUID.test(row.id)
    || row.org_id !== witness.org.orgId || row.user_id !== witness.subjectUserId || row.work_date !== workDate
    || typeof row.timezone !== 'string' || typeof row.is_workday !== 'boolean' || typeof row.status !== 'string') {
    refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  }
  for (const field of ['work_minutes', 'late_minutes', 'early_leave_minutes']) {
    if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 0) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
  }
  return frozenCopy({ ...row, meta: json(row.meta), first_in_at: iso(row.first_in_at), last_out_at: iso(row.last_out_at) })
}

function parentPreimage(parent: Row | null): AttendanceAuthoritativeParentPreimageV1 {
  if (parent === null) return { posture: 'absent' }
  const input = {
    projectionOwner: parent.projection_owner as 'legacy_untracked' | 'w4' | 'w4_group',
    currentCalculationId: parent.current_calculation_id as string | null,
    visibilityState: parent.visibility_state as 'active' | 'retired',
    visibilityReason: parent.visibility_reason as 'active' | 'review_placeholder',
    projection: {
      status: String(parent.status), firstInAt: parent.first_in_at as string | null,
      lastOutAt: parent.last_out_at as string | null, workMinutes: Number(parent.work_minutes),
      lateMinutes: Number(parent.late_minutes), earlyLeaveMinutes: Number(parent.early_leave_minutes),
    },
  }
  return { posture: 'present', ...input,
    compatibilityFingerprint: computeAttendanceImportRollbackPreimageFingerprintV1(input) }
}

async function readAuthoritativeInputs(
  witness: Witness, parent: Row | null, frozen: FrozenInput,
): Promise<PreservedInputs> {
  if (parent !== null && parent.current_calculation_id !== null) {
    return readPreservedAuthoritativeCalculationInputsV1(witness, parent, frozen, frozen.snapshot.requestId)
  }
  return readNonCurrentApprovedOvertimeInputsV1(
    witness, parent, { payload: frozen.payload, frozen }, frozen.snapshot.requestId,
  )
}


export async function prepareApprovedOvertimeCalculationV1(
  input: PrepareApprovedOvertimeCalculationInputV1,
): Promise<PreparedApprovedOvertimeCalculationV1> {
  const { facade, operation, requestId } = input
  const witness = liveWitness(facade, operation)
  const preTerminal = frozenCopy(input.preTerminalSnapshot)
  if (operation.acceptedWritePosture === 'shadow') {
    const shadow = await prepareApprovedOvertimeShadowV1(witness, requestId, preTerminal)
    if (liveWitness(facade, operation) !== witness) refuse('ATTENDANCE_OVERTIME_OPERATION_MISMATCH')
    const handle = Object.freeze(Object.create(null)) as PreparedApprovedOvertimeCalculationV1
    preparations.set(handle, { kind: 'shadow', facade, operation, witness, shadow })
    return handle
  }
  const { request, frozen } = await readFrozenRequest(witness, requestId, 'pending', true)
  if (preTerminal?.kind !== 'locked' || preTerminal.writePosture !== 'authoritative'
    || !same(preTerminal.snapshot, frozen.snapshot)) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_VERSION_CONFLICT')
  }
  const approvalInstanceId = request.approval_instance_id
  if (typeof approvalInstanceId !== 'string' || approvalInstanceId.length === 0) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
  }
  const approval = await witness.trx.query(
    `SELECT version FROM approval_instances WHERE id = $1 AND status = 'pending' FOR UPDATE`,
    [approvalInstanceId],
  )
  const approvalVersion = Number(approval.rows[0]?.version)
  if (approval.rows.length !== 1 || !Number.isSafeInteger(approvalVersion) || approvalVersion < 0) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
  }
  const target = createVerifiedAttendanceCalculationTargetIdentityV1({
    org: witness.org, userId: witness.subjectUserId, workDate: frozen.payload.workDate,
  })
  await acquireAttendanceCalculationTargetLocks(witness.trx, [target])
  let parent = await readParent(witness, frozen.payload.workDate)
  let sourceParent = parent
  if (parent === null) {
    if (frozen.context === null) refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
    // First business DML, before approval/financial effects. On a conflict,
    // re-read and classify the actual winner instead of claiming an absent preimage.
    const inserted = await insertAuthoritativeReviewPlaceholderParentV1(witness.trx, {
      orgId: witness.org.orgId, userId: witness.subjectUserId, workDate: frozen.payload.workDate,
      timezone: frozen.context.timezone, isWorkday: frozen.context.isWorkday,
    })
    parent = await readParent(witness, frozen.payload.workDate)
    if (parent === null) refuse('ATTENDANCE_OVERTIME_RESULT_RECORD_MISSING')
    if (!inserted.created) sourceParent = parent
  }
  const preimage = parentPreimage(sourceParent)
  const inputs = await readAuthoritativeInputs(witness, sourceParent, frozen)
  if (liveWitness(facade, operation) !== witness) refuse('ATTENDANCE_OVERTIME_OPERATION_MISMATCH')
  const handle = Object.freeze(Object.create(null)) as PreparedApprovedOvertimeCalculationV1
  preparations.set(handle, {
    kind: 'authoritative_bound', facade, operation, witness, frozen,
    approvalInstanceId, approvalVersion, parent, sourceParent, preimage, inputs,
  })
  return handle
}


/** Read only request-frozen projection metadata; this does not consume the handle. */
export function readPreparedApprovedOvertimeContextV1(
  facade: AttendanceRequestPluginTrxV1,
  operation: AttendanceRequestOperationContextV1,
  handle: PreparedApprovedOvertimeCalculationV1,
): Readonly<{ timezone: string; isWorkday: boolean }> {
  const witness = liveWitness(facade, operation)
  const plan = preparations.get(handle)
  if (!plan || plan.facade !== facade || plan.operation !== operation || plan.witness !== witness) {
    refuse('ATTENDANCE_OVERTIME_PREPARATION_REQUIRED')
  }
  if (plan.kind !== 'authoritative_bound') refuse('ATTENDANCE_OVERTIME_POSTURE_UNSUPPORTED')
  const context = plan.frozen.context
  if (context === null) refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
  return Object.freeze({ timezone: context.timezone, isWorkday: context.isWorkday })
}

export async function appendApprovedOvertimeCalculationV1(
  input: AppendApprovedOvertimeCalculationInputV1,
): Promise<ApprovedOvertimeCalculationResultV1> {
  const { facade, operation, prepared } = input
  const witness = liveWitness(facade, operation)
  const plan = preparations.get(prepared)
  if (!plan || plan.facade !== facade || plan.operation !== operation || plan.witness !== witness) {
    refuse('ATTENDANCE_OVERTIME_PREPARATION_REQUIRED')
  }
  // One attempt per handle, including concurrent callers. Failure must abort
  // the owning execution, never commit the preceding terminal/financial DML.
  preparations.delete(prepared)
  // Detach from caller-owned bindResult before the first await.
  const bound = frozenCopy(input.bindResult)
  if (plan.kind === 'shadow') {
    return appendApprovedOvertimeShadowV1(facade, operation, witness, plan.shadow, bound)
  }
  if (bound?.kind !== 'bound' || bound.writePosture !== 'authoritative'
    || !same(bound.snapshot, plan.frozen.snapshot)) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  }
  const { request, frozen } = await readFrozenRequest(witness, plan.frozen.snapshot.requestId, 'approved', true)
  if (!same(frozen, plan.frozen) || request.approval_instance_id !== plan.approvalInstanceId) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_CONTEXT_MISMATCH')
  }
  const fact = buildBoundedApprovedOvertimeFactV1(frozen, bound.binding)
  await assertTerminalApproval(witness, request, bound.binding, plan.approvalVersion)
  const parent = await readParent(witness, frozen.payload.workDate)
  if (parent === null || !same(parent, plan.parent)) refuse('ATTENDANCE_OVERTIME_PARENT_CHANGED')
  const preserved = await readAuthoritativeInputs(witness, plan.sourceParent, frozen)
  if (!same(preserved, plan.inputs)) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_CHANGED')
  const approvedFacts = [...preserved.approvedFacts, fact]
  const calculation: AttendanceSegmentCalculationResultV1 = preserved.reviewReason === null
    ? calculateAttendanceSegmentsV1({
      attribution: frozen.attribution, context: frozen.context,
      evidence: preserved.evidence, approvedFacts,
    })
    : { outcome: 'review_required', outcomeReasonCode: preserved.reviewReason, segments: [], dailyProjection: null }
  const provenanceRef: AttendanceInputProvenanceRefV1 = {
    transport: 'approved_request', sourceRef: frozen.snapshot.requestId,
    artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
  }
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution: frozen.attribution, context: frozen.context,
    evidence: preserved.evidence, approvedFacts, manualOverride: preserved.manualOverride,
    mergePolicy: 'merge', calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
  })
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(provenanceRef)
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
    attribution: frozen.attribution, context: frozen.context,
  })
  const payloadFingerprint = computeAttendanceCommandFingerprintV1({
    kind: 'approved_overtime', requestId: frozen.snapshot.requestId,
    binding: bound.binding, semanticFingerprint, provenanceFingerprint, sourceDefinitionFingerprint,
  })
  // Recheck after async validation, immediately before the only persistence call.
  if (liveWitness(facade, operation) !== witness) refuse('ATTENDANCE_OVERTIME_OPERATION_MISMATCH')
  const written = await writeAuthoritativeSegmentCalculationV1(witness.trx, {
    orgId: witness.org.orgId, recordId: String(parent.id), entrypoint: 'approved_overtime',
    operationId: witness.identity.id, calculation, attribution: frozen.attribution, context: frozen.context,
    evidence: preserved.evidence, approvedFacts, manualOverride: preserved.manualOverride, mergePolicy: 'merge',
    provenanceRef, inputProvenance: {
      ...provenanceRef, payloadFingerprint, priorCalculations: preserved.priorCalculations,
    },
    payloadFingerprint, preimage: plan.preimage, expectedCurrentCalculationId: parent.current_calculation_id as string | null,
    actorId: witness.actorId, correlationId: operation.correlationId,
  })
  // Resolve actual stored proof; do not echo an intended hash or caller-supplied ID.
  const stored = await witness.trx.query(
    `SELECT id::text AS id, semantic_input_fingerprint, provenance_fingerprint,
            source_definition_fingerprint, outcome, projection_effect, projected_status,
            projected_first_in_at, projected_last_out_at, projected_work_minutes,
            projected_late_minutes, projected_early_leave_minutes
       FROM attendance_record_calculations
      WHERE id = $1::uuid AND org_id = $2 AND attendance_record_id = $3::uuid
        AND entrypoint = 'approved_overtime' AND operation_id = $4::uuid AND mode = 'authoritative'`,
    [written.calculationId, witness.org.orgId, parent.id, witness.identity.id],
  )
  const row = stored.rows[0]
  if (stored.rows.length !== 1 || row.semantic_input_fingerprint !== semanticFingerprint
    || row.provenance_fingerprint !== provenanceFingerprint
    || row.source_definition_fingerprint !== sourceDefinitionFingerprint
    || row.outcome !== calculation.outcome
    || row.projection_effect !== (calculation.outcome === 'completed' ? 'set_active' : 'none')) {
    refuse('ATTENDANCE_OVERTIME_RESULT_PROOF_MISMATCH')
  }
  const after = await readParent(witness, frozen.payload.workDate)
  if (after === null || after.current_calculation_id !== (calculation.outcome === 'completed'
    ? written.calculationId : parent.current_calculation_id)
    || (calculation.outcome === 'review_required' && (!same(after, parent)
      || ['projected_status', 'projected_first_in_at', 'projected_last_out_at',
        'projected_work_minutes', 'projected_late_minutes', 'projected_early_leave_minutes']
        .some((field) => row[field] !== null)))) {
    refuse('ATTENDANCE_OVERTIME_RESULT_PROOF_MISMATCH')
  }
  const dailyProjection: PreparedDailyProjectionV1 | null = calculation.outcome === 'completed' ? {
    status: String(row.projected_status), firstInAt: iso(row.projected_first_in_at),
    lastOutAt: iso(row.projected_last_out_at), workedMinutes: Number(row.projected_work_minutes),
    lateMinutes: Number(row.projected_late_minutes), earlyLeaveMinutes: Number(row.projected_early_leave_minutes),
    timezone: frozen.context!.timezone, workDate: frozen.payload.workDate, meta: null,
  } : null
  recordAttendanceRequestDecisionCalculationResultV1(facade, operation, {
    resolvedRecordId: String(parent.id), resolvedCalculationId: written.calculationId,
    resultSemanticFingerprint: String(row.semantic_input_fingerprint),
    resultProvenanceFingerprint: String(row.provenance_fingerprint),
  })
  return frozenCopy({ recordId: String(parent.id), outcome: calculation.outcome, dailyProjection })
}
