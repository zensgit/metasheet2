import {
  createAuthorizedAttendanceWriteContextV1,
  type AttendanceActorPostureV1,
} from './w4c0-authorization'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
} from './w4c0-fingerprints'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceAcceptedWritePostureV1,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import {
  W4_MAX_BATCH_ITEMS,
  W4_MAX_DISTINCT_TARGETS,
} from './w4c0-operation-contract'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
  sha256HexOfCanonicalJsonV1,
  type AttendanceLegacyRowSourceKindV1,
  type LegacyImportArtifactCleanupV1,
  type LegacyImportBatchPlanV1,
  type LegacyImportPublicJobEnvelopeV1,
} from './w4c3a-legacy-execution-plan'
import {
  reserveAttendanceLegacyImportPlanJobV1,
  type LegacyImportGroupEffectDraftV1,
  type LegacyImportItemDraftV1,
  type LegacyImportRecordWriteDraftV1,
  type ReserveAttendanceLegacyImportPlanJobResultV1,
} from './w4c3a-legacy-plan-enqueue'

export type AttendanceLegacyPlanReservationHostConnectionV1 =
  AttendanceW4TransactionClientV1

export type AttendanceLegacyPlanReservationHostDepsV1 = Readonly<{
  acquireConnection(): Promise<{
    client: AttendanceLegacyPlanReservationHostConnectionV1
    release(): void
  }>
}>

export type ReserveAttendanceLegacyImportPlanFromHostInputV1 = Readonly<{
  orgId: string
  actorId: string
  actorPosture: AttendanceActorPostureV1
  tokenSubjectUserId: string | null
  batchId: string
  idempotencyKey: string | null
  legacyInputFingerprint: string
  payload: LegacyImportPublicJobEnvelopeV1
  legacyRowSourceKind: AttendanceLegacyRowSourceKindV1
  legacySourceRowLimit: number | null
  batch: Extract<LegacyImportBatchPlanV1, { kind: 'normal' }>
  artifactCleanup: LegacyImportArtifactCleanupV1
  items: readonly LegacyImportItemDraftV1[]
  recordWrites: readonly LegacyImportRecordWriteDraftV1[]
  groupEffects: readonly LegacyImportGroupEffectDraftV1[]
}>

export type AttendanceLegacyPlanReservationHostV1 = Readonly<{
  reserveLegacyImportPlanV1(
    input: ReserveAttendanceLegacyImportPlanFromHostInputV1,
  ): Promise<ReserveAttendanceLegacyImportPlanJobResultV1>
}>

function validateHostInputBeforeConnection(
  input: ReserveAttendanceLegacyImportPlanFromHostInputV1,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(input.items) ||
    !Array.isArray(input.recordWrites) ||
    !Array.isArray(input.groupEffects)
  ) {
    throw new Error('W4C3A_RESERVATION_HOST_INPUT_INVALID')
  }
  if (input.items.length !== input.batch.sourceRowCount) {
    throw new Error('W4C3A_RESERVATION_HOST_SOURCE_COUNT_MISMATCH')
  }
  if (!/^[0-9a-f]{64}$/.test(input.legacyInputFingerprint)) {
    throw new Error('W4C3A_RESERVATION_HOST_LEGACY_INPUT_FP_INVALID')
  }
}

function targetRefForRecordWrite(
  row: LegacyImportRecordWriteDraftV1,
): string {
  return JSON.stringify([row.orgId, row.userId, row.workDate])
}

export function resolveAttendanceLegacyPlanOperationalBranchV1(input: {
  itemCount: number
  distinctTargetCount: number
  acceptedWritePosture: AttendanceAcceptedWritePostureV1
}): 'strict_targeted' | 'operational_only_no_target' | 'operational_only_batch_limit' {
  const exceedsW4Limit =
    input.itemCount > W4_MAX_BATCH_ITEMS ||
    input.distinctTargetCount > W4_MAX_DISTINCT_TARGETS
  if (exceedsW4Limit && input.acceptedWritePosture === 'authoritative') {
    throw new Error('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')
  }
  if (input.itemCount === 0) return 'operational_only_no_target'
  return exceedsW4Limit
    ? 'operational_only_batch_limit'
    : 'strict_targeted'
}

export function createAttendanceLegacyPlanReservationHostV1(
  deps: AttendanceLegacyPlanReservationHostDepsV1,
): AttendanceLegacyPlanReservationHostV1 {
  if (
    typeof deps !== 'object' ||
    deps === null ||
    typeof deps.acquireConnection !== 'function'
  ) {
    throw new Error('W4C3A_RESERVATION_HOST_DEPS_INVALID')
  }

  return Object.freeze({
    async reserveLegacyImportPlanV1(input) {
      validateHostInputBeforeConnection(input)
      const acquired = await deps.acquireConnection()
      // Freshly-acquired, idle-on-entry connection — NOT a transaction handle yet (the wrapper
      // below opens the transaction on it after `assertConnectionIsIdleV1` certifies idle).
      const connection = acquired.client
      try {
        return await runAttendanceResultOperationTransactionV1(connection, async () => {
        const posture = await resolveSegmentCalculationPosture(connection, input.orgId)
        const org = createVerifiedAttendanceOrgIdentityV1({
          orgKey: input.orgId,
          posture,
        })
        const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'batch',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_batch',
            batchCommandId: input.batchId,
          },
        })
        const sourceRef = `attendance-import:${input.batchId}`
        const authorization = createAuthorizedAttendanceWriteContextV1({
          actorId: input.actorId,
          actorPosture: input.actorPosture,
          tokenSubjectUserId: input.tokenSubjectUserId,
          orgId: input.orgId,
          subjectScope: { kind: 'self', userId: input.actorId },
          capability: 'import',
          sourceRef,
        })

        const applyItems = input.items
          .filter(
            (item): item is Extract<LegacyImportItemDraftV1, { kind: 'apply' }> =>
              item.kind === 'apply',
          )
          .sort((left, right) => left.semanticOrdinal - right.semanticOrdinal)
        const distinctTargets = new Set(
          input.recordWrites.map(targetRefForRecordWrite),
        )
        const operationalBranch = resolveAttendanceLegacyPlanOperationalBranchV1({
          itemCount: applyItems.length,
          distinctTargetCount: distinctTargets.size,
          acceptedWritePosture: org.acceptedWritePosture,
        })
        const commandFingerprint = sha256HexOfCanonicalJsonV1({
          batchId: input.batchId,
          payload: input.payload,
          batch: input.batch,
          items: input.items,
          recordWrites: input.recordWrites,
          groupEffects: input.groupEffects,
        })
        const legacyInputFingerprint = input.legacyInputFingerprint
        const itemIdentities = applyItems.map((item) => {
          const semanticFingerprint = sha256HexOfCanonicalJsonV1({
            semanticOrdinal: item.semanticOrdinal,
            targetRef: item.targetRef,
            previewSnapshot: item.previewSnapshot,
          })
          const identity = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'import_batch',
            source: {
              sourceKind: 'import_item',
              batchCommandId: input.batchId,
              ordinal: item.semanticOrdinal,
              semanticFingerprint,
            },
          })
          return {
            identity,
            semanticFingerprint,
            commandFingerprint: sha256HexOfCanonicalJsonV1({
              commandFingerprint,
              semanticOrdinal: item.semanticOrdinal,
              targetRef: item.targetRef,
            }),
          }
        })
        const fingerprintEntries = itemIdentities.map((item) => ({
          ordinal: item.identity.sourceProof.ordinal ?? '',
          operationId: item.identity.id,
          commandFingerprint: item.commandFingerprint,
        }))
        const identityProofVector =
          operationalBranch === 'strict_targeted'
            ? itemIdentities.map((item, ordinal) => ({
                ordinal,
                semanticFingerprint: item.semanticFingerprint,
                derivedOperationId: item.identity.id,
                commandFingerprint: item.commandFingerprint,
              }))
            : []

        return reserveAttendanceLegacyImportPlanJobV1(
          connection,
          authorization,
          {
            batchIdentity,
            itemIdentities: itemIdentities.map((item) => ({
              identity: item.identity,
              commandFingerprint: item.commandFingerprint,
            })),
            job: {
              orgId: input.orgId,
              batchId: input.batchId,
              createdBy: input.actorId,
              idempotencyKey: input.idempotencyKey,
              total: input.items.length,
              payload: input.payload,
              w4Entrypoint: 'import_batch',
              w4BatchCommandId: input.batchId,
              w4SourceKind: 'import_batch',
              w4SourceRef: sourceRef,
              w4ActorId: input.actorId,
              w4ActorPosture: input.actorPosture,
              w4TokenSubjectUserId: input.tokenSubjectUserId,
              w4CommandFingerprint: commandFingerprint,
              w4AcceptedWritePosture: org.acceptedWritePosture,
              w4ItemCount: applyItems.length,
              w4ItemSequenceFingerprint:
                fingerprintEntries.length === 0
                  ? ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1
                  : computeAttendanceItemSequenceFingerprintV1(fingerprintEntries),
              w4ItemSetFingerprint:
                fingerprintEntries.length === 0
                  ? ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1
                  : computeAttendanceItemSetFingerprintV1(fingerprintEntries),
              w4IdentityProofVector: identityProofVector,
              w4DistinctTargetCount: distinctTargets.size,
              w4OperationalBranch: operationalBranch,
              w4LegacyInputFingerprint: legacyInputFingerprint,
            },
            manifestSeed: {
              schemaVersion: 1,
              orgId: input.orgId,
              batchId: input.batchId,
              sourceKind: 'import_batch',
              sourceRef,
              createdBy: input.actorId,
              actorId: input.actorId,
              actorPosture: input.actorPosture,
              tokenSubjectUserId: input.tokenSubjectUserId,
              acceptedWritePosture: org.acceptedWritePosture,
              commandFingerprint,
              legacyInputFingerprint,
              operationalBranch,
              legacyRowSourceKind: input.legacyRowSourceKind,
              sourceRowCount: input.items.length,
              w4ItemCount: applyItems.length,
              w4DistinctTargetCount: distinctTargets.size,
              w4ItemSequenceFingerprint:
                fingerprintEntries.length === 0
                  ? ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1
                  : computeAttendanceItemSequenceFingerprintV1(fingerprintEntries),
              w4ItemSetFingerprint:
                fingerprintEntries.length === 0
                  ? ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1
                  : computeAttendanceItemSetFingerprintV1(fingerprintEntries),
              legacySourceRowLimit: input.legacySourceRowLimit,
              batch: input.batch,
              artifactCleanup: input.artifactCleanup,
            },
            items: input.items,
            recordWrites: input.recordWrites,
            groupEffects: input.groupEffects,
          },
        )
        })
      } finally {
        acquired.release()
      }
    },
  })
}
