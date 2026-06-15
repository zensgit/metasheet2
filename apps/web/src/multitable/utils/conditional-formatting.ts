// Frontend mirror of
// `packages/core-backend/src/multitable/conditional-formatting-service.ts`.
// The backend is canonical (unit-tested); this module reproduces the same
// shape for in-browser rendering. Keep the operator/value semantics in sync
// when extending the rule schema.

import type {
  ConditionalFormattingColorScaleConfig,
  ConditionalFormattingDataBarConfig,
  ConditionalFormattingIconSetConfig,
  ConditionalFormattingOperator,
  ConditionalFormattingRule,
  ConditionalFormattingScaleRange,
  ConditionalFormattingScaleRule,
  ConditionalFormattingStyle,
  MetaField,
  MetaRecord,
} from '../types'
import { CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT } from '../types'

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
      if (field?.type === 'select' || field?.type === 'multiSelect') {
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
      if (field?.type === 'select' || field?.type === 'multiSelect') {
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

// ===========================================================================
// Range-based SCALE formatting (A5-1 data bar / A5-2 color scale / A5-3 icon
// set) — frontend mirror of
// packages/core-backend/src/multitable/conditional-formatting-service.ts.
// Keep the sanitize/range/interpolation/build semantics BYTE-IDENTICAL to the
// canonical backend (no cross-package test harness — the only mirror-drift
// guard is matching expected-hex literals in both unit specs).
// ===========================================================================

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const ICON_SETS: ReadonlySet<ConditionalFormattingIconSetConfig['set']> = new Set([
  'arrows3', 'traffic3', 'signs3',
])

/** Parse a sanitized `#rgb`/`#rrggbb`/`#rrggbbaa` hex into [r,g,b] 0..255 (alpha ignored). */
function hexToRgb(hex: string): [number, number, number] {
  let body = hex.slice(1)
  if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
  // length 8 (rgba) → drop the trailing alpha pair; interpolation is over RGB only.
  const r = parseInt(body.slice(0, 2), 16)
  const g = parseInt(body.slice(2, 4), 16)
  const b = parseInt(body.slice(4, 6), 16)
  return [r, g, b]
}

/** Emit a lowercase `#rrggbb` from [r,g,b], rounding + clamping each channel to 0..255. */
function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (n: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(n)))
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
}

/** Linear-interpolate two hex colors at fraction t∈[0,1]; emits lowercase `#rrggbb`. */
function lerpHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  const f = Math.max(0, Math.min(1, t))
  return rgbToHex([
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ])
}

/**
 * Color at normalized position `t`∈[0,1] across the (anchor-sorted) stops.
 * 2 stops: lerp min↔max over t. 3 stops: piecewise with mid anchored at t=0.5
 * (t<0.5 lerps min↔mid over t/0.5; else mid↔max over (t-0.5)/0.5; t=0.5 yields
 * the mid color from either branch). Stops are pre-sorted min→mid→max.
 */
function colorScaleAt(stops: ReadonlyArray<{ at: 'min' | 'mid' | 'max'; color: string }>, t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  if (stops.length === 2) return lerpHex(stops[0].color, stops[1].color, clamped)
  // 3 stops: [min, mid, max]
  if (clamped <= 0.5) return lerpHex(stops[0].color, stops[1].color, clamped / 0.5)
  return lerpHex(stops[1].color, stops[2].color, (clamped - 0.5) / 0.5)
}

/** Parse the shared `range` field (auto/fixed); returns null for an invalid fixed range. */
function sanitizeScaleRange(raw: unknown): ConditionalFormattingScaleRange | null {
  const rangeRaw = isPlainObject(raw) ? raw : {}
  if (rangeRaw.mode === 'fixed') {
    const min = toFiniteNumber(rangeRaw.min)
    const max = toFiniteNumber(rangeRaw.max)
    if (min === null || max === null || min === max) return null
    return { mode: 'fixed', min: Math.min(min, max), max: Math.max(min, max) }
  }
  return { mode: 'auto' }
}

/** Parse + validate `colorScale.stops` (2 anchors min/max, or 3 anchors min/mid/max). */
function sanitizeColorScale(raw: unknown): ConditionalFormattingColorScaleConfig | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.stops)) return null
  const stops: Array<{ at: 'min' | 'mid' | 'max'; color: string }> = []
  for (const stop of raw.stops) {
    if (!isPlainObject(stop)) return null
    const at = stop.at
    if (at !== 'min' && at !== 'mid' && at !== 'max') return null
    const color = sanitizeHex(stop.color)
    if (!color) return null
    stops.push({ at, color })
  }
  if (stops.length < 2 || stops.length > 3) return null
  // Anchor set must EXACTLY match {min,max} (2) or {min,mid,max} (3) — no dup, no missing.
  const anchors = new Set(stops.map((s) => s.at))
  if (anchors.size !== stops.length) return null // duplicate anchor
  const required = stops.length === 2 ? ['min', 'max'] : ['min', 'mid', 'max']
  for (const a of required) if (!anchors.has(a as 'min' | 'mid' | 'max')) return null
  // Normalize to min→mid→max so the builder is order-independent.
  const order: Record<'min' | 'mid' | 'max', number> = { min: 0, mid: 1, max: 2 }
  stops.sort((a, b) => order[a.at] - order[b.at])
  return { stops }
}

/** Parse + validate `iconSet` (known set + finite, monotonic `[t0, t1]` thresholds). */
function sanitizeIconSet(raw: unknown): ConditionalFormattingIconSetConfig | null {
  if (!isPlainObject(raw)) return null
  const set = raw.set
  if (typeof set !== 'string' || !ICON_SETS.has(set as ConditionalFormattingIconSetConfig['set'])) return null
  if (!Array.isArray(raw.thresholds) || raw.thresholds.length !== 2) return null
  const t0 = toFiniteNumber(raw.thresholds[0])
  const t1 = toFiniteNumber(raw.thresholds[1])
  if (t0 === null || t1 === null || t0 > t1) return null // require monotonic ascending (t0 <= t1)
  return { set: set as ConditionalFormattingIconSetConfig['set'], thresholds: [t0, t1] }
}

export function sanitizeScaleRule(input: unknown): ConditionalFormattingScaleRule | null {
  if (!isPlainObject(input)) return null
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() ? input.fieldId.trim() : null
  if (!id || !fieldId) return null

  const orderRaw = typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : 0
  const enabled = input.enabled !== false

  const range = sanitizeScaleRange(input.range)
  if (!range) return null

  const base = { id, order: Math.floor(orderRaw), fieldId, enabled, range }

  // Per-kind config. Unknown kinds → null (keeps the forward-dated-config guard).
  switch (input.kind) {
    case 'dataBar': {
      const barRaw = isPlainObject(input.dataBar) ? input.dataBar : {}
      const color = sanitizeHex(barRaw.color)
      if (!color) return null
      const dataBar: ConditionalFormattingDataBarConfig = { color }
      const negativeColor = sanitizeHex(barRaw.negativeColor)
      if (negativeColor) dataBar.negativeColor = negativeColor
      if (barRaw.showValue === true) dataBar.showValue = true
      return { ...base, kind: 'dataBar', dataBar }
    }
    case 'colorScale': {
      const colorScale = sanitizeColorScale(input.colorScale)
      if (!colorScale) return null
      return { ...base, kind: 'colorScale', colorScale }
    }
    case 'iconSet': {
      const iconSet = sanitizeIconSet(input.iconSet)
      if (!iconSet) return null
      return { ...base, kind: 'iconSet', iconSet }
    }
    default:
      return null
  }
}

export function sanitizeScaleRules(input: unknown): ConditionalFormattingScaleRule[] {
  if (!Array.isArray(input)) return []
  const out: ConditionalFormattingScaleRule[] = []
  for (const item of input) {
    const rule = sanitizeScaleRule(item)
    if (rule) out.push(rule)
    if (out.length >= CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT) break
  }
  return out
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.order - b.rule.order || a.index - b.index)
    .map((entry) => entry.rule)
}

export function extractScaleRulesFromConfig(config: unknown): ConditionalFormattingScaleRule[] {
  if (!isPlainObject(config)) return []
  return sanitizeScaleRules(config.conditionalFormattingScaleRules)
}

/**
 * Per-cell derived presentation. Fields are kind-specific and all optional:
 * dataBar → `barPct`/`barColor`/`negative`; colorScale → `scaleColor`;
 * iconSet → `iconKey`. Optional (not a discriminated union) so the kind-blind
 * grid renderer's `${scale.barColor} ${scale.barPct}%` template still compiles.
 */
export interface FieldScalePresentation {
  barPct?: number
  barColor?: string
  negative?: boolean
  /** Color-scale background — interpolated `#rrggbb` at the value's normalized position. */
  scaleColor?: string
  /** Icon-set band: `'low'` (v<t0) / `'mid'` (t0<=v<t1) / `'high'` (v>=t1). */
  iconKey?: 'low' | 'mid' | 'high'
}
export interface FieldScaleResult {
  rule: ConditionalFormattingScaleRule
  min: number
  max: number
  byRecordId: Record<string, FieldScalePresentation>
}
export interface FieldScaleMap {
  byField: Record<string, FieldScaleResult>
}

const EMPTY_SCALE_MAP: FieldScaleMap = Object.freeze({
  byField: Object.freeze({}) as Record<string, FieldScaleResult>,
}) as FieldScaleMap

/**
 * Pre-compute per-(fieldId, recordId) scale presentation. Mirrors the backend
 * `buildFieldScaleMap`: resolve min/max over the passed records (auto) or the
 * rule's fixed range, then derive a kind-specific presentation per finite value:
 * dataBar → `barPct` (0..100; degenerate min==max → 100) + `barColor`
 * (negativeColor when v<0) + `negative`; colorScale → `scaleColor` interpolated
 * at t=(v-min)/(max-min), degenerate → t=0.5; iconSet → `iconKey` banded by
 * ABSOLUTE thresholds (v<t0 'low' / t0<=v<t1 'mid' / v>=t1 'high'). Non-numeric
 * skipped; a field with no numeric values omitted; first rule per field wins.
 * Caller passes the already-loaded/masked rows (client-side discipline). The
 * grid renderer is still kind-blind (data bars only) — per-kind render is next.
 */
export function buildFieldScaleMap(
  rules: ConditionalFormattingScaleRule[],
  records: ReadonlyArray<MetaRecord | { id?: string; data?: Record<string, unknown> }>,
): FieldScaleMap {
  if (!rules.length || !records.length) return EMPTY_SCALE_MAP
  const byField: Record<string, FieldScaleResult> = {}

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (byField[rule.fieldId]) continue
    if (rule.kind === 'dataBar' && !rule.dataBar) continue
    if (rule.kind === 'colorScale' && !rule.colorScale) continue
    if (rule.kind === 'iconSet' && !rule.iconSet) continue

    let min: number
    let max: number
    if (rule.range.mode === 'fixed' && typeof rule.range.min === 'number' && typeof rule.range.max === 'number') {
      min = rule.range.min
      max = rule.range.max
    } else {
      let lo = Infinity
      let hi = -Infinity
      for (const record of records) {
        const v = toComparableNumber(record?.data?.[rule.fieldId])
        if (v === null) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (lo === Infinity) continue
      min = lo
      max = hi
    }

    const span = max - min
    const byRecordId: Record<string, FieldScalePresentation> = {}
    for (const record of records) {
      if (!record?.id) continue
      const v = toComparableNumber(record.data?.[rule.fieldId])
      if (v === null) continue

      if (rule.kind === 'dataBar' && rule.dataBar) {
        const pct = span <= 0 ? 100 : Math.max(0, Math.min(100, ((v - min) / span) * 100))
        const negative = v < 0
        const barColor = negative && rule.dataBar.negativeColor ? rule.dataBar.negativeColor : rule.dataBar.color
        byRecordId[record.id] = { barPct: pct, barColor, negative }
      } else if (rule.kind === 'colorScale' && rule.colorScale) {
        const t = span <= 0 ? 0.5 : (v - min) / span
        byRecordId[record.id] = { scaleColor: colorScaleAt(rule.colorScale.stops, t) }
      } else if (rule.kind === 'iconSet' && rule.iconSet) {
        const [t0, t1] = rule.iconSet.thresholds
        const iconKey: 'low' | 'mid' | 'high' = v < t0 ? 'low' : v < t1 ? 'mid' : 'high'
        byRecordId[record.id] = { iconKey }
      }
    }
    byField[rule.fieldId] = { rule, min, max, byRecordId }
  }

  if (Object.keys(byField).length === 0) return EMPTY_SCALE_MAP
  return { byField }
}
