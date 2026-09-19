import type { RecoveryArchiveRowEnvelope } from './recovery-archive-manifest'
import type { ExactAnchorRevertWriteIntent } from './exact-anchor-recovery-execute'

type TargetRecord = { exists: boolean; data?: Record<string, unknown> | null }
type LiveRecord = { data: Record<string, unknown> }

export interface ArchiveAttachmentCellPlan {
  readonly recordId: string
  readonly fieldId: string
  readonly beforeIds: readonly string[]
  readonly targetIds: readonly string[]
}

export class ArchiveAttachmentPlanError extends Error {
  readonly code = 'RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID' as const

  constructor() {
    super('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
    this.name = 'ArchiveAttachmentPlanError'
  }
}

/** Descriptive only: caller still owes authenticated reader, permission and transactional drift checks. */
export function planArchiveAttachmentCells(input: {
  readonly targets: ReadonlyMap<string, TargetRecord>
  readonly live: ReadonlyMap<string, LiveRecord>
  readonly fieldTypes: ReadonlyMap<string, string>
  readonly index: readonly RecoveryArchiveRowEnvelope[]
  readonly selectedRecordIds?: readonly string[]
  readonly selectedFieldIds?: readonly string[]
}): readonly ArchiveAttachmentCellPlan[] {
  const records = selection(input.selectedRecordIds)
  const fields = selection(input.selectedFieldIds)
  const index = new Map<string, Record<string, unknown>>()
  for (const row of input.index) {
    const payload = row.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid()
    const entry = payload as Record<string, unknown>
    const id = entry.attachment_id
    if (!opaque(id) || index.has(id)) invalid()
    index.set(id, entry)
  }
  if (records && [...records].some(id => !input.targets.get(id)?.exists || !input.live.has(id))) invalid()
  if (fields && [...fields].some(id => !input.fieldTypes.has(id))) invalid()
  const plan: ArchiveAttachmentCellPlan[] = []
  for (const [recordId, target] of input.targets) {
    if (!target.exists || (records && !records.has(recordId))) continue
    for (const [fieldId, type] of input.fieldTypes) {
      if (type !== 'attachment' || (fields && !fields.has(fieldId))) continue
      const targetIds = referenceIds(target.data?.[fieldId])
      const live = input.live.get(recordId)
      if (!live) {
        if (targetIds.length > 0) invalid()
        continue
      }
      const beforeIds = referenceIds(live.data[fieldId])
      for (const id of targetIds) {
        const item = index.get(id)
        if (!item || item.record_id !== recordId || item.field_id !== fieldId || item.deleted !== false) invalid()
      }
      if (JSON.stringify(beforeIds) === JSON.stringify(targetIds)) continue
      plan.push(Object.freeze({ recordId, fieldId,
        beforeIds: Object.freeze(beforeIds), targetIds: Object.freeze(targetIds) }))
    }
  }
  return Object.freeze(plan)
}

/** Adds attachment fields to the same true-delta context used by canonical row/field authorization. */
export function projectArchiveAttachmentCells(
  writes: readonly ExactAnchorRevertWriteIntent[],
  live: ReadonlyMap<string, LiveRecord & { version: number }>,
  cells: readonly ArchiveAttachmentCellPlan[],
): ExactAnchorRevertWriteIntent[] {
  const result = new Map<string, ExactAnchorRevertWriteIntent>()
  for (const write of writes) {
    if (result.has(write.recordId)) invalid()
    result.set(write.recordId, { ...write, changedFieldIds: [...write.changedFieldIds],
      patch: { ...write.patch }, projectedData: { ...write.projectedData },
      linkUpdates: write.linkUpdates.map(link => ({ ...link, targetIds: [...link.targetIds] })) })
  }
  const seen = new Set<string>()
  for (const cell of cells) {
    const key = JSON.stringify([cell.recordId, cell.fieldId])
    if (seen.has(key)) invalid()
    seen.add(key)
    const row = live.get(cell.recordId)
    const before = referenceIds(cell.beforeIds)
    const target = referenceIds(cell.targetIds)
    if (!row || !Number.isSafeInteger(row.version) || row.version < 0
      || JSON.stringify(referenceIds(row.data[cell.fieldId])) !== JSON.stringify(before)
      || JSON.stringify(before) === JSON.stringify(target)) invalid()
    const write = result.get(cell.recordId) ?? { recordId: cell.recordId, liveVersion: row.version,
      changedFieldIds: [], patch: {}, projectedData: { ...row.data }, linkUpdates: [] }
    if (write.liveVersion !== row.version || write.changedFieldIds.includes(cell.fieldId)
      || Object.hasOwn(write.patch, cell.fieldId)) invalid()
    write.changedFieldIds.push(cell.fieldId)
    write.patch[cell.fieldId] = [...target]
    write.projectedData[cell.fieldId] = [...target]
    result.set(cell.recordId, write)
  }
  return [...result.values()]
}

function selection(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined
  if (ids.length === 0 || ids.some(id => !opaque(id)) || new Set(ids).size !== ids.length) invalid()
  return new Set(ids)
}

function referenceIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(id => !opaque(id)) || new Set(value).size !== value.length) invalid()
  return [...value] as string[]
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function invalid(): never {
  throw new ArchiveAttachmentPlanError()
}
