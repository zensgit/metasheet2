/**
 * Automation Condition Engine
 *
 * Evaluates record predicates for "if/then" automation rules. The evaluator
 * accepts both the older backend `logic: 'and' | 'or'` shape and the current
 * frontend `conjunction: 'AND' | 'OR'` shape, then recurses through nested
 * groups when API clients send them.
 *
 * 客户反馈 2026-09-24 #4b（自动化条件按字段类型比较），裁定见 PR #6074 — TYPED evaluation.
 * When the caller hands in the sheet's fields (`ConditionEvaluationOptions.fields`), a condition on a
 * typed field is compared the way the grid shows the value, not by raw `===`:
 *
 *   - `date`      → by CALENDAR DAY. A bare `YYYY-MM-DD` is a floating day (#3417) and is never shifted;
 *                   a stored ISO instant (e.g. an `openedAt` written as `2026-09-24T18:00:00.000Z`) is
 *                   bucketed into the field's zone (`resolveDateTimeFieldTimeZone`: explicit non-'UTC'
 *                   `property.timezone`, else the instance business timezone, default Asia/Shanghai) —
 *                   so 18:00Z on the 24th IS the 25th for a China customer.
 *   - `dateTime`  → by INSTANT floored to the MINUTE (the displayed precision), zone-less condition text
 *                   read as a wall clock in the field's zone (`date-time-wall-clock.ts`, same rule as a
 *                   cell edit and the view filter).
 *   - `person` / `user` / `link` / `multiSelect` → SET semantics over the stored `id[]`: equals = same
 *                   set, in/not_in = intersection, contains = membership, is_empty also true for `[]`.
 *   - `boolean`   → `true`/`false` and the strings `'true'`/`'false'` compare equal — and the save gate
 *                   accepts the same spellings, so what saves is exactly what evaluates.
 *   - number-like (`number`, `currency`, `percent`, `rating`, `duration`, `autoNumber`) → numeric compare
 *                   with safe string→number coercion (`'5'` equals `5`; `'abc'` never matches).
 *
 * Every OTHER field type, an unknown field, and a call WITHOUT `fields` keep the legacy untyped path
 * byte-for-byte (`evaluateLegacyCondition`). A typed path NEVER throws on a legacy / malformed stored
 * value: the side that cannot be read as the type is reported through `onUnreadableValue` (values-free —
 * ids and type names only) and the comparison evaluates as "no match" (`equals` false, `not_equals` true).
 * Two layers keep that promise: an epoch-ms value outside the representable `Date` range (|ms| > 8.64e15,
 * where `Intl` throws `RangeError`) is unreadable by construction, and `evaluateCondition` wraps the typed
 * comparison so an exception from any comparator still evaluates as unmatched (reported with side
 * `'unknown'`) instead of failing the automation run.
 */
import { getZonedParts } from './automation-timezone'
import { resolveDateTimeFieldTimeZone } from './business-timezone'
import { dateTimeMinuteKey, isValidWallClockParts, parseDateTimeText } from './date-time-wall-clock'

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'

const VALID_CONDITION_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
])

const VALUE_REQUIRED_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'in',
  'not_in',
])

const ARRAY_VALUE_OPERATORS = new Set<ConditionOperator>(['in', 'not_in'])
const MAX_CONDITION_GROUP_DEPTH = 5
const EMPTY_VALUE_OPERATORS = new Set<ConditionOperator>(['is_empty', 'is_not_empty'])
const EQUALITY_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const TEXT_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const COMPARABLE_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const MULTI_VALUE_OPERATORS = new Set<ConditionOperator>([
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])

/**
 * Stable refusal code for "the condition VALUE does not fit the field's type" (a number field given
 * `'abc'`, a date field given `'yesterday'`, …). Field-existence and operator refusals keep the generic
 * `VALIDATION_ERROR`. Mirrored in the web label table (apps/web/src/multitable/utils/meta-api-error-labels.ts).
 */
export const AUTOMATION_CONDITION_VALUE_INVALID_CODE = 'AUTOMATION_CONDITION_VALUE_INVALID' as const

export type ConditionGroupValidationCode = 'VALIDATION_ERROR' | typeof AUTOMATION_CONDITION_VALUE_INVALID_CODE

export interface AutomationCondition {
  fieldId: string
  operator: ConditionOperator
  value?: unknown
}

export type AutomationConditionField = {
  id: string
  type: string
  property?: unknown
}

export type AutomationConditionNode = AutomationCondition | ConditionGroup

export interface ConditionGroup {
  logic?: 'and' | 'or'
  conjunction?: 'AND' | 'OR' | 'and' | 'or'
  conditions: AutomationConditionNode[]
}

export class ConditionGroupValidationError extends Error {
  readonly code: ConditionGroupValidationCode

  constructor(message: string, code: ConditionGroupValidationCode = 'VALIDATION_ERROR') {
    super(message)
    this.name = 'ConditionGroupValidationError'
    this.code = code
  }
}

/**
 * Which side of a typed comparison could not be read as the field's type (values-free diagnostics).
 * `'unknown'` = a comparator threw (the never-throws safety net caught it), so the side is not known.
 */
export interface ConditionUnreadableValueInfo {
  fieldId: string
  fieldType: string
  operator: ConditionOperator
  side: 'record' | 'condition' | 'unknown'
}

export interface ConditionEvaluationOptions {
  /**
   * The sheet's fields (array or id-keyed map). A condition whose field is absent here — or a call with
   * no `fields` at all — evaluates on the legacy untyped path, byte-identical to before #4b.
   */
  fields?: ReadonlyMap<string, AutomationConditionField> | readonly AutomationConditionField[] | null
  /** Called when a stored cell or a condition value cannot be read as the field's type. Never receives values. */
  onUnreadableValue?: (info: ConditionUnreadableValueInfo) => void
  /** Environment used to resolve the business timezone (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

function isConditionGroup(node: AutomationConditionNode): node is ConditionGroup {
  return typeof (node as ConditionGroup).conditions !== 'undefined'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function configuredOptionValuesForField(field: AutomationConditionField): Set<string> | null {
  if (field.type !== 'select' && field.type !== 'multiSelect') return null

  const property = normalizeJsonObject(field.property)
  const options = property.options
  if (!Array.isArray(options)) return null

  const values: string[] = []
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const value = option.value
    if (typeof value === 'string' || typeof value === 'number') {
      values.push(String(value))
    }
  }

  return values.length > 0 ? new Set(values) : null
}

function resolveGroupLogic(conditionGroup: ConditionGroup): 'and' | 'or' {
  const logic = conditionGroup.logic?.toLowerCase()
  if (logic === 'and' || logic === 'or') return logic

  const conjunction = conditionGroup.conjunction?.toLowerCase()
  if (conjunction === 'and' || conjunction === 'or') return conjunction

  return 'and'
}

function normalizeLogicToken(value: unknown, path: string): 'and' | 'or' | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw new ConditionGroupValidationError(`${path} must be "and" or "or"`)
  }
  const normalized = value.toLowerCase()
  if (normalized === 'and' || normalized === 'or') return normalized
  throw new ConditionGroupValidationError(`${path} must be "and" or "or"`)
}

function normalizeConjunctionToken(value: unknown, path: string): 'AND' | 'OR' | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw new ConditionGroupValidationError(`${path} must be "AND" or "OR"`)
  }
  const normalized = value.toUpperCase()
  if (normalized === 'AND' || normalized === 'OR') return normalized
  throw new ConditionGroupValidationError(`${path} must be "AND" or "OR"`)
}

function normalizeConditionLeaf(value: unknown, path: string): AutomationCondition {
  if (!isPlainObject(value)) {
    throw new ConditionGroupValidationError(`${path} must be an object`)
  }

  const fieldId = typeof value.fieldId === 'string' ? value.fieldId.trim() : ''
  if (!fieldId) {
    throw new ConditionGroupValidationError(`${path}.fieldId is required`)
  }

  const operator = value.operator
  if (typeof operator !== 'string' || !VALID_CONDITION_OPERATORS.has(operator as ConditionOperator)) {
    throw new ConditionGroupValidationError(`${path}.operator is invalid`)
  }

  const normalizedOperator = operator as ConditionOperator
  if (VALUE_REQUIRED_OPERATORS.has(normalizedOperator) && value.value === undefined) {
    throw new ConditionGroupValidationError(`${path}.value is required for ${normalizedOperator}`)
  }
  if (ARRAY_VALUE_OPERATORS.has(normalizedOperator) && !Array.isArray(value.value)) {
    throw new ConditionGroupValidationError(`${path}.value must be an array for ${normalizedOperator}`)
  }

  const condition: AutomationCondition = { fieldId, operator: normalizedOperator }
  if (value.value !== undefined) condition.value = value.value
  return condition
}

function normalizeConditionNodeInput(
  value: unknown,
  path: string,
  depth: number,
): AutomationConditionNode {
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'conditions')) {
    return normalizeConditionGroupInput(value, path, depth)
  }
  return normalizeConditionLeaf(value, path)
}

export function normalizeConditionGroupInput(
  value: unknown,
  path = 'conditions',
  depth = 0,
): ConditionGroup {
  if (depth > MAX_CONDITION_GROUP_DEPTH) {
    throw new ConditionGroupValidationError(`${path} exceeds maximum nesting depth ${MAX_CONDITION_GROUP_DEPTH}`)
  }
  if (!isPlainObject(value)) {
    throw new ConditionGroupValidationError(`${path} must be an object`)
  }

  const logic = normalizeLogicToken(value.logic, `${path}.logic`)
  const conjunction = normalizeConjunctionToken(value.conjunction, `${path}.conjunction`)
  if (!logic && !conjunction) {
    throw new ConditionGroupValidationError(`${path}.logic or ${path}.conjunction is required`)
  }
  if (logic && conjunction && logic !== conjunction.toLowerCase()) {
    throw new ConditionGroupValidationError(`${path}.logic and ${path}.conjunction must agree`)
  }
  if (!Array.isArray(value.conditions)) {
    throw new ConditionGroupValidationError(`${path}.conditions must be an array`)
  }

  const conditions = value.conditions.map((condition, index) =>
    normalizeConditionNodeInput(condition, `${path}.conditions[${index}]`, depth + 1),
  )

  if (conjunction) return { conjunction, conditions }
  return { logic: logic ?? 'and', conditions }
}

function allowedOperatorsForFieldType(fieldType: string): ReadonlySet<ConditionOperator> {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'modifiedTime':
    case 'autoNumber':
      return COMPARABLE_OPERATORS
    case 'boolean':
    case 'select':
    case 'person':
    case 'user':
    case 'link':
    case 'lookup':
    case 'rollup':
    case 'createdBy':
    case 'modifiedBy':
      return EQUALITY_OPERATORS
    case 'multiSelect':
      return MULTI_VALUE_OPERATORS
    case 'attachment':
      return EMPTY_VALUE_OPERATORS
    default:
      return TEXT_OPERATORS
  }
}

function expectedValueKindForFieldType(fieldType: string): 'number' | 'boolean' | 'string' | 'date' | 'dateTime' | null {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'autoNumber':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'dateTime':
      return 'dateTime'
    case 'attachment':
      return null
    default:
      return 'string'
  }
}

/** `5` or `'5'` (a finite numeric string is what a text input produces) — never `'abc'`, `''`, `NaN`. */
function isNumericConditionValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed !== '' && Number.isFinite(Number(trimmed))
  }
  return false
}

function assertNumericValue(value: unknown, path: string): void {
  if (isNumericConditionValue(value)) return
  throw new ConditionGroupValidationError(`${path} must be a number`, AUTOMATION_CONDITION_VALUE_INVALID_CODE)
}

/**
 * `true`/`false`, or the strings `'true'`/`'false'` (any case, trimmed) — exactly the spellings
 * `booleanKeyOf` evaluates, so a value the save gate accepts is a value the evaluator can compare. The
 * strings matter because the branch-condition editor's value control is a text input: refusing `'true'`
 * at save while evaluating it at run time made an existing checkbox-branch rule impossible to re-save.
 */
function isBooleanConditionValue(value: unknown): boolean {
  if (typeof value === 'boolean') return true
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'false'
  }
  return false
}

function assertBooleanValue(value: unknown, path: string): void {
  if (isBooleanConditionValue(value)) return
  throw new ConditionGroupValidationError(`${path} must be a boolean (true/false)`, AUTOMATION_CONDITION_VALUE_INVALID_CODE)
}

/**
 * The largest |epoch ms| a `Date` can represent (ECMAScript §21.4.1.1). `Intl.DateTimeFormat#formatToParts`
 * throws `RangeError: Invalid time value` beyond it, and a `date` cell gets no write-side validation
 * (field-codecs.ts only coerces `dateTime`), so a stored `1e20` must be treated as unreadable, not thrown on.
 */
const MAX_EPOCH_MS = 8.64e15

function isRepresentableEpochMs(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MS
}

// A bare calendar day — the #3417 floating-day spelling a `date` field stores and a person types.
const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The zone used only to test whether a date-time TEXT is well-formed (validity is zone-independent). */
const FORMAT_CHECK_ZONE = 'Etc/UTC'

/** Is `value` text a `date` condition can hold: `YYYY-MM-DD`, or any date-time text the wall-clock grammar reads. */
export function isValidDateConditionText(value: string): boolean {
  const trimmed = value.trim()
  const day = CALENDAR_DAY_RE.exec(trimmed)
  if (day) {
    return isValidWallClockParts({
      year: Number(day[1]),
      month: Number(day[2]),
      day: Number(day[3]),
      hour: 0,
      minute: 0,
      second: 0,
    })
  }
  return parseDateTimeText(trimmed, FORMAT_CHECK_ZONE).kind === 'instant'
}

/** Is `value` text a `dateTime` condition can hold: ISO-8601 with zone, or a zone-less `YYYY-MM-DD[ HH:mm[:ss]]` wall clock. */
export function isValidDateTimeConditionText(value: string): boolean {
  return parseDateTimeText(value, FORMAT_CHECK_ZONE).kind === 'instant'
}

function assertConditionValueType(
  condition: AutomationCondition,
  fieldType: string,
  path: string,
): void {
  if (!VALUE_REQUIRED_OPERATORS.has(condition.operator)) return

  const expectedKind = expectedValueKindForFieldType(fieldType)
  if (!expectedKind) return

  const isArrayOperator = ARRAY_VALUE_OPERATORS.has(condition.operator)
  if (isArrayOperator && !Array.isArray(condition.value)) {
    throw new ConditionGroupValidationError(`${path}.value must be an array for ${condition.operator}`)
  }
  const values: unknown[] = isArrayOperator ? condition.value as unknown[] : [condition.value]
  if (isArrayOperator && values.length === 0) {
    throw new ConditionGroupValidationError(`${path}.value must not be empty for ${condition.operator}`)
  }

  values.forEach((value, index) => {
    const valuePath = isArrayOperator ? `${path}.value[${index}]` : `${path}.value`
    if (expectedKind === 'number') {
      assertNumericValue(value, valuePath)
      return
    }
    if (expectedKind === 'boolean') {
      assertBooleanValue(value, valuePath)
      return
    }
    if (typeof value !== 'string') {
      throw new ConditionGroupValidationError(`${valuePath} must be a string`, AUTOMATION_CONDITION_VALUE_INVALID_CODE)
    }
    if (expectedKind === 'date' && !isValidDateConditionText(value)) {
      throw new ConditionGroupValidationError(
        `${valuePath} must be a date (YYYY-MM-DD)`,
        AUTOMATION_CONDITION_VALUE_INVALID_CODE,
      )
    }
    if (expectedKind === 'dateTime' && !isValidDateTimeConditionText(value)) {
      throw new ConditionGroupValidationError(
        `${valuePath} must be a date-time (YYYY-MM-DD HH:mm or ISO-8601)`,
        AUTOMATION_CONDITION_VALUE_INVALID_CODE,
      )
    }
  })
}

function assertConditionOptionValues(
  condition: AutomationCondition,
  field: AutomationConditionField,
  path: string,
): void {
  if (!VALUE_REQUIRED_OPERATORS.has(condition.operator)) return

  const optionValues = configuredOptionValuesForField(field)
  if (!optionValues) return

  const values = ARRAY_VALUE_OPERATORS.has(condition.operator)
    ? condition.value as unknown[]
    : [condition.value]

  values.forEach((value, index) => {
    if (typeof value !== 'string') return
    if (optionValues.has(value)) return

    const valuePath = ARRAY_VALUE_OPERATORS.has(condition.operator)
      ? `${path}.value[${index}]`
      : `${path}.value`
    throw new ConditionGroupValidationError(
      `${valuePath} is not a configured option for field ${field.id}: ${value}`,
    )
  })
}

function validateConditionNodeAgainstFields(
  node: AutomationConditionNode,
  fieldsById: Map<string, AutomationConditionField>,
  path: string,
): void {
  if (isConditionGroup(node)) {
    node.conditions.forEach((condition, index) =>
      validateConditionNodeAgainstFields(condition, fieldsById, `${path}.conditions[${index}]`),
    )
    return
  }

  const field = fieldsById.get(node.fieldId)
  if (!field) {
    throw new ConditionGroupValidationError(`${path}.fieldId does not exist on sheet: ${node.fieldId}`)
  }

  const allowedOperators = allowedOperatorsForFieldType(field.type)
  if (!allowedOperators.has(node.operator)) {
    throw new ConditionGroupValidationError(
      `${path}.operator ${node.operator} is not supported for field type ${field.type}`,
    )
  }

  assertConditionValueType(node, field.type, path)
  assertConditionOptionValues(node, field, path)
}

export function validateConditionGroupAgainstFields(
  conditionGroup: ConditionGroup | null | undefined,
  fields: AutomationConditionField[],
  path = 'conditions',
): void {
  if (!conditionGroup) return
  const fieldsById = new Map(fields.map((field) => [field.id, field]))
  conditionGroup.conditions.forEach((condition, index) =>
    validateConditionNodeAgainstFields(condition, fieldsById, `${path}.conditions[${index}]`),
  )
}

// ─── Typed evaluation (客户反馈 2026-09-24 #4b) ─────────────────────────────────────────────────────────

/** Build the id-keyed field map the evaluator reads (`null` when there is nothing to key on). */
export function normalizeConditionFields(
  fields: ReadonlyMap<string, AutomationConditionField> | readonly AutomationConditionField[] | null | undefined,
): ReadonlyMap<string, AutomationConditionField> | null {
  if (!fields) return null
  if (fields instanceof Map) return fields
  const map = new Map<string, AutomationConditionField>()
  for (const field of fields as readonly AutomationConditionField[]) {
    if (field && typeof field.id === 'string' && typeof field.type === 'string') map.set(field.id, field)
  }
  return map
}

type TypedComparisonKind = 'day' | 'instant' | 'set' | 'boolean' | 'number'

function typedComparisonKind(fieldType: string): TypedComparisonKind | null {
  switch (fieldType) {
    case 'date':
      return 'day'
    case 'dateTime':
      return 'instant'
    case 'person':
    case 'user':
    case 'link':
    case 'multiSelect':
      return 'set'
    case 'boolean':
      return 'boolean'
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'autoNumber':
      return 'number'
    default:
      return null
  }
}

/** `null`/`undefined`/`''`/`[]` — what `is_empty` means on every typed field. */
function isEmptyTypedValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'string' && value.trim() === ''
}

/**
 * A comparison key. `undefined` = the side is EMPTY (nothing to compare), `null` = the side has content
 * that cannot be read as the field's type (legacy / malformed — reported, never thrown), otherwise the
 * ordered key (a `yyyymmdd` day, a UTC minute, a number, or 0/1 for a boolean).
 */
type OrderedKey = number | null | undefined

function calendarDayKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day
}

function dayKeyOf(value: unknown, timeZone: string): OrderedKey {
  if (isEmptyTypedValue(value)) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const day = CALENDAR_DAY_RE.exec(trimmed)
    if (day) {
      const parts = { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]), hour: 0, minute: 0, second: 0 }
      return isValidWallClockParts(parts) ? calendarDayKey(parts.year, parts.month, parts.day) : null
    }
    const parsed = parseDateTimeText(trimmed, timeZone)
    if (parsed.kind !== 'instant') return null
    const zoned = getZonedParts(parsed.ms, timeZone)
    return calendarDayKey(zoned.year, zoned.month, zoned.day)
  }
  if (typeof value === 'number') {
    // Out of the representable range ⇒ unreadable (`null`), never handed to `Intl` (which would throw).
    if (!isRepresentableEpochMs(value)) return null
    const zoned = getZonedParts(value, timeZone)
    return calendarDayKey(zoned.year, zoned.month, zoned.day)
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // A Date's time value is always representable or NaN — the NaN case was excluded above.
    const zoned = getZonedParts(value.getTime(), timeZone)
    return calendarDayKey(zoned.year, zoned.month, zoned.day)
  }
  return null
}

function minuteKeyOf(value: unknown, timeZone: string): OrderedKey {
  if (isEmptyTypedValue(value)) return undefined
  // Same range rule as `dayKeyOf`: a number no `Date` can hold is not an instant.
  if (typeof value === 'number' && !isRepresentableEpochMs(value)) return null
  return dateTimeMinuteKey(value, timeZone)
}

function numberKeyOf(value: unknown): OrderedKey {
  if (isEmptyTypedValue(value)) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function booleanKeyOf(value: unknown): OrderedKey {
  if (isEmptyTypedValue(value)) return undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return 1
    if (normalized === 'false') return 0
  }
  return null
}

/**
 * The stored `id[]` of a person/link/multiSelect cell as a set of ids. A legacy SCALAR (a single id
 * stored before the array shape) reads as a one-element set; an object with a string `id` reads as that
 * id. `null` = the value has content but none of it is an id.
 */
function idSetOf(value: unknown): Set<string> | null | undefined {
  if (isEmptyTypedValue(value)) return undefined
  const items = Array.isArray(value) ? value : [value]
  const set = new Set<string>()
  let unreadable = false
  for (const item of items) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed) set.add(trimmed)
      continue
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      set.add(String(item))
      continue
    }
    if (isPlainObject(item) && typeof item.id === 'string' && item.id.trim()) {
      set.add(item.id.trim())
      continue
    }
    unreadable = true
  }
  if (set.size === 0) return unreadable ? null : undefined
  return set
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) if (b.has(item)) return true
  return false
}

function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const item of subset) if (!superset.has(item)) return false
  return true
}

type UnreadableReporter = (side: 'record' | 'condition') => void

/** Negated operators are TRUE when nothing could be compared (`not_equals`, `not_in`, `not_contains`). */
const NEGATED_OPERATORS = new Set<ConditionOperator>(['not_equals', 'not_in', 'not_contains'])

/** The "no match" outcome for `operator` — what every unreadable typed comparison evaluates to. */
function unmatchedResult(operator: ConditionOperator): boolean {
  return NEGATED_OPERATORS.has(operator)
}

/**
 * Ordered comparison shared by day / minute / number / boolean keys. `null` when the operator has no typed
 * meaning for this kind (the caller falls back to the legacy path).
 */
function compareOrderedKeys(
  operator: ConditionOperator,
  left: OrderedKey,
  conditionValue: unknown,
  keyOf: (value: unknown) => OrderedKey,
  report: UnreadableReporter,
): boolean | null {
  if (left === null) report('record')
  const rightOf = (value: unknown): OrderedKey => {
    const key = keyOf(value)
    if (key === null) report('condition')
    return key
  }
  const present = (key: OrderedKey): key is number => typeof key === 'number'

  switch (operator) {
    case 'equals': {
      const right = rightOf(conditionValue)
      return present(left) && present(right) && left === right
    }
    case 'not_equals': {
      const right = rightOf(conditionValue)
      return !(present(left) && present(right) && left === right)
    }
    case 'greater_than': {
      const right = rightOf(conditionValue)
      return present(left) && present(right) && left > right
    }
    case 'less_than': {
      const right = rightOf(conditionValue)
      return present(left) && present(right) && left < right
    }
    case 'greater_or_equal': {
      const right = rightOf(conditionValue)
      return present(left) && present(right) && left >= right
    }
    case 'less_or_equal': {
      const right = rightOf(conditionValue)
      return present(left) && present(right) && left <= right
    }
    case 'in': {
      if (!Array.isArray(conditionValue)) return false
      if (!present(left)) return false
      return conditionValue.some((value) => rightOf(value) === left)
    }
    case 'not_in': {
      if (!Array.isArray(conditionValue)) return true
      if (!present(left)) return true
      return !conditionValue.some((value) => rightOf(value) === left)
    }
    default:
      return null
  }
}

function compareIdSets(
  operator: ConditionOperator,
  fieldValue: unknown,
  conditionValue: unknown,
  report: UnreadableReporter,
): boolean | null {
  const left = idSetOf(fieldValue)
  if (left === null) report('record')
  const leftSet: ReadonlySet<string> = left ?? new Set<string>()
  const rightSetOf = (value: unknown): ReadonlySet<string> => {
    const set = idSetOf(value)
    if (set === null) report('condition')
    return set ?? new Set<string>()
  }

  switch (operator) {
    case 'equals':
      return left !== null && setsEqual(leftSet, rightSetOf(conditionValue))
    case 'not_equals':
      return !(left !== null && setsEqual(leftSet, rightSetOf(conditionValue)))
    case 'contains': {
      const right = rightSetOf(conditionValue)
      return right.size > 0 && isSubset(right, leftSet)
    }
    case 'not_contains': {
      const right = rightSetOf(conditionValue)
      return !(right.size > 0 && isSubset(right, leftSet))
    }
    case 'in':
      return setsIntersect(leftSet, rightSetOf(conditionValue))
    case 'not_in':
      return !setsIntersect(leftSet, rightSetOf(conditionValue))
    default:
      return null
  }
}

function fieldTimeZone(field: AutomationConditionField, env: NodeJS.ProcessEnv | undefined): string {
  return resolveDateTimeFieldTimeZone(normalizeJsonObject(field.property), env)
}

/**
 * The typed comparison for `condition` on `field`, or `null` when the field type / operator has no typed
 * rule (the caller then runs the legacy path). Never throws.
 */
function evaluateTypedCondition(
  condition: AutomationCondition,
  fieldValue: unknown,
  field: AutomationConditionField,
  options: ConditionEvaluationOptions,
): boolean | null {
  const kind = typedComparisonKind(field.type)
  if (!kind) return null

  if (condition.operator === 'is_empty') return isEmptyTypedValue(fieldValue)
  if (condition.operator === 'is_not_empty') return !isEmptyTypedValue(fieldValue)

  const report: UnreadableReporter = (side) => {
    options.onUnreadableValue?.({ fieldId: field.id, fieldType: field.type, operator: condition.operator, side })
  }

  switch (kind) {
    case 'day': {
      const zone = fieldTimeZone(field, options.env)
      const keyOf = (value: unknown): OrderedKey => dayKeyOf(value, zone)
      return compareOrderedKeys(condition.operator, keyOf(fieldValue), condition.value, keyOf, report)
    }
    case 'instant': {
      const zone = fieldTimeZone(field, options.env)
      const keyOf = (value: unknown): OrderedKey => minuteKeyOf(value, zone)
      return compareOrderedKeys(condition.operator, keyOf(fieldValue), condition.value, keyOf, report)
    }
    case 'number':
      return compareOrderedKeys(condition.operator, numberKeyOf(fieldValue), condition.value, numberKeyOf, report)
    case 'boolean':
      return compareOrderedKeys(condition.operator, booleanKeyOf(fieldValue), condition.value, booleanKeyOf, report)
    case 'set':
      return compareIdSets(condition.operator, fieldValue, condition.value, report)
    default:
      return null
  }
}

/** The pre-#4b untyped comparison — kept byte-for-byte for unknown fields and untyped callers. */
function evaluateLegacyCondition(condition: AutomationCondition, fieldValue: unknown): boolean {
  switch (condition.operator) {
    case 'equals':
      return fieldValue === condition.value

    case 'not_equals':
      return fieldValue !== condition.value

    case 'contains': {
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue.includes(condition.value)
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(condition.value)
      }
      return false
    }

    case 'not_contains': {
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return !fieldValue.includes(condition.value)
      }
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(condition.value)
      }
      return true
    }

    case 'greater_than': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue > condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue > condition.value
      }
      return false
    }

    case 'less_than': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue < condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue < condition.value
      }
      return false
    }

    case 'greater_or_equal': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue >= condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue >= condition.value
      }
      return false
    }

    case 'less_or_equal': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue <= condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue <= condition.value
      }
      return false
    }

    case 'is_empty':
      return fieldValue === null || fieldValue === undefined || fieldValue === ''

    case 'is_not_empty':
      return fieldValue !== null && fieldValue !== undefined && fieldValue !== ''

    case 'in': {
      if (!Array.isArray(condition.value)) return false
      return (condition.value as unknown[]).includes(fieldValue)
    }

    case 'not_in': {
      if (!Array.isArray(condition.value)) return true
      return !(condition.value as unknown[]).includes(fieldValue)
    }

    default:
      return false
  }
}

function lookupField(
  options: ConditionEvaluationOptions | undefined,
  fieldId: string,
): AutomationConditionField | undefined {
  const fields = options?.fields
  if (!fields) return undefined
  if (fields instanceof Map) return fields.get(fieldId)
  for (const field of fields as readonly AutomationConditionField[]) {
    if (field?.id === fieldId) return field
  }
  return undefined
}

/**
 * Evaluate a single condition against a field value. With `options.fields` the comparison is typed (see
 * the module header); without them, or for a field not in the map, it is the legacy untyped comparison.
 */
export function evaluateCondition(
  condition: AutomationCondition,
  recordData: Record<string, unknown>,
  options?: ConditionEvaluationOptions,
): boolean {
  const fieldValue = recordData[condition.fieldId]

  const field = lookupField(options, condition.fieldId)
  if (field && options) {
    let typed: boolean | null
    try {
      typed = evaluateTypedCondition(condition, fieldValue, field, options)
    } catch {
      // The never-throws safety net. The comparators are written not to throw (range-guarded epoch ms,
      // `null` for every unreadable shape), so this is reached only by a value shape nobody anticipated —
      // e.g. a `Date` subclass whose getter throws. The run must not fail on it (handleEvent would log it
      // as an action failure and a workflow_job_v1 execution would be left 'running'); it is reported
      // values-free with side `'unknown'` and evaluates as unmatched.
      options.onUnreadableValue?.({ fieldId: field.id, fieldType: field.type, operator: condition.operator, side: 'unknown' })
      return unmatchedResult(condition.operator)
    }
    if (typed !== null) return typed
  }

  return evaluateLegacyCondition(condition, fieldValue)
}

function evaluateConditionNode(
  node: AutomationConditionNode,
  recordData: Record<string, unknown>,
  options?: ConditionEvaluationOptions,
): boolean {
  return isConditionGroup(node)
    ? evaluateConditions(node, recordData, options)
    : evaluateCondition(node, recordData, options)
}

/**
 * Evaluate a condition group against record data.
 * AND: all conditions must pass.
 * OR: at least one condition must pass.
 */
export function evaluateConditions(
  conditionGroup: ConditionGroup,
  recordData: Record<string, unknown>,
  options?: ConditionEvaluationOptions,
): boolean {
  const { conditions } = conditionGroup

  if (!conditions || conditions.length === 0) {
    return true // no conditions means always pass
  }

  const logic = resolveGroupLogic(conditionGroup)
  if (logic === 'and') {
    return conditions.every((c) => evaluateConditionNode(c, recordData, options))
  }

  // logic === 'or'
  return conditions.some((c) => evaluateConditionNode(c, recordData, options))
}
