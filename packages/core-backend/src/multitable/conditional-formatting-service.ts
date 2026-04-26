import type { MultitableField } from './field-codecs'
import { isPlainObject } from './field-codecs'

export const CONDITIONAL_FORMATTING_RULE_LIMIT = 20

export type ConditionalFormattingOperator =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'neq'
  | 'between'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_today'
  | 'is_in_last_n_days'
  | 'is_in_next_n_days'
  | 'is_overdue'
  | 'is_true'
  | 'is_false'

export type ConditionalFormattingStyle = {
  backgroundColor?: string
  textColor?: string
  applyToRow?: boolean
}

export type ConditionalFormattingRule = {
  id: string
  order: number
  fieldId: string
  operator: ConditionalFormattingOperator
  value?: unknown
  style: ConditionalFormattingStyle
  enabled: boolean
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const KNOWN_OPERATORS: ReadonlySet<ConditionalFormattingOperator> = new Set([
  'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between',
  'contains', 'not_contains', 'is_empty', 'is_not_empty',
  'is_today', 'is_in_last_n_days', 'is_in_next_n_days', 'is_overdue',
  'is_true', 'is_false',
])

function sanitizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return HEX_COLOR_RE.test(value) ? value : undefined
}

export function sanitizeConditionalFormattingRule(input: unknown): ConditionalFormattingRule | null {
  if (!isPlainObject(input)) return null
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() ? input.fieldId.trim() : null
  const operatorRaw = typeof input.operator === 'string' ? input.operator.trim() : ''
  if (!id || !fieldId) return null
  if (!KNOWN_OPERATORS.has(operatorRaw as ConditionalFormattingOperator)) return null
  const operator = operatorRaw as ConditionalFormattingOperator

  const orderRaw = typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : 0
  const enabled = input.enabled !== false

  const styleRaw = isPlainObject(input.style) ? input.style : {}
  const style: ConditionalFormattingStyle = {}
  const bg = sanitizeHex(styleRaw.backgroundColor)
  if (bg) style.backgroundColor = bg
  const tc = sanitizeHex(styleRaw.textColor)
  if (tc) style.textColor = tc
  if (styleRaw.applyToRow === true) style.applyToRow = true

  // Operator-dependent value
  let value: unknown = undefined
  switch (operator) {
    case 'between': {
      if (Array.isArray(input.value) && input.value.length === 2) {
        value = [input.value[0], input.value[1]]
      } else {
        return null
      }
      break
    }
    case 'is_empty':
    case 'is_not_empty':
    case 'is_today':
    case 'is_overdue':
    case 'is_true':
    case 'is_false':
      // No value required
      break
    case 'is_in_last_n_days':
    case 'is_in_next_n_days': {
      const n = Number(input.value)
      if (!Number.isFinite(n) || n <= 0) return null
      value = Math.floor(n)
      break
    }
    default:
      // gt/gte/lt/lte/eq/neq/contains/not_contains expect a scalar
      if (input.value === undefined || input.value === null) return null
      value = input.value
      break
  }

  return {
    id,
    order: Math.floor(orderRaw),
    fieldId,
    operator,
    value,
    style,
    enabled,
  }
}

export function sanitizeConditionalFormattingRules(input: unknown): ConditionalFormattingRule[] {
  if (!Array.isArray(input)) return []
  const out: ConditionalFormattingRule[] = []
  for (const item of input) {
    const rule = sanitizeConditionalFormattingRule(item)
    if (rule) out.push(rule)
    if (out.length >= CONDITIONAL_FORMATTING_RULE_LIMIT) break
  }
  // Stable sort by `order` ascending; ties resolved by original index.
  return out
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.order - b.rule.order || a.index - b.index)
    .map((entry) => entry.rule)
}

export function extractRulesFromConfig(config: unknown): ConditionalFormattingRule[] {
  if (!isPlainObject(config)) return []
  const raw = config.conditionalFormattingRules
  return sanitizeConditionalFormattingRules(raw)
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toComparableString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

function startOfDay(date: Date): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return d.getTime()
}

function toDateMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function compareNumber(
  cellValue: unknown,
  ruleValue: unknown,
  cmp: (a: number, b: number) => boolean,
): boolean {
  const a = toComparableNumber(cellValue)
  const b = toComparableNumber(ruleValue)
  if (a === null || b === null) return false
  return cmp(a, b)
}

function selectValuesArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item === 'string') out.push(item)
      else if (typeof item === 'number') out.push(String(item))
    }
    return out
  }
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  return []
}

export type EvaluateOptions = {
  /** Override "now" for deterministic testing. Defaults to Date.now(). */
  now?: number
}

export function evaluateRule(
  rule: ConditionalFormattingRule,
  recordData: Record<string, unknown>,
  field: MultitableField | undefined,
  options: EvaluateOptions = {},
): boolean {
  if (!rule.enabled) return false
  const cellValue = recordData[rule.fieldId]

  switch (rule.operator) {
    case 'is_empty':
      return isEmptyValue(cellValue)
    case 'is_not_empty':
      return !isEmptyValue(cellValue)
    case 'is_true':
      return cellValue === true || cellValue === 'true' || cellValue === 1
    case 'is_false':
      return cellValue === false || cellValue === 'false' || cellValue === 0
    case 'gt':
      return compareNumber(cellValue, rule.value, (a, b) => a > b)
    case 'gte':
      return compareNumber(cellValue, rule.value, (a, b) => a >= b)
    case 'lt':
      return compareNumber(cellValue, rule.value, (a, b) => a < b)
    case 'lte':
      return compareNumber(cellValue, rule.value, (a, b) => a <= b)
    case 'between': {
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return false
      const [lo, hi] = rule.value
      const v = toComparableNumber(cellValue)
      const a = toComparableNumber(lo)
      const b = toComparableNumber(hi)
      if (v === null || a === null || b === null) return false
      const min = Math.min(a, b)
      const max = Math.max(a, b)
      return v >= min && v <= max
    }
    case 'eq': {
      // For select fields, match if any selected option equals rule.value.
      if (field?.type === 'select') {
        const expected = toComparableString(rule.value)
        if (expected === null) return false
        return selectValuesArray(cellValue).includes(expected)
      }
      // Otherwise loose-equal across number/string/boolean.
      const a = toComparableString(cellValue)
      const b = toComparableString(rule.value)
      if (a === null || b === null) return cellValue === rule.value
      return a === b
    }
    case 'neq': {
      if (field?.type === 'select') {
        const expected = toComparableString(rule.value)
        if (expected === null) return false
        return !selectValuesArray(cellValue).includes(expected)
      }
      const a = toComparableString(cellValue)
      const b = toComparableString(rule.value)
      if (a === null || b === null) return cellValue !== rule.value
      return a !== b
    }
    case 'contains': {
      const expected = toComparableString(rule.value)
      if (expected === null) return false
      if (Array.isArray(cellValue)) {
        return selectValuesArray(cellValue).some((entry) => entry.toLowerCase().includes(expected.toLowerCase()))
      }
      const haystack = toComparableString(cellValue)
      if (haystack === null) return false
      return haystack.toLowerCase().includes(expected.toLowerCase())
    }
    case 'not_contains': {
      const expected = toComparableString(rule.value)
      if (expected === null) return false
      if (Array.isArray(cellValue)) {
        return !selectValuesArray(cellValue).some((entry) => entry.toLowerCase().includes(expected.toLowerCase()))
      }
      const haystack = toComparableString(cellValue)
      if (haystack === null) return true
      return !haystack.toLowerCase().includes(expected.toLowerCase())
    }
    case 'is_today': {
      const cellMs = toDateMs(cellValue)
      if (cellMs === null) return false
      const now = options.now ?? Date.now()
      return startOfDay(new Date(cellMs)) === startOfDay(new Date(now))
    }
    case 'is_in_last_n_days': {
      const cellMs = toDateMs(cellValue)
      const days = toComparableNumber(rule.value)
      if (cellMs === null || days === null || days <= 0) return false
      const now = options.now ?? Date.now()
      const startMs = startOfDay(new Date(now)) - (days - 1) * 86_400_000
      const endMs = startOfDay(new Date(now)) + 86_400_000
      return cellMs >= startMs && cellMs < endMs
    }
    case 'is_in_next_n_days': {
      const cellMs = toDateMs(cellValue)
      const days = toComparableNumber(rule.value)
      if (cellMs === null || days === null || days <= 0) return false
      const now = options.now ?? Date.now()
      const startMs = startOfDay(new Date(now))
      const endMs = startMs + days * 86_400_000
      return cellMs >= startMs && cellMs < endMs
    }
    case 'is_overdue': {
      const cellMs = toDateMs(cellValue)
      if (cellMs === null) return false
      const now = options.now ?? Date.now()
      return cellMs < startOfDay(new Date(now))
    }
    default:
      return false
  }
}

export type EvaluatedFormatting = {
  /** Style applied to the entire row (first matching `applyToRow` rule wins). */
  rowStyle?: ConditionalFormattingStyle
  /**
   * Style per field id (first matching cell-level rule per field wins).
   * Keys are field ids; values omit `applyToRow` flag.
   */
  cellStyles: Record<string, ConditionalFormattingStyle>
  /** Diagnostic — ordered ids of rules that matched (any scope). */
  matchedRuleIds: string[]
}

const EMPTY_RESULT: EvaluatedFormatting = Object.freeze({
  cellStyles: Object.freeze({}) as Record<string, ConditionalFormattingStyle>,
  matchedRuleIds: Object.freeze([]) as unknown as string[],
}) as EvaluatedFormatting

export function evaluateConditionalFormattingRules(
  rules: ConditionalFormattingRule[],
  record: { id?: string; data?: Record<string, unknown> } | Record<string, unknown> | null | undefined,
  fieldsById: Record<string, MultitableField | undefined> | Map<string, MultitableField>,
  options: EvaluateOptions = {},
): EvaluatedFormatting {
  if (!rules.length) return EMPTY_RESULT
  if (!record) return EMPTY_RESULT
  const data: Record<string, unknown> = isPlainObject((record as { data?: unknown }).data)
    ? ((record as { data: Record<string, unknown> }).data)
    : isPlainObject(record)
      ? (record as Record<string, unknown>)
      : {}

  const lookupField = (id: string): MultitableField | undefined => {
    if (fieldsById instanceof Map) return fieldsById.get(id)
    return fieldsById[id]
  }

  const cellStyles: Record<string, ConditionalFormattingStyle> = {}
  let rowStyle: ConditionalFormattingStyle | undefined
  const matchedRuleIds: string[] = []

  for (const rule of rules) {
    const field = lookupField(rule.fieldId)
    if (!evaluateRule(rule, data, field, options)) continue
    matchedRuleIds.push(rule.id)
    const baseStyle: ConditionalFormattingStyle = {}
    if (rule.style.backgroundColor) baseStyle.backgroundColor = rule.style.backgroundColor
    if (rule.style.textColor) baseStyle.textColor = rule.style.textColor
    if (rule.style.applyToRow) {
      if (!rowStyle) rowStyle = baseStyle
    } else if (!cellStyles[rule.fieldId]) {
      cellStyles[rule.fieldId] = baseStyle
    }
  }

  if (!rowStyle && Object.keys(cellStyles).length === 0 && matchedRuleIds.length === 0) {
    return EMPTY_RESULT
  }
  return { rowStyle, cellStyles, matchedRuleIds }
}
