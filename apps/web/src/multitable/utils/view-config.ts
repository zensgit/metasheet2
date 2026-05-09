import type {
  MetaCalendarViewConfig,
  MetaField,
  MetaGanttViewConfig,
  MetaGalleryViewConfig,
  MetaHierarchyViewConfig,
  MetaKanbanViewConfig,
  MetaTimelineViewConfig,
} from '../types'

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function hasOwnKey(value: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

function firstFieldId(fields: MetaField[], types?: string[]): string | null {
  if (!fields.length) return null
  if (!types?.length) return fields[0]?.id ?? null
  return fields.find((field) => types.includes(field.type))?.id ?? fields[0]?.id ?? null
}

function firstNonMatchingFieldId(fields: MetaField[], excludedIds: Array<string | null>, types?: string[]): string | null {
  const excluded = new Set(excludedIds.filter((id): id is string => !!id))
  const candidates = fields.filter((field) => !excluded.has(field.id))
  return firstFieldId(candidates, types)
}

export function isSelfTableLinkField(field: MetaField, sheetId?: string | null): boolean {
  if (field.type !== 'link') return false
  const currentSheetId = typeof sheetId === 'string' ? sheetId.trim() : ''
  if (!currentSheetId) return true
  const property = field.property ?? {}
  const foreignSheetId = typeof (property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId) === 'string'
    ? String(property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId).trim()
    : ''
  return foreignSheetId === currentSheetId
}

export function resolveGalleryViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
): Required<MetaGalleryViewConfig> {
  const titleFieldId = stringOrNull(raw?.titleFieldId) ?? firstFieldId(fields, ['string', 'formula', 'lookup'])
  const coverFieldId = stringOrNull(raw?.coverFieldId)
  const fallbackFieldIds = fields
    .filter((field) => field.id !== titleFieldId && field.id !== coverFieldId)
    .slice(0, 4)
    .map((field) => field.id)
  const hasConfiguredFieldIds = hasOwnKey(raw, 'fieldIds')
  const configuredFieldIds = stringArray(raw?.fieldIds).filter((fieldId) => fields.some((field) => field.id === fieldId))
  return {
    titleFieldId,
    coverFieldId,
    fieldIds: hasConfiguredFieldIds ? configuredFieldIds : fallbackFieldIds,
    columns: clamp(raw?.columns, 1, 4, 3),
    cardSize: raw?.cardSize === 'small' || raw?.cardSize === 'large' ? raw.cardSize : 'medium',
  }
}

export function resolveCalendarViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
): Required<MetaCalendarViewConfig> {
  const dateCandidateTypes = ['date', 'string', 'number']
  const dateFieldId = stringOrNull(raw?.dateFieldId) ?? firstFieldId(fields, dateCandidateTypes)
  const endDateFieldId = stringOrNull(raw?.endDateFieldId)
    ?? firstNonMatchingFieldId(fields, [dateFieldId], dateCandidateTypes)
    ?? dateFieldId
  return {
    dateFieldId,
    endDateFieldId,
    titleFieldId: stringOrNull(raw?.titleFieldId) ?? firstNonMatchingFieldId(fields, [dateFieldId, endDateFieldId], ['string']) ?? firstFieldId(fields),
    defaultView: raw?.defaultView === 'week' || raw?.defaultView === 'day' ? raw.defaultView : 'month',
    weekStartsOn: clamp(raw?.weekStartsOn, 0, 1, 0),
  }
}

export function resolveKanbanViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
  groupInfo?: Record<string, unknown> | null,
): Required<MetaKanbanViewConfig> {
  const hasConfiguredGroupFieldId = hasOwnKey(raw, 'groupFieldId')
  const configuredGroupFieldId = hasConfiguredGroupFieldId
    ? stringOrNull(raw?.groupFieldId)
    : undefined
  const groupFieldId = configuredGroupFieldId !== undefined
    ? configuredGroupFieldId
    : stringOrNull(groupInfo?.fieldId)
      ?? firstFieldId(fields.filter((field) => field.type === 'select'))
  const fallbackCardFieldIds = fields
    .filter((field) => field.id !== groupFieldId)
    .slice(0, 2)
    .map((field) => field.id)
  const hasConfiguredCardFieldIds = hasOwnKey(raw, 'cardFieldIds')
  const configuredFieldIds = stringArray(raw?.cardFieldIds).filter((fieldId) => fields.some((field) => field.id === fieldId))
  return {
    groupFieldId,
    cardFieldIds: hasConfiguredCardFieldIds ? configuredFieldIds : fallbackCardFieldIds,
  }
}

export function resolveTimelineViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
): Required<MetaTimelineViewConfig> {
  const dateFieldTypes = ['date', 'dateTime']
  const startFieldId = stringOrNull(raw?.startFieldId) ?? firstFieldId(fields, dateFieldTypes)
  const endFieldId = stringOrNull(raw?.endFieldId)
    ?? firstNonMatchingFieldId(fields, [startFieldId], dateFieldTypes)
    ?? startFieldId
  return {
    startFieldId,
    endFieldId,
    labelFieldId: stringOrNull(raw?.labelFieldId) ?? firstNonMatchingFieldId(fields, [startFieldId, endFieldId], ['string']) ?? firstFieldId(fields),
    zoom: raw?.zoom === 'day' || raw?.zoom === 'month' ? raw.zoom : 'week',
  }
}

export function resolveGanttViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
  groupInfo?: Record<string, unknown> | null,
  sheetId?: string | null,
): Required<MetaGanttViewConfig> {
  const dateFieldTypes = ['date', 'dateTime']
  const configuredDependencyFieldId = stringOrNull(raw?.dependencyFieldId)
  const dependencyFieldId = configuredDependencyFieldId
    && fields.some((field) => field.id === configuredDependencyFieldId && isSelfTableLinkField(field, sheetId))
    ? configuredDependencyFieldId
    : null
  const startFieldId = stringOrNull(raw?.startFieldId) ?? firstFieldId(fields, dateFieldTypes)
  const endFieldId = stringOrNull(raw?.endFieldId)
    ?? firstNonMatchingFieldId(fields, [startFieldId], dateFieldTypes)
    ?? startFieldId
  return {
    startFieldId,
    endFieldId,
    titleFieldId: stringOrNull(raw?.titleFieldId) ?? firstNonMatchingFieldId(fields, [startFieldId, endFieldId], ['string']) ?? firstFieldId(fields),
    progressFieldId: stringOrNull(raw?.progressFieldId) ?? firstNonMatchingFieldId(fields, [startFieldId, endFieldId], ['number', 'percent']),
    groupFieldId: stringOrNull(raw?.groupFieldId) ?? stringOrNull(groupInfo?.fieldId),
    dependencyFieldId,
    zoom: raw?.zoom === 'day' || raw?.zoom === 'month' ? raw.zoom : 'week',
  }
}

export function resolveHierarchyViewConfig(
  fields: MetaField[],
  raw?: Record<string, unknown> | null,
): Required<MetaHierarchyViewConfig> {
  const configuredParentFieldId = stringOrNull(raw?.parentFieldId)
  const parentFieldId = configuredParentFieldId && fields.some((field) => field.id === configuredParentFieldId && field.type === 'link')
    ? configuredParentFieldId
    : fields.find((field) => field.type === 'link')?.id ?? null
  return {
    parentFieldId,
    titleFieldId: stringOrNull(raw?.titleFieldId) ?? firstFieldId(fields, ['string', 'formula', 'lookup']),
    defaultExpandDepth: clamp(raw?.defaultExpandDepth, 0, 8, 2),
    orphanMode: raw?.orphanMode === 'hidden' ? 'hidden' : 'root',
  }
}
