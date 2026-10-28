import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { FrozenAttendanceContextV1 } from './w4c0-write-boundary-types'
import { calculateAttendanceSegmentsV1, validateFrozenContextShape } from './w4c1-segment-calculator'
import {
  verifyAttendanceImportAttributionSnapshotV1,
  verifyAttendanceImportPolicySourceFingerprintV1,
  type AttendanceImportAttributionFreezeBuildResultV1,
  type AttendanceImportPolicySourceProofV1,
} from './w4c3a-import-proof'
import {
  fingerprintAttendancePunchDetailCommandV1,
  readAttendancePunchDetailEnvelopeV1,
  requireAttendancePunchDetailPlanBindingV1,
  type AttendancePunchDetailJobEnvelopeV1,
} from './w4c3a-punch-detail-command'
import { expandAttendancePunchDetailEvidenceV1 } from './w4c3a-punch-detail-evidence'
import type { CommitAttendanceSyncImportPlanFromHostInputV1 } from './w4c3a-sync-import-host'

type Scope = Pick<CommitAttendanceSyncImportPlanFromHostInputV1,
  'orgId' | 'actorId' | 'actorPosture' | 'tokenSubjectUserId'>
export type AttendancePunchDetailPreparationInputV1 = Readonly<{
  scope: Scope
  batchId: string
  envelope: AttendancePunchDetailJobEnvelopeV1
  attribution: Extract<AttendanceImportAttributionFreezeBuildResultV1, { kind: 'resolved_v2' }>
  context: FrozenAttendanceContextV1
  policySourceProof: AttendanceImportPolicySourceProofV1
  chunkConfig: unknown
}>

function immutableCopy<T>(value: T): T {
  const copy = JSON.parse(canonicalAttendanceJsonV1(value)) as T
  const freeze = (current: unknown): void => {
    if (current !== null && typeof current === 'object') {
      Object.values(current).forEach(freeze)
      Object.freeze(current)
    }
  }
  freeze(copy)
  return copy
}

/**
 * Assemble a command from ONE server-resolved target/context and ALL physical
 * events. This pure adapter does not authorize, select a rollout posture, issue
 * a context, or acquire locks; the producer and commit/reservation hosts own
 * those gates. It never fabricates daily metrics for a review outcome.
 */
export function buildAttendancePunchDetailPreparedPlanV1(input: AttendancePunchDetailPreparationInputV1) {
  const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
  if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
  const command = envelope.__punchDetailInput
  const identity = { orgId: input.scope.orgId, userId: command.userId, workDate: command.workDate }
  const attribution = verifyAttendanceImportAttributionSnapshotV1({
    attribution: input.attribution.attribution,
    reconstruction: input.attribution.reconstruction,
    expectedIdentity: identity,
  })
  const context = input.context
  if (attribution.posture !== 'resolved_v2' || !validateFrozenContextShape(context)
    || context.orgId !== identity.orgId || context.userId !== identity.userId
    || context.workDate !== identity.workDate || context.timezone !== command.timezone
    || context.shiftId !== attribution.value.shiftId
    || input.attribution.reconstruction.timezone !== command.timezone) {
    throw new Error('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
  }
  const sourceDefinition = verifyAttendanceImportPolicySourceFingerprintV1(input.policySourceProof)
  if (sourceDefinition.rule.timezone !== command.timezone) {
    throw new Error('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
  }
  const raw = expandAttendancePunchDetailEvidenceV1(command, input.batchId)
  const evidence = raw.flatMap((item) => item.punches.map((punch) => ({
    kind: 'punch' as const,
    ref: `import:${input.batchId}:${item.sourceOrdinal}:${punch.direction}`,
    direction: punch.direction, occurredAt: punch.occurredAt, source: 'import' as const,
  })))
  const calculation = calculateAttendanceSegmentsV1({ attribution, context, evidence, approvedFacts: [] })
  const projection = calculation.outcome === 'completed' ? calculation.dailyProjection : null
  const output = {
    status: projection?.status ?? null,
    workMinutes: projection?.workedMinutes ?? null,
    lateMinutes: projection?.lateMinutes ?? null,
    earlyLeaveMinutes: projection?.earlyLeaveMinutes ?? null,
    leaveMinutes: projection ? 0 : null,
    overtimeMinutes: projection
      ? calculation.segments.reduce((total, segment) => total + segment.overtimeExtensionMinutes, 0)
      : null,
  }
  const requestFingerprint = fingerprintAttendancePunchDetailCommandV1(input.scope, envelope)
  const plan = {
    ...input.scope, batchId: input.batchId, idempotencyKey: envelope.idempotencyKey,
    payload: envelope, legacyInputFingerprint: requestFingerprint,
    legacyRowSourceKind: 'direct_rows' as const, legacySourceRowLimit: null,
    batch: {
      kind: 'normal' as const, source: 'manual' as const, ruleSetId: null,
      mappingSnapshot: { kind: 'punch_events_v1', envelope, requestFingerprint },
      sourceRowCount: raw.length, status: 'committed', idempotencyKey: envelope.idempotencyKey,
      visibilityRule: 'org', engine: envelope.__importEngine, chunkConfig: input.chunkConfig,
      recordUpsertStrategy: envelope.recordUpsertStrategy, itemsInsertStrategy: envelope.itemsInsertStrategy,
      mappingProfileId: null, compatibilityMetadata: { punchDetailRequestFingerprint: requestFingerprint },
      groupSync: null, itemReturnPolicy: { returnItems: false as const, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: { groupCreated: 'ensure_group_returned_row_count' as const,
        groupMembersAdded: 'ensure_member_inserted_row_count' as const },
    },
    artifactCleanup: { kind: 'none' as const },
    items: raw.map((rawEvidence, ordinal) => ({
      kind: 'apply' as const, ordinal, semanticOrdinal: ordinal,
      targetRef: JSON.stringify([identity.orgId, identity.userId, identity.workDate]),
      rawEvidence,
      previewSnapshot: { userId: command.userId, workDate: command.workDate, sourceOrdinal: ordinal,
        ...command.punches[ordinal], outcome: calculation.outcome, reasonCode: calculation.outcomeReasonCode },
    })),
    recordWrites: [{
      ...identity, timezone: command.timezone, sourceBatchId: input.batchId,
      sourceOrdinals: raw.map((item) => item.sourceOrdinal), mergeMode: 'override' as const,
      firstInAt: projection?.firstInAt ?? null, lastOutAt: projection?.lastOutAt ?? null,
      workMinutes: output.workMinutes, lateMinutes: output.lateMinutes, earlyLeaveMinutes: output.earlyLeaveMinutes,
      status: output.status, isWorkday: context.isWorkday,
      compatibilityMetadata: {}, profileSnapshot: null, multiPunchSnapshot: null, resultSlots: {},
      attributionSnapshot: { schemaVersion: 2, sources: raw.map(({ sourceOrdinal }) => ({
        sourceOrdinal, attribution, context, importAttributionReconstruction: input.attribution.reconstruction,
      })) },
      policySnapshot: { schemaVersion: 2, sources: raw.map(({ sourceOrdinal }) => ({
        sourceOrdinal, sourceFingerprint: input.policySourceProof.sourceFingerprint, sourceDefinition, output,
      })) },
    }],
    groupEffects: [],
  }
  requireAttendancePunchDetailPlanBindingV1({ ...plan, envelope: plan.payload })
  return immutableCopy({ plan, calculation })
}
