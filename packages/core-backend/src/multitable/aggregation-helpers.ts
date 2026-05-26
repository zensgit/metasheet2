/**
 * Footer aggregation helpers (benchmark v2 #4 sub-slice 3b-1).
 *
 * Dedicated helper (NOT the private `ChartAggregationService.aggregate`) so the footer's locked fn set
 * + config naming can't drift. `toNumber` replicated from chart-aggregation-service.ts (it's private).
 * Design: docs/development/multitable-agg-footer-design-20260525.md.
 */
export type AggregationFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countNonEmpty' | 'countDistinct'

const FN_SET: ReadonlySet<string> = new Set<AggregationFn>(['sum', 'avg', 'min', 'max', 'count', 'countNonEmpty', 'countDistinct'])
// Numeric field types (only these accept sum/avg/min/max).
const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set(['number', 'currency', 'percent', 'rating', 'autoNumber'])
const NUMERIC_ONLY_FNS: ReadonlySet<AggregationFn> = new Set<AggregationFn>(['sum', 'avg', 'min', 'max'])

export function isNumericFieldType(type: string): boolean {
  return NUMERIC_FIELD_TYPES.has(type)
}

// replicated from chart-aggregation-service.ts (private there)
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

// LOCKED: a cell is "empty" iff null / undefined / '' / [] (empty string / empty array).
export function isEmptyCell(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * Narrow parse of `view.config.aggregations` — only `{ [fieldId: string]: <known fn> }` survives;
 * dirty config (non-object / array / unknown fn / non-string key) is dropped. Mirrors parseFrozenIds.
 */
export function parseAggregations(config: Record<string, unknown> | null | undefined): Record<string, AggregationFn> {
  const raw = config?.aggregations
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, AggregationFn> = {}
  for (const [fieldId, fn] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof fieldId === 'string' && fieldId && typeof fn === 'string' && FN_SET.has(fn)) {
      out[fieldId] = fn as AggregationFn
    }
  }
  return out
}

/** True when `fn` can be applied to a field of `fieldType` (sum/avg/min/max require numeric). */
export function fnApplies(fn: AggregationFn, fieldType: string): boolean {
  if (NUMERIC_ONLY_FNS.has(fn)) return isNumericFieldType(fieldType)
  return true // count / countNonEmpty / countDistinct apply to any type
}

/**
 * Aggregate a column's values. Returns `number | null`; `null` = not applicable (caller OMITS it).
 * Non-numeric cell values are skipped by sum/avg/min/max (not zero-filled).
 */
export function aggregateField(values: unknown[], fn: AggregationFn, fieldType: string): number | null {
  if (!fnApplies(fn, fieldType)) return null
  switch (fn) {
    case 'count':
      return values.length
    case 'countNonEmpty':
      return values.reduce<number>((acc, v) => acc + (isEmptyCell(v) ? 0 : 1), 0)
    case 'countDistinct': {
      const seen = new Set<string>()
      for (const v of values) if (!isEmptyCell(v)) seen.add(JSON.stringify(v))
      return seen.size
    }
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      const nums: number[] = []
      for (const v of values) {
        const n = toNumber(v)
        if (n !== null) nums.push(n)
      }
      if (fn === 'sum') return nums.reduce((a, b) => a + b, 0)
      if (nums.length === 0) return null // avg/min/max over no numeric values → omit
      if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
      if (fn === 'min') return Math.min(...nums)
      return Math.max(...nums)
    }
  }
  return null
}
