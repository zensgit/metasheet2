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
import { isEmptyValue } from './conditional-formatting'
import {
  businessTodayKey,
  formatDateOnlyValue,
  formatDateTimeInZone,
  getBusinessTimezone,
  parseDateTimeInput,
  resolveDateTimeTimezone,
} from './business-timezone'
import { getLookupTargetField } from './lookup-target-fields'

// #6204: the date-only day key lives in ./business-timezone.ts (beside the parsers it is built on) so the
// conditional-formatting rules — which this module imports — can use the SAME function as the grid without an
// import cycle. Re-exported here: every existing `field-display` import keeps working.
export { formatDateOnlyValue }

function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return formatDateOnlyValue(value) ?? String(value)
}

// 客户反馈 2026-09-24 #4c: date-times are shown AND parsed in ONE business timezone, fixed
// `YYYY-MM-DD HH:mm` 24-hour — never in the browser's zone or locale. See ./business-timezone.ts.
export { resolveDateTimeTimezone }

/**
 * Editor text for a stored date-time: its `YYYY-MM-DD HH:mm` wall clock in `timezone` (the business
 * timezone by default), or '' when empty / not a date-time.
 */
export function dateTimeInputValue(value: unknown, timezone: string = getBusinessTimezone()): string {
  return formatDateTimeInZone(value, timezone) ?? ''
}

/**
 * Stored value for editor text read as a wall clock in `timezone` (the business timezone by default):
 * the UTC ISO instant, or `null` for empty AND for unparseable text. Callers that must tell "cleared"
 * from "still typing" use `parseDateTimeInput` instead.
 */
export function dateTimeValueFromInput(value: string, timezone: string = getBusinessTimezone()): string | null {
  const parsed = parseDateTimeInput(value, timezone)
  return parsed.ok ? parsed.value : null
}

function formatDateTime(value: unknown, timezone: string): string {
  if (value === null || value === undefined || value === '') return '—'
  return formatDateTimeInZone(value, timezone) ?? String(value)
}

/** True for the field types whose values are UTC instants shown as business wall clocks. */
export function isDateTimeLikeFieldType(type: string): boolean {
  return type === 'dateTime' || type === 'createdTime' || type === 'modifiedTime'
}

/** The zone a field's date-time values are shown in: a dateTime field's zone rule, else the business zone. */
export function dateTimeFieldTimezone(field: Pick<MetaField, 'type' | 'property'>): string {
  return field.type === 'dateTime' ? resolveDateTimeTimezone(field.property) : getBusinessTimezone()
}

/**
 * The zone the calendar / timeline / Gantt views put a field's values onto days in (客户反馈 2026-09-24 #4c
 * follow-up): a date-time-like field's zone (so a record lands on the day its cell shows), else `null`. A `date`
 * field is put on its day by {@link viewDateOnlyDayKey} (#6181); text / number fields keep their existing day logic.
 */
export function viewDayZone(field: Pick<MetaField, 'type' | 'property'> | null | undefined): string | null {
  return field && isDateTimeLikeFieldType(field.type) ? dateTimeFieldTimezone(field) : null
}

/**
 * "Today" for a calendar / timeline / Gantt keyed on `field`: today's day in that field's day zone (a date-time
 * field's zone rule), else in the business timezone — for `date` fields too, so the day a view opens on,
 * highlights and quick-creates on is the SAME business day in every browser (a floating `date` names a day,
 * and the organisation's "today" is the business day). Never the browser's day or the UTC day.
 */
export function viewTodayKey(field: Pick<MetaField, 'type' | 'property'> | null | undefined, nowMs: number = Date.now()): string {
  return businessTodayKey(viewDayZone(field) ?? getBusinessTimezone(), nowMs)
}

/**
 * #6181: the calendar day (`YYYY-MM-DD`) the calendar / timeline / Gantt views put a `date` (date-only) field's
 * value on — the day its cell shows ({@link formatDateOnlyValue}): a day as written keeps that day; a stored
 * instant (`2026-09-17T16:00:00.000Z`) is the day it falls on in the business timezone (`2026-09-18`). Never the
 * UTC day of the instant, never the browser's day. `null` when the field is not a `date` field or the value
 * names no day — the caller keeps its own fallback. (Date-time-like fields go through {@link viewDayZone}.)
 */
export function viewDateOnlyDayKey(field: Pick<MetaField, 'type'> | null | undefined, value: unknown): string | null {
  return field?.type === 'date' ? formatDateOnlyValue(value) : null
}

/**
 * #6181: where the timeline / Gantt views place a `date` value on their time axis — UTC midnight of
 * {@link viewDateOnlyDayKey}. A zone-free day frame: those views read a `date` position back as its UTC day
 * (`toISOString().slice(0, 10)`), which in this frame IS the day the cell shows, whatever the browser's zone —
 * a day as written sits exactly where it always did (`2026-09-18` → `2026-09-18T00:00:00.000Z`). `null` when
 * `viewDateOnlyDayKey` is.
 */
export function viewDateOnlyDayUtcMs(field: Pick<MetaField, 'type'> | null | undefined, value: unknown): number | null {
  const day = viewDateOnlyDayKey(field, value)
  if (!day) return null
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Display texts of a LOOKUP cell whose target field is date-time-like (客户反馈 2026-09-24 #4c follow-up): each
 * looked-up instant as the SAME `YYYY-MM-DD HH:mm` wall clock the target column shows (the target's zone rule).
 * `null` when the field is not a lookup or its target is unknown / not date-time-like — the caller keeps its
 * raw projection. A looked-up value that is not a date-time keeps its raw text (never dropped).
 */
export function lookupDateTimeTexts(field: Pick<MetaField, 'type'> & { id?: string }, value: unknown): string[] | null {
  if (field.type !== 'lookup') return null
  const target = getLookupTargetField(field.id)
  if (!target) return null
  const items = Array.isArray(value) ? value : [value]
  const present = items.filter((item) => item !== null && item !== undefined && String(item).trim().length > 0)
  // A looked-up `date` column shows the same `YYYY-MM-DD` its own cells show (formatDateOnlyValue).
  if (target.type === 'date') return present.map((item) => formatDateOnlyValue(item) ?? String(item))
  if (!isDateTimeLikeFieldType(target.type)) return null
  const zone = dateTimeFieldTimezone(target)
  return present.map((item) => formatDateTimeInZone(item, zone) ?? String(item))
}

/**
 * Export / group-header / filter text of a date-time cell: the SAME `YYYY-MM-DD HH:mm` business wall clock
 * the grid shows (客户反馈 2026-09-24 #4c, B1/N5). `null` when the field is not date-time-like or the value is
 * not a date-time — the caller keeps its raw projection (never drops the cell). A lookup of a date-time field
 * exports its wall clocks joined the way the export joins any array (`; `).
 */
export function dateTimeExportText(field: Pick<MetaField, 'type' | 'property'> & { id?: string }, value: unknown): string | null {
  if (field.type === 'lookup') {
    const texts = lookupDateTimeTexts(field, value)
    return texts && texts.length > 0 ? texts.join('; ') : null
  }
  // A `date` cell exports / groups as the `YYYY-MM-DD` it shows — not the raw stored instant.
  if (field.type === 'date') return formatDateOnlyValue(value)
  if (!isDateTimeLikeFieldType(field.type)) return null
  if (value === null || value === undefined || value === '') return null
  return formatDateTimeInZone(value, dateTimeFieldTimezone(field))
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
  // Empty glyph: the SAME `isEmptyValue` predicate conditional-formatting.ts's is_empty operator and
  // MetaRecordFieldsPanel.vue's hide-empty filter use (record inspector v3, PR-B1 §1.3 — single
  // emptiness definition). Widened from the previous bare null/undefined/'' check: a whitespace-only
  // string, an empty array and an empty plain object now render '—' on every field type (the
  // per-type branches below already produced '—' for their own type's empty array/object, so the
  // observable change is confined to whitespace-only strings and to arrays/objects on types that
  // had no such branch, e.g. `[]` on a `string` field, which used to render as '').
  if (isEmptyValue(value)) return '—'

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

  if (field.type === 'date') return formatDate(value)
  if (field.type === 'dateTime') return formatDateTime(value, resolveDateTimeTimezone(field.property))
  // System timestamps carry no field zone: the business timezone, same format as a dateTime cell.
  if (field.type === 'createdTime' || field.type === 'modifiedTime') return formatDateTime(value, getBusinessTimezone())
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

  // Lookup of a date-time field: the target column's wall clock, never the raw stored ISO.
  const lookupDateTimes = lookupDateTimeTexts(field, value)
  if (lookupDateTimes) return lookupDateTimes.length > 0 ? lookupDateTimes.join(', ') : '—'

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
