import type { LinkedRecordSummary, MetaAttachment, MetaField, PersonSummary } from '../types'
import {
  formatCurrencyValue,
  formatDurationValue,
  formatNumberValue,
  formatPercentValue,
  resolveAutoNumberFieldProperty,
  resolveCurrencyFieldProperty,
  resolveDurationFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
} from './field-config'
import { isSystemFieldType } from './system-fields'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/

function parseDisplayDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  const raw = String(value)
  const ymd = DATE_ONLY.exec(raw)
  if (ymd) {
    const date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function toDisplayDate(value: Date | number | string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return parseDisplayDate(value)
}

/** zh: 9月8日. en: Sep 8. Never English month names in zh. */
export function formatAxisDayLabel(value: Date | number | string, isZh = false): string {
  const date = toDisplayDate(value)
  if (!date) return String(value)
  if (isZh) return `${date.getMonth() + 1}月${date.getDate()}日`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** zh: 2026年9月. en: Sep 26 (short axis) or September 2026 (long). Never English month names in zh. */
export function formatAxisMonthLabel(value: Date | number | string, isZh = false, style: 'short' | 'long' = 'short'): string {
  const date = toDisplayDate(value)
  if (!date) return String(value)
  if (isZh) return `${date.getFullYear()}年${date.getMonth() + 1}月`
  return date.toLocaleDateString('en-US', style === 'long'
    ? { month: 'long', year: 'numeric' }
    : { month: 'short', year: '2-digit' })
}

/** Calendar day heading. zh uses numeric Chinese form, never Aug/September. */
export function formatAxisLongDateLabel(value: Date | number | string, isZh = false): string {
  const date = toDisplayDate(value)
  if (!date) return String(value)
  if (isZh) {
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${weekdays[date.getDay()] ?? ''}`
  }
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatAxisWeekRangeLabel(start: Date | number | string, end: Date | number | string, isZh = false): string {
  const startDate = toDisplayDate(start)
  const endDate = toDisplayDate(end)
  if (!startDate || !endDate) return `${start} - ${end}`
  if (isZh) {
    return `${startDate.getMonth() + 1}月${startDate.getDate()}日 - ${endDate.getFullYear()}年${endDate.getMonth() + 1}月${endDate.getDate()}日`
  }
  return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}

/** zh: 2026-09-08. en: Aug 31, 2026. Never English month names in zh. */
export function formatDateValue(value: unknown, isZh = false): string {
  if (value === null || value === undefined || value === '') return '—'
  const raw = String(value)
  const ymd = DATE_ONLY.exec(raw)
  if (isZh && ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  const date = parseDisplayDate(value)
  if (!date) return raw
  if (isZh) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function resolveDateTimeTimezone(property?: Record<string, unknown> | null): string {
  const timezone = typeof property?.timezone === 'string' && property.timezone.trim().length > 0
    ? property.timezone.trim()
    : 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    return timezone
  } catch {
    return 'UTC'
  }
}

export function dateTimeInputValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function dateTimeValueFromLocalInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatDateTimeValue(value: unknown, timezone?: string, isZh = false): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  if (isZh) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).formatToParts(date)
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  }
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  })
}

function formatAutoNumber(value: unknown, property: Record<string, unknown> | undefined): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  const { prefix, digits } = resolveAutoNumberFieldProperty(property)
  return `${prefix}${String(Math.trunc(num)).padStart(digits, '0')}`
}

function summarizeLinkCount(field: MetaField, count: number, isZh = false): string {
  if (count <= 0) return '—'
  if (isZh) return field.property?.refKind === 'user' ? `${count} 个人员` : `${count} 条关联记录`
  if (field.property?.refKind === 'user') return count === 1 ? '1 person' : `${count} people`
  return count === 1 ? '1 linked record' : `${count} linked records`
}

function summarizeAttachmentCount(count: number, isZh = false): string {
  if (count <= 0) return '—'
  if (isZh) return `${count} 个附件`
  return count === 1 ? '1 attachment' : `${count} attachments`
}

export function locationAddressValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const rawAddress = obj.address ?? obj.name ?? obj.fullAddress
    if (rawAddress !== null && rawAddress !== undefined && String(rawAddress).trim().length > 0) {
      return String(rawAddress)
    }
    const latitude = obj.latitude ?? obj.lat
    const longitude = obj.longitude ?? obj.lng ?? obj.lon
    if (latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined) {
      return `${latitude}, ${longitude}`
    }
  }
  return String(value)
}

export function locationValueFromAddress(address: string): { address: string } | null {
  const trimmed = address.trim()
  return trimmed ? { address: trimmed } : null
}

export function formatFieldDisplay(params: {
  field: MetaField
  value: unknown
  linkSummaries?: LinkedRecordSummary[] | null
  personSummaries?: PersonSummary[] | null
  attachmentSummaries?: MetaAttachment[] | null
  isZh?: boolean
}): string {
  const { field, value, linkSummaries, personSummaries, attachmentSummaries, isZh = false } = params
  if (value === null || value === undefined || value === '') return '—'

  // Native person (人员): value = userId[]; resolve display from personSummaries (userId →
  // display), falling back to the raw userId. (Legacy link-backed person is type='link' below.)
  if (field.type === 'person') {
    // DIRTY-VALUE FILTERING. A person value is `userId[]`, but a stored value can be dirty — a legacy
    // object, a number, a null — from an old import, a retype, or a hand-seeded row. The previous
    // `value.map(String)` stringified those, so an object rendered as the literal "[object Object]" and a
    // number as "42", straight into the UI (and, in a History diff, into an audit surface). Accept ONLY
    // non-empty strings and DROP the rest: an id we cannot trust is not an id. A cell of nothing but dirt
    // renders as '—', which is honest, rather than as fabricated garbage.
    const ids = (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (ids.length === 0) return '—'
    const byId = new Map((personSummaries ?? []).map((s) => [s.id, s.display]))
    return ids.map((id) => byId.get(id) || id).join(', ')
  }

  if (field.type === 'date') return formatDateValue(value, isZh)
  if (field.type === 'dateTime') return formatDateTimeValue(value, resolveDateTimeTimezone(field.property), isZh)
  if (field.type === 'createdTime' || field.type === 'modifiedTime') return formatDateTimeValue(value, undefined, isZh)
  if (field.type === 'autoNumber') return formatAutoNumber(value, field.property)
  if (isSystemFieldType(field.type)) return String(value)
  if (field.type === 'boolean') return isZh ? (value ? '是' : '否') : (value ? 'Yes' : 'No')

  if (field.type === 'number') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    return formatNumberValue(num, field.property)
  }

  if (field.type === 'currency') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { code, decimals } = resolveCurrencyFieldProperty(field.property)
    return formatCurrencyValue(num, code, decimals)
  }

  if (field.type === 'percent') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { decimals } = resolvePercentFieldProperty(field.property)
    return formatPercentValue(num, decimals)
  }

  if (field.type === 'rating') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { max } = resolveRatingFieldProperty(field.property)
    const filled = Math.max(0, Math.min(max, Math.round(num)))
    return `${'★'.repeat(filled)}${'☆'.repeat(max - filled)}`
  }

  if (field.type === 'duration') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { durationFormat } = resolveDurationFieldProperty(field.property)
    return formatDurationValue(num, durationFormat)
  }

  if (field.type === 'location') {
    const location = locationAddressValue(value).trim()
    return location.length > 0 ? location : '—'
  }

  if (field.type === 'select' || field.type === 'multiSelect') {
    const rawValues = Array.isArray(value) ? value : [value]
    const displayValues = rawValues
      .filter((item) => item !== null && item !== undefined && String(item).trim().length > 0)
      .map((item) => String(item))
    return displayValues.length > 0 ? displayValues.join(', ') : '—'
  }

  if (field.type === 'link') {
    if (linkSummaries?.length) {
      return linkSummaries
        .map((summary) => summary.display || summary.id)
        .filter((item) => item.trim().length > 0)
        .join(', ')
    }
    const count = Array.isArray(value) ? value.length : value ? 1 : 0
    return summarizeLinkCount(field, count, isZh)
  }

  if (field.type === 'attachment') {
    if (attachmentSummaries?.length) {
      return attachmentSummaries
        .map((attachment) => attachment.filename)
        .filter((item) => item.trim().length > 0)
        .join(', ')
    }
    const count = Array.isArray(value) ? value.length : value ? 1 : 0
    return summarizeAttachmentCount(count, isZh)
  }

  if (Array.isArray(value)) {
    const displayValues = value
      .filter((item) => item !== null && item !== undefined && String(item).trim().length > 0)
      .map((item) => String(item))
    return displayValues.length > 0 ? displayValues.join(', ') : '—'
  }

  return String(value)
}

/**
 * Pick a human-readable title for a record from its (possibly backend-masked) `data`: the first field
 * in column order whose value renders to a non-empty display string via `formatFieldDisplay`. Masked /
 * unreadable / empty fields render `'—'` and are skipped, so a field the actor can't read transparently
 * falls through to the next readable one. Returns `null` when nothing is readable — the caller decides
 * the fallback (e.g. a short record id). Used by the recycle bin so a trashed row is identifiable.
 */
export function pickRecordTitle(params: {
  fields: MetaField[]
  data: Record<string, unknown>
  isZh?: boolean
}): string | null {
  const ordered = [...params.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const field of ordered) {
    const text = formatFieldDisplay({ field, value: params.data[field.id], isZh: params.isZh })
    if (text && text !== '—') return text
  }
  return null
}
