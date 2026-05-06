import { normalizeJson } from './field-codecs'

export type HierarchyCycleGuardQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type HierarchyCycleField = {
  id: string
  type: string
  order?: number
  property?: Record<string, unknown>
}

export type HierarchyCycleLinkGuard = {
  type: string
  link?: {
    foreignSheetId: string
    limitSingleRecord: boolean
  } | null
}

export type HierarchyCycleChange = {
  fieldId: string
  value: unknown
}

export class HierarchyCycleError extends Error {
  constructor(
    message: string,
    public code = 'HIERARCHY_CYCLE',
  ) {
    super(message)
    this.name = 'HierarchyCycleError'
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function firstLinkFieldId(fields: HierarchyCycleField[]): string | null {
  const linkField = [...fields]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
    .find((field) => field.type === 'link')
  return linkField?.id ?? null
}

export function collectSameSheetLinkChangeFieldIds(input: {
  changesByRecord: Map<string, HierarchyCycleChange[]>
  fieldById: Map<string, HierarchyCycleLinkGuard>
  sheetId: string
}): Set<string> {
  const fieldIds = new Set<string>()
  for (const changes of input.changesByRecord.values()) {
    for (const change of changes) {
      const field = input.fieldById.get(change.fieldId)
      if (field?.type === 'link' && field.link?.foreignSheetId === input.sheetId) {
        fieldIds.add(change.fieldId)
      }
    }
  }
  return fieldIds
}

export async function loadHierarchyParentFieldIds(input: {
  query: HierarchyCycleGuardQueryFn
  sheetId: string
  fields: HierarchyCycleField[]
}): Promise<Set<string>> {
  const linkFieldIds = new Set(input.fields.filter((field) => field.type === 'link').map((field) => field.id))
  if (linkFieldIds.size === 0) return new Set()

  const fallbackParentFieldId = firstLinkFieldId(input.fields)
  const result = await input.query(
    'SELECT id, config FROM meta_views WHERE sheet_id = $1 AND type = $2',
    [input.sheetId, 'hierarchy'],
  )
  const parentFieldIds = new Set<string>()
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const config = normalizeJson(row.config)
    const configuredParentFieldId = stringOrNull(config.parentFieldId)
    if (configuredParentFieldId && linkFieldIds.has(configuredParentFieldId)) {
      parentFieldIds.add(configuredParentFieldId)
      continue
    }
    if (fallbackParentFieldId) {
      parentFieldIds.add(fallbackParentFieldId)
    }
  }
  return parentFieldIds
}

export function buildHierarchyParentOverridesByField(input: {
  changesByRecord: Map<string, HierarchyCycleChange[]>
  hierarchyParentFieldIds: Set<string>
  normalizeLinkIds: (value: unknown) => string[]
}): Map<string, Map<string, string[]>> {
  const overridesByField = new Map<string, Map<string, string[]>>()
  for (const [recordId, changes] of input.changesByRecord.entries()) {
    for (const change of changes) {
      if (!input.hierarchyParentFieldIds.has(change.fieldId)) continue
      const ids = input.normalizeLinkIds(change.value)
      if (!overridesByField.has(change.fieldId)) overridesByField.set(change.fieldId, new Map())
      overridesByField.get(change.fieldId)?.set(recordId, ids)
    }
  }
  return overridesByField
}

export async function assertNoHierarchyParentCycle(input: {
  query: HierarchyCycleGuardQueryFn
  sheetId: string
  recordId: string
  fieldId: string
  parentRecordIds: string[]
  parentOverridesByRecord: Map<string, string[]>
  normalizeLinkIds: (value: unknown) => string[]
}): Promise<void> {
  const queue = [...input.parentRecordIds]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const currentId = queue.shift()
    if (!currentId) continue
    if (currentId === input.recordId) {
      throw new HierarchyCycleError(
        `Hierarchy parent update would create a cycle for record ${input.recordId} via field ${input.fieldId}`,
      )
    }
    if (visited.has(currentId)) continue
    visited.add(currentId)

    const overrideParents = input.parentOverridesByRecord.get(currentId)
    if (overrideParents) {
      queue.push(...overrideParents)
      continue
    }

    const result = await input.query(
      'SELECT data FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE',
      [input.sheetId, currentId],
    )
    const row = (result.rows as Array<Record<string, unknown>>)[0]
    if (!row) continue
    const data = normalizeJson(row.data)
    queue.push(...input.normalizeLinkIds(data[input.fieldId]))
  }
}

