/**
 * W4C-3a fixed item-effect adapter for verified durable plans.
 *
 * This adapter projects frozen plan items into attendance_import_items. It
 * performs one fixed INSERT for the complete ordered item stream and does not
 * reread or recompute any attendance inputs.
 */
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { LegacyImportRecordWritePlanV1 } from './w4c3a-legacy-execution-plan'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

export class AttendanceLegacyItemEffectError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyItemEffectError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyItemEffectError(code)
}

const INSERT_ITEMS_SQL = `
  WITH input AS (
    SELECT *
    FROM unnest(
      $1::uuid[],
      $2::text[],
      $3::date[],
      $4::uuid[],
      $5::jsonb[]
    ) WITH ORDINALITY AS item(
      item_id,
      user_id,
      work_date,
      record_id,
      preview_snapshot,
      ordinal
    )
  ),
  inserted AS (
    INSERT INTO attendance_import_items
      (id, batch_id, org_id, user_id, work_date, record_id,
       preview_snapshot, created_at)
    SELECT
      item_id,
      $6::uuid,
      $7,
      user_id,
      work_date,
      record_id,
      preview_snapshot,
      now()
    FROM input
    ORDER BY ordinal
    RETURNING id
  )
  SELECT inserted.id::text AS id
  FROM inserted
  JOIN input ON input.item_id = inserted.id
  ORDER BY input.ordinal
`

type ItemEffectColumns = Readonly<{
  itemIds: string[]
  userIds: Array<string | null>
  workDates: Array<string | null>
  recordIds: Array<string | null>
  previewSnapshots: string[]
}>

function requireRecordWriteMap(
  plan: VerifiedAttendanceLegacyPlanV1,
): ReadonlyMap<string, LegacyImportRecordWritePlanV1> {
  const writes = new Map<string, LegacyImportRecordWritePlanV1>()
  for (const write of plan.recordWrites) {
    if (
      writes.has(write.recordWriteId) ||
      write.orgId !== plan.manifest.orgId ||
      write.sourceBatchId !== plan.manifest.batchId
    ) {
      fail('W4C3A_ITEM_EFFECT_PLAN_MISMATCH')
    }
    writes.set(write.recordWriteId, write)
  }
  return writes
}

function serializePreviewSnapshot(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) fail('W4C3A_ITEM_EFFECT_PLAN_MISMATCH')
  return serialized
}

function buildItemEffectColumns(
  plan: VerifiedAttendanceLegacyPlanV1,
): ItemEffectColumns {
  const writes = requireRecordWriteMap(plan)
  const itemIds = new Set<string>()
  const ordinals = new Set<number>()
  const columns: ItemEffectColumns = {
    itemIds: [],
    userIds: [],
    workDates: [],
    recordIds: [],
    previewSnapshots: [],
  }

  for (const [index, item] of plan.items.entries()) {
    if (
      itemIds.has(item.itemId) ||
      ordinals.has(item.ordinal) ||
      item.ordinal !== index
    ) {
      fail('W4C3A_ITEM_EFFECT_PLAN_MISMATCH')
    }
    itemIds.add(item.itemId)
    ordinals.add(item.ordinal)
    columns.itemIds.push(item.itemId)
    columns.previewSnapshots.push(serializePreviewSnapshot(item.previewSnapshot))

    if (item.kind === 'skip') {
      columns.userIds.push(item.resolvedUserId)
      columns.workDates.push(item.resolvedWorkDate)
      columns.recordIds.push(null)
      continue
    }

    const write = writes.get(item.recordWriteRef)
    if (
      write === undefined ||
      !write.sourceOrdinals.includes(item.ordinal) ||
      item.targetRef !==
        canonicalAttendanceJsonV1([
          plan.manifest.orgId,
          write.userId,
          write.workDate,
        ])
    ) {
      fail('W4C3A_ITEM_EFFECT_PLAN_MISMATCH')
    }
    columns.userIds.push(write.userId)
    columns.workDates.push(write.workDate)
    columns.recordIds.push(write.recordId)
  }

  return columns
}

function requireReturnedItemIds(
  rows: ReadonlyArray<Record<string, unknown>>,
  expectedItemIds: readonly string[],
): void {
  if (
    rows.length !== expectedItemIds.length ||
    rows.some((row, index) => row.id !== expectedItemIds[index])
  ) {
    fail('W4C3A_ITEM_EFFECT_ROW_MISMATCH')
  }
}

/**
 * Applies frozen items from a verified plan only.
 * Empty plan.items performs zero SQL.
 */
export async function applyAttendanceLegacyItemEffectsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<void> {
  if (plan.items.length === 0) return

  const columns = buildItemEffectColumns(plan)
  const result = await trx.query(INSERT_ITEMS_SQL, [
    columns.itemIds,
    columns.userIds,
    columns.workDates,
    columns.recordIds,
    columns.previewSnapshots,
    plan.manifest.batchId,
    plan.manifest.orgId,
  ])
  requireReturnedItemIds(result.rows, columns.itemIds)
}
