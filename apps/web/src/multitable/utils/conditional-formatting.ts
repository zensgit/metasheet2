// Frontend mirror of
// `packages/core-backend/src/multitable/conditional-formatting-service.ts`.
// The backend is canonical (unit-tested); this module reproduces the same
// shape for in-browser rendering. Keep the operator/value semantics in sync
// when extending the rule schema.

import type {
  ConditionalFormattingOperator,
  ConditionalFormattingRule,
  ConditionalFormattingStyle,
  MetaField,
  MetaRecord,
} from '../types'

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

const KNOWN_OPERATORS: ReadonlySet<ConditionalFormattingOperator> = new Set([
  'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between',
  'contains', 'not_contains', 'is_empty', 'is_not_empty',
  'is_today', 'is_in_last_n_days', 'is_in_next_n_days', 'is_overdue',
  'is_true', 'is_false',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return HEX_COLOR_RE.test(value) ? value : undefined
}

export function isOperator(value: unknown): value is ConditionalFormattingOperator {
  return typeof value === 'string' && KNOWN_OPERATORS.has(value as ConditionalFormattingOperator)
}

export function operatorRequiresValue(operator: ConditionalFormattingOperator): boolean {
  switch (operator) {
    case 'is_empty':
    case 'is_not_empty':
    case 'is_today':
    case 'is_overdue':
    case 'is_true':
    case 'is_false':
      return false
    default:
      return true
  }
}

export function operatorIsBetween(operator: ConditionalFormattingOperator): boolean {
  return operator === 'between'
}

export function sanitizeRule(input: unknown): ConditionalFormattingRule | null {
  if (!isPlainObject(input)) return null
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() ? input.fieldId.trim() : null
  if (!id || !fieldId) return null
  if (!isOperator(input.operator)) return null
  const operator = input.operator as ConditionalFormattingOperator

  const orderRaw = typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : 0
  const enabled = input.enabled !== false

  const styleRaw = isPlainObject(input.style) ? input.style : {}
  const style: ConditionalFormattingStyle = {}
  const bg = sanitizeHex(styleRaw.backgroundColor)
  if (bg) style.backgroundColor = bg
  const tc = sanitizeHex(styleRaw.textColor)
  if (tc) style.textColor = tc
  if (styleRaw.applyToRow === true) style.applyToRow = true

  let value: unknown = undefined
  switch (operator) {
    case 'between': {
      if (!Array.isArray(input.value) || input.value.length !== 2) return null
      value = [input.value[0], input.value[1]]
      break
    }
    case 'is_empty':
    case 'is_not_empty':
    case 'is_today':
    case 'is_overdue':
    case 'is_true':
    case 'is_false':
      break
    case 'is_in_last_n_days':
    case 'is_in_next_n_days': {
      const n = Number(input.value)
      if (!Number.isFinite(n) || n <= 0) return null
      value = Math.floor(n)
      break
    }
    default:
      if (input.value === undefined || input.value === null) return null
      value = input.value
      break
  }

  return { id, order: Math.floor(orderRaw), fieldId, operator, value, style, enabled }
}

export function sanitizeRules(input: unknown): ConditionalFormattingRule[] {
  if (!Array.isArray(input)) return []
  const out: ConditionalFormattingRule[] = []
  for (const item of input) {
    const rule = sanitizeRule(item)
    if (rule) out.push(rule)
  }
  return out
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.order - b.rule.order || a.index - b.index)
    .map((entry) => entry.rule)
}

export function extractRulesFromConfig(config: unknown): ConditionalFormattingRule[] {
  if (!isPlainObject(config)) return []
  return sanitizeRules(config.conditionalFormattingRules)
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
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
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

export interface EvaluateOptions {
  now?: number
}

export function evaluateRule(
  rule: ConditionalFormattingRule,
  recordData: Record<string, unknown>,
  field: MetaField | undefined,
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
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparableNumber(cellValue)
      const b = toComparableNumber(rule.value)
      if (a === null || b === null) return false
      if (rule.operator === 'gt') return a > b
      if (rule.operator === 'gte') return a >= b
      if (rule.operator === 'lt') return a < b
      return a <= b
    }
    case 'between': {
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return false
      const v = toComparableNumber(cellValue)
      const lo = toComparableNumber(rule.value[0])
      const hi = toComparableNumber(rule.value[1])
      if (v === null || lo === null || hi === null) return false
      return v >= Math.min(lo, hi) && v <= Math.max(lo, hi)
    }
    case 'eq': {
      if (field?.type === 'select') {
        const expected = toComparableString(rule.value)
        if (expected === null) return false
        return selectValuesArray(cellValue).includes(expected)
      }
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
    case 'contains':
    case 'not_contains': {
      const expected = toComparableString(rule.value)
      if (expected === null) return rule.operator === 'not_contains'
      const needle = expected.toLowerCase()
      let matches = false
      if (Array.isArray(cellValue)) {
        matches = selectValuesArray(cellValue).some((entry) => entry.toLowerCase().includes(needle))
      } else {
        const haystack = toComparableString(cellValue)
        matches = haystack !== null && haystack.toLowerCase().includes(needle)
      }
      return rule.operator === 'contains' ? matches : !matches
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

export interface EvaluatedFormatting {
  rowStyle?: ConditionalFormattingStyle
  cellStyles: Record<string, ConditionalFormattingStyle>
  matchedRuleIds: string[]
}

const EMPTY_RESULT: EvaluatedFormatting = Object.freeze({
  cellStyles: Object.freeze({}) as Record<string, ConditionalFormattingStyle>,
  matchedRuleIds: Object.freeze([]) as unknown as string[],
}) as EvaluatedFormatting

export function evaluateRulesForRecord(
  rules: ConditionalFormattingRule[],
  record: MetaRecord | { data: Record<string, unknown> },
  fieldsById: Record<string, MetaField | undefined>,
  options: EvaluateOptions = {},
): EvaluatedFormatting {
  if (!rules.length) return EMPTY_RESULT
  const data = record?.data ?? {}
  let rowStyle: ConditionalFormattingStyle | undefined
  const cellStyles: Record<string, ConditionalFormattingStyle> = {}
  const matchedRuleIds: string[] = []
  for (const rule of rules) {
    const field = fieldsById[rule.fieldId]
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

export interface FormattingByRecord {
  rules: ConditionalFormattingRule[]
  byRecordId: Map<string, EvaluatedFormatting>
}

/**
 * Pre-compute formatting for each record once. Use this when displaying many
 * rows; the renderer can read from the map per (recordId, fieldId) without
 * re-evaluating rules on every scroll/render.
 */
export function buildRecordFormattingMap(
  rules: ConditionalFormattingRule[],
  records: ReadonlyArray<MetaRecord>,
  fields: ReadonlyArray<MetaField>,
  options: EvaluateOptions = {},
): FormattingByRecord {
  const fieldsById: Record<string, MetaField | undefined> = {}
  for (const field of fields) fieldsById[field.id] = field
  const byRecordId = new Map<string, EvaluatedFormatting>()
  if (!rules.length) return { rules, byRecordId }
  for (const record of records) {
    const result = evaluateRulesForRecord(rules, record, fieldsById, options)
    if (result.rowStyle || Object.keys(result.cellStyles).length > 0) {
      byRecordId.set(record.id, result)
    }
  }
  return { rules, byRecordId }
}

/**
 * Compose a CSS-style object from row-level + cell-level matches. The cell
 * style takes precedence over row style on the same property (intentional —
 * cell rules are more specific).
 */
export function composeStyleObject(
  rowStyle: ConditionalFormattingStyle | undefined,
  cellStyle: ConditionalFormattingStyle | undefined,
): Record<string, string> | undefined {
  if (!rowStyle && !cellStyle) return undefined
  const css: Record<string, string> = {}
  const bg = cellStyle?.backgroundColor ?? rowStyle?.backgroundColor
  const fg = cellStyle?.textColor ?? rowStyle?.textColor
  if (bg) css.backgroundColor = bg
  if (fg) css.color = fg
  return Object.keys(css).length > 0 ? css : undefined
}
