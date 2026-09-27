/**
 * Automation condition values — the ONE place that knows what a condition value looks like per field type.
 * 客户反馈 2026-09-24 #4b（自动化条件按字段类型编辑），裁定见 PR #6074.
 *
 * Shared by the rule-level condition rows and the `condition_branch` rows of MetaAutomationRuleEditor.vue
 * (through ConditionValueInput.vue and the conditionBranchAuthoring.ts build seam), so a value typed into a
 * branch row is saved exactly like the same value typed into a rule-level row. Before this module the
 * branch rows were a bare text box and their values were saved as strings (`'5'` for a number field,
 * `'true'` for a checkbox), which the condition evaluator never matched.
 *
 * The SAVED shape per field type (the contract the backend condition evaluator accepts):
 *   - number / currency / percent / rating / duration / autoNumber → a finite `number`
 *   - boolean                                                     → a `boolean`
 *   - date                                                        → `'YYYY-MM-DD'` (floating calendar day)
 *   - dateTime / createdTime / modifiedTime                       → a UTC ISO instant (`…Z`); a zone-less wall
 *     clock is read in the field's business timezone (business-timezone.ts, #6083), never the browser's
 *   - person / link                                               → a non-empty `string[]` of ids
 *   - select / text / anything else                               → a trimmed non-empty `string`
 *   - `in` / `not_in`                                             → a non-empty array of the above
 *
 * `coerceConditionValue` returns `{ ok: false }` for a value that cannot be expressed in that shape; the
 * editor treats such a row as incomplete (save is blocked and the row is anchored) — it never silently
 * saves `null` / `[]` in its place. A value ALREADY in the saved shape comes back unchanged (same primitive,
 * same string spelling), so an untouched load → save of a typed value is byte-identical.
 */
import type { AutomationCondition, ConditionOperator } from '../types'
import type { AutomationConditionValueWidget } from './meta-automation-labels'
import { calendarDayFromText, parseDateTimeTextToUtcMs, resolveDateTimeTimezone } from './business-timezone'

export type ConditionValueWidget = AutomationConditionValueWidget

/**
 * The operator a freshly added row carries until a field is chosen. Deliberately NOT a real operator:
 * seeding `'equals'` made the field-less operator select show the raw code `equals`, and a field-less row
 * has no meaningful operator anyway. The row stays incomplete (save blocked) until a field is chosen; the
 * field's first allowed operator then replaces it. The backend never receives it (save is blocked).
 */
export const PENDING_CONDITION_OPERATOR = '' as ConditionOperator

export interface ConditionFieldOption {
  value: string
  label?: string
  color?: string
}

/** The subset of a sheet field the condition editor needs. */
export interface ConditionFieldLike {
  id: string
  name?: string
  type: string
  property?: Record<string, unknown>
  options?: ConditionFieldOption[]
}

export type ConditionValueCoercion = { ok: true; value: unknown } | { ok: false }

export function isPendingConditionOperator(op: unknown): boolean {
  return op === '' || op === undefined || op === null
}

export function isUnaryConditionOperator(op: unknown): boolean {
  return op === 'is_empty' || op === 'is_not_empty'
}

export function isArrayConditionOperator(op: unknown): boolean {
  return op === 'in' || op === 'not_in'
}

export function isNumericConditionFieldType(fieldType: string | undefined): boolean {
  return fieldType === 'number' ||
    fieldType === 'currency' ||
    fieldType === 'percent' ||
    fieldType === 'rating' ||
    fieldType === 'duration' ||
    fieldType === 'autoNumber'
}

export function isDateTimeConditionFieldType(fieldType: string | undefined): boolean {
  return fieldType === 'dateTime' || fieldType === 'createdTime' || fieldType === 'modifiedTime'
}

/** Field types whose comparisons are in time — `greater_than` reads 晚于 / after for these. */
export function isTemporalConditionFieldType(fieldType: string | undefined): boolean {
  return fieldType === 'date' || isDateTimeConditionFieldType(fieldType)
}

/** Field types whose condition value is a list of ids picked from the person / record picker. */
export function isIdListConditionFieldType(fieldType: string | undefined): boolean {
  return fieldType === 'person' || fieldType === 'link'
}

/** Which value control a row shows for its field + operator (unary operators show none). */
export function conditionValueWidget(
  field: ConditionFieldLike | null | undefined,
  operator: ConditionOperator,
): ConditionValueWidget {
  if (!field) return 'text'
  const type = field.type
  if (type === 'boolean') return isArrayConditionOperator(operator) ? 'booleanMultiSelect' : 'boolean'
  if (isNumericConditionFieldType(type)) return 'number'
  if (type === 'date') return 'date'
  if (isDateTimeConditionFieldType(type)) return 'dateTime'
  if ((type === 'select' || type === 'multiSelect') && (field.options?.length ?? 0) > 0) {
    return isArrayConditionOperator(operator) ? 'multiSelect' : 'select'
  }
  if (type === 'person') return 'person'
  if (type === 'link') return 'link'
  return 'text'
}

/** The IANA zone a dateTime condition value is typed / shown in (field property → business timezone). */
export function conditionDateTimeZone(field: ConditionFieldLike | null | undefined): string {
  return resolveDateTimeTimezone(field?.property ?? null)
}

// ---------------------------------------------------------------------------------------------------------
// Parsers: value → saved shape, or null when the value cannot be expressed in it.
// ---------------------------------------------------------------------------------------------------------

/** A list value: an array (string entries trimmed, empties dropped) or a comma-separated string. */
export function parseConditionArrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === 'string' ? entry.trim() : entry)
      .filter((entry) => typeof entry === 'string' ? entry.length > 0 : entry !== null && entry !== undefined)
  }
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function parseNumberConditionValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseBooleanConditionValue(value: unknown): boolean | null {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

// A day must be written year-first (ISO-ish / 年月日; full-width digits allowed). `calendarDayFromText` also
// falls back to the engine's lenient `Date.parse`, which would read a stray `5` as a day in 2001.
const YEAR_FIRST_RE = /^[0-9０-９]{4}/

/** `'YYYY-MM-DD'` of a date-only condition value, or null. */
export function parseDateConditionValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || !YEAR_FIRST_RE.test(trimmed)) return null
  return calendarDayFromText(trimmed)
}

const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/

/**
 * UTC ISO instant of a dateTime condition value, or null. A string that is ALREADY a UTC ISO instant comes
 * back as written (an untouched load → save must not respell `…:00Z` as `…:00.000Z`); anything else that
 * names an instant — a zone-less wall clock (read in `timeZone`), an offset ISO string, epoch ms — is
 * converted. A bare date without a time is refused, exactly like the interactive date-time input does.
 */
export function parseDateTimeConditionValue(value: unknown, timeZone: string): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const ms = parseDateTimeTextToUtcMs(trimmed, timeZone, { requireTime: true })
  if (ms === null) return null
  return UTC_ISO_RE.test(trimmed) ? trimmed : new Date(ms).toISOString()
}

/** A non-empty list of ids (person user ids / linked record ids), or null. */
export function parseIdListConditionValue(value: unknown): string[] | null {
  const raw = Array.isArray(value) || typeof value === 'string' ? parseConditionArrayValue(value) : []
  const ids = raw
    .filter((entry): entry is string | number => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)))
    .map((entry) => String(entry).trim())
    .filter(Boolean)
  return ids.length > 0 && ids.length === raw.length ? ids : null
}

function allOrNull<T>(values: unknown[], parse: (value: unknown) => T | null): T[] | null {
  if (!values.length) return null
  const parsed = values.map(parse)
  return parsed.every((entry): entry is T => entry !== null) ? parsed : null
}

function coerced(value: unknown): ConditionValueCoercion {
  return value === null ? { ok: false } : { ok: true, value }
}

/**
 * The value a (non-unary) condition is SAVED with, in the shape its field type requires — or `{ ok: false }`
 * when the current value cannot be expressed in that shape (the row is incomplete). `field` is `undefined`
 * for a field that no longer exists on the sheet: the value is then kept as typed (strings trimmed, lists
 * split), exactly as the rule-level rows always did.
 */
export function coerceConditionValue(
  condition: Pick<AutomationCondition, 'operator' | 'value'>,
  field: ConditionFieldLike | null | undefined,
): ConditionValueCoercion {
  const fieldType = field?.type
  const value = condition.value
  if (isArrayConditionOperator(condition.operator)) {
    if (isNumericConditionFieldType(fieldType)) return coerced(allOrNull(parseConditionArrayValue(value), parseNumberConditionValue))
    if (fieldType === 'boolean') return coerced(allOrNull(parseConditionArrayValue(value), parseBooleanConditionValue))
    if (fieldType === 'date') return coerced(allOrNull(parseConditionArrayValue(value), parseDateConditionValue))
    if (isDateTimeConditionFieldType(fieldType)) {
      const zone = conditionDateTimeZone(field)
      return coerced(allOrNull(parseConditionArrayValue(value), (entry) => parseDateTimeConditionValue(entry, zone)))
    }
    if (isIdListConditionFieldType(fieldType)) return coerced(parseIdListConditionValue(value))
    const list = parseConditionArrayValue(value)
    return list.length > 0 ? { ok: true, value: list } : { ok: false }
  }
  if (isNumericConditionFieldType(fieldType)) return coerced(parseNumberConditionValue(value))
  if (fieldType === 'boolean') return coerced(parseBooleanConditionValue(value))
  if (fieldType === 'date') return coerced(parseDateConditionValue(value))
  if (isDateTimeConditionFieldType(fieldType)) return coerced(parseDateTimeConditionValue(value, conditionDateTimeZone(field)))
  if (isIdListConditionFieldType(fieldType)) return coerced(parseIdListConditionValue(value))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? { ok: true, value: trimmed } : { ok: false }
  }
  return value === undefined || value === null ? { ok: false } : { ok: true, value }
}

/** A row is complete when a field and an operator are chosen and the value (if the operator takes one) coerces. */
export function isConditionLeafComplete(
  condition: Pick<AutomationCondition, 'fieldId' | 'operator' | 'value'>,
  field: ConditionFieldLike | null | undefined,
): boolean {
  if (typeof condition.fieldId !== 'string' || !condition.fieldId.trim()) return false
  if (isPendingConditionOperator(condition.operator)) return false
  if (isUnaryConditionOperator(condition.operator)) return true
  return coerceConditionValue(condition, field).ok
}

/**
 * The condition as it is SAVED: the value coerced to its field type's shape (see the module header). Every
 * other key of the condition rides through untouched. A unary condition, or a value that does not coerce
 * (the editor blocks that save; this is only the defensive floor), is returned as-is — never replaced by an
 * invented `null` / `[]`.
 */
export function buildConditionLeafForSave<T extends Pick<AutomationCondition, 'operator' | 'value'>>(
  condition: T,
  field: ConditionFieldLike | null | undefined,
): T {
  if (isUnaryConditionOperator(condition.operator) || isPendingConditionOperator(condition.operator)) return condition
  if (condition.value === undefined) return condition
  const result = coerceConditionValue(condition, field)
  if (!result.ok) return condition
  return { ...condition, value: result.value }
}
