/**
 * W4C-3a P06 — pure helpers for the modern synchronous import cutover.
 *
 * Builds the synthetic in-memory job context, sync batch meta (no async:true),
 * and the governing synchronous HTTP response shape. Never creates V1
 * job/plan/chunk/terminal rows and never calls the private queue processor.
 *
 * Authority: design lock §12.4; durable-legacy-plan amendment §5.1 P06 path;
 * result-slots amendment (P06 retains independent response serializer).
 */
import type { AttendanceLegacyGroupEffectResultV1 } from './w4c3a-legacy-plan-group-effects'
import type {
  LegacyImportBatchPlanV1,
  LegacyImportItemPlanV1,
} from './w4c3a-legacy-execution-plan'
import type {
  AttendanceLegacyPlanWorkerJobV1,
  VerifiedAttendanceLegacyPlanV1,
} from './w4c3a-legacy-plan-worker'

export class AttendanceSyncImportError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceSyncImportError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceSyncImportError(code)
}

function requireNormalBatch(
  batch: LegacyImportBatchPlanV1,
): Extract<LegacyImportBatchPlanV1, { kind: 'normal' }> {
  if (batch.kind !== 'normal') fail('W4C3A_SYNC_PLAN_BATCH_MISMATCH')
  return batch
}

function buildSkippedSample(
  plan: VerifiedAttendanceLegacyPlanV1,
  limit: number,
): ReadonlyArray<
  Readonly<{
    userId: string | null
    workDate: string | null
    warnings: readonly unknown[]
  }>
> {
  const sample: Array<{
    userId: string | null
    workDate: string | null
    warnings: readonly unknown[]
  }> = []
  let skippedRank = 0
  for (const item of plan.items) {
    if (item.kind !== 'skip') continue
    if (skippedRank < limit && sample.length < 50) {
      sample.push({
        userId: item.resolvedUserId,
        workDate: item.resolvedWorkDate,
        warnings: item.warnings,
      })
    }
    skippedRank += 1
  }
  return Object.freeze(sample)
}

/**
 * Sync-first-execution batch meta: same closed leaves as the async adapter
 * except it never stamps `async: true` (governing synchronous HTTP bytes).
 */
export function buildAttendanceSyncImportBatchMetaV1(
  plan: VerifiedAttendanceLegacyPlanV1,
  effectResult: AttendanceLegacyGroupEffectResultV1,
): Record<string, unknown> {
  const batch = requireNormalBatch(plan.manifest.batch)
  const skippedCount = plan.items.filter((item) => item.kind === 'skip').length
  const skippedRows = buildSkippedSample(plan, batch.skippedSamplePolicy.limit)
  const hasMemberEffect = plan.groupEffects.some(
    (effect) => effect.kind === 'ensure_member',
  )

  const compatibilityMetadata =
    typeof batch.compatibilityMetadata === 'object' &&
    batch.compatibilityMetadata !== null &&
    !Array.isArray(batch.compatibilityMetadata)
      ? batch.compatibilityMetadata
      : {}

  const meta: Record<string, unknown> = {
    ...compatibilityMetadata,
    engine: batch.engine,
    chunkConfig: batch.chunkConfig,
    recordUpsertStrategy: batch.recordUpsertStrategy,
    itemsInsertStrategy: batch.itemsInsertStrategy,
    mappingProfileId: batch.mappingProfileId,
    groupCreated: effectResult.groupCreated,
  }
  if (batch.idempotencyKey !== null) {
    meta.idempotencyKey = batch.idempotencyKey
  } else {
    delete meta.idempotencyKey
  }
  if (batch.groupSync !== null) {
    meta.groupSync = batch.groupSync
  } else {
    delete meta.groupSync
  }
  if (hasMemberEffect) {
    meta.groupMembersAdded = effectResult.groupMembersAdded
  }
  if (skippedCount > 0) {
    meta.skippedCount = skippedCount
    meta.skippedRows = skippedRows
  } else {
    delete meta.skippedCount
    delete meta.skippedRows
  }
  // Synchronous path never persists the async compact terminal contract.
  delete meta.async
  return meta
}

export type AttendanceSyncImportItemReturnV1 = Readonly<{
  returnItems: boolean
  itemsLimit: number | null
}>

export type AttendanceSyncImportResponseV1 = Readonly<{
  batchId: string
  imported: number
  processedRows: number
  failedRows: number
  elapsedMs: number
  engine: string
  recordUpsertStrategy: string
  items: readonly Readonly<{
    id: string
    userId: string
    workDate: string
    engine: unknown
  }>[]
  itemsTruncated: boolean
  skipped: readonly Readonly<{
    userId: string | null
    workDate: string | null
    warnings: readonly unknown[]
  }>[]
  csvWarnings: readonly string[]
  groupWarnings: readonly string[]
  meta: Record<string, unknown>
  idempotent?: true
}>

function previewEngine(item: Extract<LegacyImportItemPlanV1, { kind: 'apply' }>): unknown {
  const snapshot = item.previewSnapshot
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    Object.prototype.hasOwnProperty.call(snapshot, 'engine')
  ) {
    return (snapshot as Record<string, unknown>).engine
  }
  return null
}

/**
 * Governing synchronous HTTP body for first execution. Uses the verified plan
 * plus closed effect result; never rebuilds from current rules/settings.
 */
export function buildAttendanceSyncImportResponseV1(input: {
  readonly plan: VerifiedAttendanceLegacyPlanV1
  readonly effectResult: AttendanceLegacyGroupEffectResultV1
  readonly elapsedMs: number
  readonly itemReturnPolicy: AttendanceSyncImportItemReturnV1
  readonly csvWarnings: readonly string[]
  readonly groupWarnings: readonly string[]
}): AttendanceSyncImportResponseV1 {
  const batch = requireNormalBatch(input.plan.manifest.batch)
  const applyItems = input.plan.items.filter(
    (item): item is Extract<LegacyImportItemPlanV1, { kind: 'apply' }> =>
      item.kind === 'apply',
  )
  const skipItems = input.plan.items.filter(
    (item): item is Extract<LegacyImportItemPlanV1, { kind: 'skip' }> =>
      item.kind === 'skip',
  )
  const writeById = new Map(
    input.plan.recordWrites.map((write) => [write.recordWriteId, write]),
  )
  const imported = applyItems.length
  const failedRows = skipItems.length
  const skipped = skipItems.map((item) =>
    Object.freeze({
      userId: item.resolvedUserId,
      workDate: item.resolvedWorkDate,
      warnings: item.warnings,
    }),
  )

  let items: Array<{
    id: string
    userId: string
    workDate: string
    engine: unknown
  }> = []
  let itemsTruncated = false
  if (input.itemReturnPolicy.returnItems) {
    const limit = input.itemReturnPolicy.itemsLimit
    for (const item of applyItems) {
      const write = writeById.get(item.recordWriteRef)
      if (!write) fail('W4C3A_SYNC_ITEM_RECORD_REF_MISSING')
      if (limit !== null && items.length >= limit) {
        itemsTruncated = true
        break
      }
      items.push({
        id: write.recordId,
        userId: write.userId,
        workDate: write.workDate,
        engine: previewEngine(item),
      })
    }
    if (limit !== null && imported > items.length) itemsTruncated = true
  }

  const meta = buildAttendanceSyncImportBatchMetaV1(
    input.plan,
    input.effectResult,
  )

  return Object.freeze({
    batchId: input.plan.manifest.batchId,
    imported,
    processedRows: imported,
    failedRows,
    elapsedMs: Math.max(0, input.elapsedMs),
    engine: batch.engine,
    recordUpsertStrategy: batch.recordUpsertStrategy,
    items: Object.freeze(items),
    itemsTruncated,
    skipped: Object.freeze(skipped),
    csvWarnings: Object.freeze([...input.csvWarnings]),
    groupWarnings: Object.freeze([...input.groupWarnings]),
    meta,
  })
}

export function buildAttendanceSyncImportIdempotentResponseV1(input: {
  readonly batchId: string
  readonly imported: number
  readonly skipped: number
  readonly engine: string
  readonly recordUpsertStrategy: string
  readonly meta: Record<string, unknown>
  readonly elapsedMs: number
}): AttendanceSyncImportResponseV1 {
  return Object.freeze({
    batchId: input.batchId,
    imported: input.imported,
    processedRows: input.imported,
    failedRows: input.skipped,
    elapsedMs: Math.max(0, input.elapsedMs),
    engine: input.engine,
    recordUpsertStrategy: input.recordUpsertStrategy,
    items: Object.freeze([]),
    itemsTruncated: false,
    skipped: Object.freeze([]),
    csvWarnings: Object.freeze([]),
    groupWarnings: Object.freeze([]),
    meta: input.meta,
    idempotent: true as const,
  })
}

/**
 * Synthetic values-free job context for the shared claim/execute adapters.
 * Never persisted; jobId is only an in-memory sentinel.
 */
export function buildAttendanceSyncImportSyntheticJobV1(input: {
  readonly orgId: string
  readonly batchId: string
  readonly actorId: string
  readonly actorPosture: string
  readonly tokenSubjectUserId: string | null
  readonly acceptedWritePosture:
    | 'legacy_projection_only'
    | 'shadow'
    | 'authoritative'
  readonly commandFingerprint: string
  readonly legacyInputFingerprint: string
  readonly operationalBranch: string
  readonly identityProofVector: unknown
  readonly itemCount: number
  readonly distinctTargetCount: number
  readonly itemSequenceFingerprint: string
  readonly itemSetFingerprint: string
  readonly planDigest: string
  readonly idempotencyKey: string | null
  readonly sourceRef: string
}): AttendanceLegacyPlanWorkerJobV1 {
  return Object.freeze({
    jobId: '00000000-0000-4000-8000-000000000000',
    orgId: input.orgId,
    status: 'running',
    w4ContractVersion: 1,
    batchId: input.batchId,
    idempotencyKey: input.idempotencyKey,
    sourceKind: 'import_batch',
    sourceRef: input.sourceRef,
    createdBy: input.actorId,
    actorId: input.actorId,
    actorPosture: input.actorPosture,
    tokenSubjectUserId: input.tokenSubjectUserId,
    acceptedWritePosture: input.acceptedWritePosture,
    commandFingerprint: input.commandFingerprint,
    legacyInputFingerprint: input.legacyInputFingerprint,
    operationalBranch: input.operationalBranch,
    identityProofVector: input.identityProofVector,
    identityProofVectorDigest: '0'.repeat(64),
    itemCount: input.itemCount,
    distinctTargetCount: input.distinctTargetCount,
    itemSequenceFingerprint: input.itemSequenceFingerprint,
    itemSetFingerprint: input.itemSetFingerprint,
    planDigest: input.planDigest,
    executionReasonCode: null,
  })
}
