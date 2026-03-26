import type {
  MetaCalendarViewConfig,
  MetaField,
  MetaGalleryViewConfig,
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
  const startFieldId = stringOrNull(raw?.startFieldId) ?? firstFieldId(fields, ['date'])
  const endFieldId = stringOrNull(raw?.endFieldId)
    ?? firstNonMatchingFieldId(fields, [startFieldId], ['date'])
    ?? startFieldId
  return {
    startFieldId,
    endFieldId,
    labelFieldId: stringOrNull(raw?.labelFieldId) ?? firstNonMatchingFieldId(fields, [startFieldId, endFieldId], ['string']) ?? firstFieldId(fields),
    zoom: raw?.zoom === 'day' || raw?.zoom === 'month' ? raw.zoom : 'week',
  }
}
