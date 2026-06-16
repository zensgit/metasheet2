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
      if (field?.type === 'select' || field?.type === 'multiSelect') {
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

// ===========================================================================
// Range-based SCALE formatting (A5: data bar / color scale / icon set)
// ---------------------------------------------------------------------------
// Distinct from the operator-match rules above: a scale rule is NOT "match →
// style"; it applies to EVERY cell of a numeric field, mapping each value
// against the field's min/max range. min/max is computed over the records
// passed in (caller scopes them to already-loaded, already-masked rows — the
// same client-side discipline as the A2 export picker; a full-column server
// aggregate is a separate gated follow-up). All three kinds are CONTRACT-level
// here: `dataBar` (A5-1), `colorScale` (A5-2, by-name stop interpolation),
// `iconSet` (A5-3, absolute-threshold bucketing). All three render in the grid:
// data-bar gradient (#2640), colorScale cell background + iconSet glyph (#2680).
// The builders here only produce barPct/scaleColor/iconKey; the cell drawing
// lives in MetaGridTable (cellStyle + cellScaleIcon), not in this service.
// ===========================================================================

export const CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT = 20

export type ConditionalFormattingScaleKind = 'dataBar' | 'colorScale' | 'iconSet'

export type ConditionalFormattingScaleRange = {
  mode: 'auto' | 'fixed'
  min?: number
  max?: number
}

export type ConditionalFormattingDataBarConfig = {
  color: string
  negativeColor?: string
  showValue?: boolean
}

// A5-2 color scale: 2 or 3 stops, resolved BY NAME (`at`), interpolated over the
// field min/max. A5-3 icon set: a named glyph set + two ABSOLUTE monotonic
// thresholds splitting values into 3 buckets (percentile mode deferred — the
// locked type has no mode field).
export type ConditionalFormattingColorScaleStop = { at: 'min' | 'mid' | 'max'; color: string }
export type ConditionalFormattingColorScaleConfig = { stops: ConditionalFormattingColorScaleStop[] }
export type ConditionalFormattingIconSetName = 'arrows3' | 'traffic3' | 'signs3'
export type ConditionalFormattingIconSetConfig = { set: ConditionalFormattingIconSetName; thresholds: [number, number] }

export type ConditionalFormattingScaleRule = {
  id: string
  order: number
  fieldId: string
  kind: ConditionalFormattingScaleKind
  enabled: boolean
  range: ConditionalFormattingScaleRange
  dataBar?: ConditionalFormattingDataBarConfig
  colorScale?: ConditionalFormattingColorScaleConfig
  iconSet?: ConditionalFormattingIconSetConfig
}

const ICON_SET_NAMES: ReadonlySet<string> = new Set(['arrows3', 'traffic3', 'signs3'])

/** Linear-interpolate two #rgb / #rrggbb / #rrggbbaa hex colors (alpha stripped). */
export function lerpHexColor(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    let h = hex.trim().replace(/^#/, '')
    if (h.length === 3) h = h.split('').map((c) => c + c).join('') // #abc -> #aabbcc
    if (h.length === 8) h = h.slice(0, 6) // strip alpha
    const n = parseInt(h.slice(0, 6), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const clampT = Math.max(0, Math.min(1, t))
  const [ar, ag, ab] = parse(a)
  const [br, bg, bb] = parse(b)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * clampT)
  const hx = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hx(mix(ar, br))}${hx(mix(ag, bg))}${hx(mix(ab, bb))}`
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function sanitizeConditionalFormattingScaleRule(input: unknown): ConditionalFormattingScaleRule | null {
  if (!isPlainObject(input)) return null
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() ? input.fieldId.trim() : null
  if (!id || !fieldId) return null

  const kind = input.kind
  if (kind !== 'dataBar' && kind !== 'colorScale' && kind !== 'iconSet') return null

  const orderRaw = typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : 0
  const enabled = input.enabled !== false

  const rangeRaw = isPlainObject(input.range) ? input.range : {}
  let range: ConditionalFormattingScaleRange
  if (rangeRaw.mode === 'fixed') {
    const min = toFiniteNumber(rangeRaw.min)
    const max = toFiniteNumber(rangeRaw.max)
    if (min === null || max === null || min === max) return null
    range = { mode: 'fixed', min: Math.min(min, max), max: Math.max(min, max) }
  } else {
    range = { mode: 'auto' }
  }

  const base = { id, order: Math.floor(orderRaw), fieldId, enabled, range }

  if (kind === 'dataBar') {
    const barRaw = isPlainObject(input.dataBar) ? input.dataBar : {}
    const color = sanitizeHex(barRaw.color)
    if (!color) return null
    const dataBar: ConditionalFormattingDataBarConfig = { color }
    const negativeColor = sanitizeHex(barRaw.negativeColor)
    if (negativeColor) dataBar.negativeColor = negativeColor
    if (barRaw.showValue === true) dataBar.showValue = true
    return { ...base, kind: 'dataBar', dataBar }
  }

  if (kind === 'colorScale') {
    // A5-2: crash-safe nested access; stops resolved BY NAME (`at`), 2 or 3, hex,
    // no duplicate `at`, must include min+max (+mid when 3-stop).
    const csRaw = isPlainObject(input.colorScale) ? input.colorScale : {}
    if (!Array.isArray(csRaw.stops)) return null
    const stops: ConditionalFormattingColorScaleStop[] = []
    const seen = new Set<string>()
    for (const s of csRaw.stops) {
      if (!isPlainObject(s)) return null
      const at = s.at
      if (at !== 'min' && at !== 'mid' && at !== 'max') return null
      if (seen.has(at)) return null
      const color = sanitizeHex(s.color)
      if (!color) return null
      seen.add(at)
      stops.push({ at, color })
    }
    if ((stops.length !== 2 && stops.length !== 3) || !seen.has('min') || !seen.has('max')) return null
    if (stops.length === 3 && !seen.has('mid')) return null
    return { ...base, kind: 'colorScale', colorScale: { stops } }
  }

  // A5-3 iconSet: named set + two ABSOLUTE monotonic thresholds (no silent swap).
  const isRaw = isPlainObject(input.iconSet) ? input.iconSet : {}
  if (!ICON_SET_NAMES.has(isRaw.set as string)) return null
  if (!Array.isArray(isRaw.thresholds) || isRaw.thresholds.length !== 2) return null
  const t0 = toFiniteNumber(isRaw.thresholds[0])
  const t1 = toFiniteNumber(isRaw.thresholds[1])
  if (t0 === null || t1 === null || t0 >= t1) return null
  return { ...base, kind: 'iconSet', iconSet: { set: isRaw.set as ConditionalFormattingIconSetName, thresholds: [t0, t1] } }
}

export function sanitizeConditionalFormattingScaleRules(input: unknown): ConditionalFormattingScaleRule[] {
  if (!Array.isArray(input)) return []
  const out: ConditionalFormattingScaleRule[] = []
  for (const item of input) {
    const rule = sanitizeConditionalFormattingScaleRule(item)
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
  return sanitizeConditionalFormattingScaleRules(config.conditionalFormattingScaleRules)
}

/**
 * Per-cell derived presentation for a scale rule. ADDITIVE by kind (NOT a
 * discriminated union — a `kind:` field would force itself onto the shipped
 * data-bar presentation and break #2640's renderer/tests). dataBar sets
 * barPct/barColor/negative; colorScale sets scaleColor; iconSet sets iconKey.
 * A consumer keys on the field it cares about (e.g. the data-bar renderer must
 * guard on barPct !== undefined — see MetaGridTable cellStyle).
 */
export type FieldScalePresentation = {
  /** dataBar — fill 0..100 = (value - min) / (max - min). */
  barPct?: number
  /** dataBar — `negativeColor` for negatives when configured, else `color`. */
  barColor?: string
  /** dataBar — true when the source value is negative. */
  negative?: boolean
  /** colorScale (A5-2) — interpolated cell background hex (#rrggbb). */
  scaleColor?: string
  /** iconSet (A5-3) — `${set}:${index}` where index ∈ {0,1,2}. */
  iconKey?: string
}

/** A5-2: resolve a value's interpolated color from the (by-name) stops. */
function colorScaleColor(cfg: ConditionalFormattingColorScaleConfig, v: number, min: number, max: number): string {
  const at = (name: 'min' | 'mid' | 'max') => cfg.stops.find((s) => s.at === name)?.color
  const minC = at('min') ?? '#000000'
  const maxC = at('max') ?? '#ffffff'
  const midC = at('mid')
  const span = max - min
  const t = span <= 0 ? 1 : Math.max(0, Math.min(1, (v - min) / span)) // degenerate -> max stop
  if (!midC) return lerpHexColor(minC, maxC, t)
  return t <= 0.5 ? lerpHexColor(minC, midC, t * 2) : lerpHexColor(midC, maxC, (t - 0.5) * 2)
}

/** A5-3: bucket a value into an icon index via the two absolute thresholds. */
function iconSetKey(cfg: ConditionalFormattingIconSetConfig, v: number): string {
  const [t0, t1] = cfg.thresholds
  const index = v < t0 ? 0 : v < t1 ? 1 : 2
  return `${cfg.set}:${index}`
}

export type FieldScaleResult = {
  rule: ConditionalFormattingScaleRule
  min: number
  max: number
  byRecordId: Record<string, FieldScalePresentation>
}

export type FieldScaleMap = {
  /** fieldId -> computed range + per-record presentation. */
  byField: Record<string, FieldScaleResult>
}

const EMPTY_SCALE_MAP: FieldScaleMap = Object.freeze({
  byField: Object.freeze({}) as Record<string, FieldScaleResult>,
}) as FieldScaleMap

/**
 * Pre-compute scale presentation (data-bar / color-scale / icon-set) per
 * (fieldId, recordId). For each enabled scale rule, compute the field's
 * [min,max] over `records` (auto) or use the rule's fixed range, then per kind:
 * dataBar → fill percent (degenerate range → full bar); colorScale →
 * interpolated scaleColor; iconSet → iconKey bucket. Records whose value is
 * non-numeric are skipped. The grid renders all three (MetaGridTable, #2640/#2680).
 */
export function buildFieldScaleMap(
  rules: ConditionalFormattingScaleRule[],
  records: ReadonlyArray<{ id?: string; data?: Record<string, unknown> }>,
  options: { precomputedRange?: Record<string, { min: number; max: number }> } = {},
): FieldScaleMap {
  if (!rules.length || !records.length) return EMPTY_SCALE_MAP
  const byField: Record<string, FieldScaleResult> = {}

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.kind === 'dataBar' && !rule.dataBar) continue
    if (rule.kind === 'colorScale' && !rule.colorScale) continue
    if (rule.kind === 'iconSet' && !rule.iconSet) continue
    if (byField[rule.fieldId]) continue // first rule per field wins (mirrors cell-style precedence)

    // Resolve range.
    let min: number
    let max: number
    if (rule.range.mode === 'fixed' && typeof rule.range.min === 'number' && typeof rule.range.max === 'number') {
      min = rule.range.min
      max = rule.range.max
    } else {
      const preset = options.precomputedRange?.[rule.fieldId]
      if (preset) {
        min = preset.min
        max = preset.max
      } else {
        let lo = Infinity
        let hi = -Infinity
        for (const record of records) {
          const v = toComparableNumber(record?.data?.[rule.fieldId])
          if (v === null) continue
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (lo === Infinity) continue // no numeric values → no bars for this field
        min = lo
        max = hi
      }
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
        byRecordId[record.id] = { scaleColor: colorScaleColor(rule.colorScale, v, min, max) }
      } else if (rule.kind === 'iconSet' && rule.iconSet) {
        byRecordId[record.id] = { iconKey: iconSetKey(rule.iconSet, v) }
      }
    }
    byField[rule.fieldId] = { rule, min, max, byRecordId }
  }

  if (Object.keys(byField).length === 0) return EMPTY_SCALE_MAP
  return { byField }
}
