/**
 * W4C-3a fixed batch/item/result effect adapter and closed terminal-summary
 * construction (OD-W4C-60=(a)).
 *
 * Derives batch metadata and the compact async summary only from the verified
 * plan plus the closed group-effect result. Never rereads request payload,
 * environment sample limits, current rules, or opaque snapshots for branching.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  parseLegacyImportAsyncJobSummaryV1,
  type LegacyImportAsyncJobSummaryV1,
  type LegacyImportBatchPlanV1,
} from './w4c3a-legacy-execution-plan'
import type { AttendanceLegacyGroupEffectResultV1 } from './w4c3a-legacy-plan-group-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

export class AttendanceLegacyBatchEffectError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyBatchEffectError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyBatchEffectError(code)
}

const INSERT_BATCH_SQL = `
  INSERT INTO attendance_import_batches (
    id, org_id, idempotency_key, created_by, source, rule_set_id,
    mapping, row_count, status, meta, created_at, updated_at
  ) VALUES (
    $1::uuid, $2, $3, $4, $5, $6::uuid,
    $7::jsonb, $8, $9, $10::jsonb, now(), now()
  )
  RETURNING id::text AS id
`

function requireNormalBatch(
  batch: LegacyImportBatchPlanV1,
): Extract<LegacyImportBatchPlanV1, { kind: 'normal' }> {
  if (batch.kind !== 'normal') fail('W4C3A_BATCH_EFFECT_PLAN_MISMATCH')
  return batch
}

function buildSkippedSample(
  plan: VerifiedAttendanceLegacyPlanV1,
  limit: number,
): ReadonlyArray<Readonly<{ userId: string | null; workDate: string | null; warnings: readonly unknown[] }>> {
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

export function buildAttendanceLegacyFirstExecutionBatchMetaV1(
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
  // Opaque compatibility leaves survive, but explicit verified-plan fields and
  // derived counters always own their names.
  const meta: Record<string, unknown> = {
    ...compatibilityMetadata,
    engine: batch.engine,
    chunkConfig: batch.chunkConfig,
    recordUpsertStrategy: batch.recordUpsertStrategy,
    itemsInsertStrategy: batch.itemsInsertStrategy,
    mappingProfileId: batch.mappingProfileId,
    groupCreated: effectResult.groupCreated,
    async: true,
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
  }
  if (skippedCount === 0) {
    delete meta.skippedCount
    delete meta.skippedRows
  }
  return meta
}

export function buildAttendanceLegacyAsyncJobSummaryV1(input: {
  readonly plan: VerifiedAttendanceLegacyPlanV1
  readonly effectResult: AttendanceLegacyGroupEffectResultV1
  readonly elapsedMs: number
}): LegacyImportAsyncJobSummaryV1 {
  const { plan, elapsedMs } = input
  const batch = plan.manifest.batch

  if (batch.kind === 'idempotent_replay') {
    const skippedCount = batch.skippedCount
    const processedRows = batch.importedCount
    if (processedRows + skippedCount !== batch.totalRowCount) {
      fail('W4C3A_BATCH_EFFECT_REPLAY_COUNT_INVALID')
    }
    const metadata =
      typeof batch.metadata === 'object' &&
      batch.metadata !== null &&
      !Array.isArray(batch.metadata)
        ? (batch.metadata as Record<string, unknown>)
        : {}
    const skippedRows = Array.isArray(metadata.skippedRows)
      ? metadata.skippedRows
      : undefined
    if (
      !Object.prototype.hasOwnProperty.call(metadata, 'chunkConfig') ||
      metadata.chunkConfig === undefined ||
      typeof metadata.itemsInsertStrategy !== 'string'
    ) {
      fail('W4C3A_BATCH_EFFECT_REPLAY_METADATA_INVALID')
    }
    const chunkConfig = metadata.chunkConfig
    const itemsInsertStrategy = metadata.itemsInsertStrategy
    const summary: Record<string, unknown> = {
      processedRows,
      failedRows: skippedCount,
      elapsedMs,
      chunkConfig,
    }
    if (skippedCount > 0) summary.skippedCount = skippedCount
    if (Array.isArray(skippedRows) && skippedRows.length > 0) {
      summary.skippedRows = skippedRows
    }
    return parseLegacyImportAsyncJobSummaryV1({
      __jobType: 'commit',
      idempotencyKey: batch.idempotencyKey,
      __importEngine: batch.engine,
      recordUpsertStrategy: batch.recordUpsertStrategy,
      itemsInsertStrategy,
      summary,
    })
  }

  const processedRows = plan.items.filter((item) => item.kind === 'apply').length
  const skippedCount = plan.items.filter((item) => item.kind === 'skip').length
  const skippedRows = buildSkippedSample(plan, batch.skippedSamplePolicy.limit)
  const summary: Record<string, unknown> = {
    processedRows,
    failedRows: skippedCount,
    elapsedMs,
    chunkConfig: batch.chunkConfig,
  }
  if (skippedCount > 0) summary.skippedCount = skippedCount
  if (skippedRows.length > 0) summary.skippedRows = skippedRows

  return parseLegacyImportAsyncJobSummaryV1({
    __jobType: 'commit',
    idempotencyKey: batch.idempotencyKey,
    __importEngine: batch.engine,
    recordUpsertStrategy: batch.recordUpsertStrategy,
    itemsInsertStrategy: batch.itemsInsertStrategy,
    summary,
  })
}

/**
 * Inserts the frozen normal batch row. Replay plans perform zero batch DML.
 */
export async function applyAttendanceLegacyBatchEffectsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
  effectResult: AttendanceLegacyGroupEffectResultV1,
): Promise<void> {
  const batch = plan.manifest.batch
  if (batch.kind !== 'normal') return

  const meta = buildAttendanceLegacyFirstExecutionBatchMetaV1(plan, effectResult)
  const result = await trx.query(INSERT_BATCH_SQL, [
    plan.manifest.batchId,
    plan.manifest.orgId,
    batch.idempotencyKey,
    plan.manifest.createdBy,
    batch.source,
    batch.ruleSetId,
    JSON.stringify(batch.mappingSnapshot),
    batch.sourceRowCount,
    batch.status,
    JSON.stringify(meta),
  ])
  if (
    result.rows.length !== 1 ||
    (result.rows[0] as Record<string, unknown>).id !== plan.manifest.batchId
  ) {
    fail('W4C3A_BATCH_EFFECT_ROW_MISMATCH')
  }
}
