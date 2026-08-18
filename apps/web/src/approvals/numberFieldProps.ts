import type { FormField } from '../types/approval'

/**
 * B2-02 (UX audit): `el-input-number` visual/validation attrs derived from a FormField's `props`
 * bag. Presets already declare these (see `commonTemplatePresets.ts`) — 请假天数 `{ min: 0.5, step:
 * 0.5 }`, 报销金额/采购明细单价等 `{ min: 0 }` — but neither fill-view number input ever spread
 * them onto the rendered widget, so they were purely decorative: a user could submit -3 请假天数
 * client-side with zero feedback, and the ONLY signal was an unreadable server 400 once the backend
 * re-validated `props` (see ApprovalProductService). This makes the widget honor the same declared
 * bounds the backend already enforces.
 *
 * `field.props` is an untyped `Record<string, unknown>` bag shared by every field type — it also
 * carries non-widget keys such as a detail-column's `derivedFrom` (see `lineDerivation.ts`) — so
 * this reads ONLY the four numeric keys `el-input-number` understands and silently drops anything
 * that isn't a finite number (strings, booleans, nested objects, NaN/Infinity). Absent/invalid
 * `props` → `{}`, which spreads onto the input as a no-op.
 */
export interface NumberFieldPropsAttrs {
  min?: number
  max?: number
  step?: number
  precision?: number
}

const NUMBER_FIELD_PROP_KEYS = ['min', 'max', 'step', 'precision'] as const

export function numberFieldProps(
  field: Pick<FormField, 'props'> | null | undefined,
): NumberFieldPropsAttrs {
  const props = field?.props
  if (!props || typeof props !== 'object') return {}

  const result: NumberFieldPropsAttrs = {}
  for (const key of NUMBER_FIELD_PROP_KEYS) {
    const value = props[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value
    }
  }
  return result
}

// --- L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6/M10) ---------------------
// Formatted-number DISPLAY props: currency prefix + thousands grouping + the 中文大写 trigger flag.
// Distinct from `numberFieldProps` above — these are NOT `el-input-number` widget attrs (spreading
// a string/boolean onto that component would leak as a stray DOM attribute); they drive a
// PRESENTATION-ONLY caption alongside the input. M10 is load-bearing: this is a formatted echo of
// the same value the input holds, never a second stored value, never exact-money semantics.

export interface AmountDisplayProps {
  currencySymbol?: string
  thousandsSeparator?: boolean
}

/** Typed, values-free extraction of the two FORMATTING keys (mirrors `numberFieldProps`'s per-key
 *  allow-and-typecheck discipline). `uppercaseCny` is read separately by `isAmountWordsField` — a
 *  boolean trigger, not a formatting spec. */
export function amountDisplayProps(
  field: Pick<FormField, 'props'> | null | undefined,
): AmountDisplayProps {
  const props = field?.props
  if (!props || typeof props !== 'object') return {}
  const result: AmountDisplayProps = {}
  const currencySymbol = (props as Record<string, unknown>).currencySymbol
  if (typeof currencySymbol === 'string' && currencySymbol.trim()) {
    result.currencySymbol = currencySymbol.trim()
  }
  if ((props as Record<string, unknown>).thousandsSeparator === true) {
    result.thousandsSeparator = true
  }
  return result
}

/** True iff `field.props.uppercaseCny === true` on a `number` field — the L8-C per-field trigger
 *  for the 大写 caption, ADDITIVE to the pre-existing auto-summed-total trigger in
 *  ApprovalNewView.vue (§0.4: "L8-C re-sites [amountInWords] to a per-field display flag"; neither
 *  trigger replaces the other — an old template with no `uppercaseCny` prop keeps behaving exactly
 *  as it does today). */
export function isAmountWordsField(
  field: Pick<FormField, 'type' | 'props'> | null | undefined,
): boolean {
  return field?.type === 'number' && (field.props as Record<string, unknown> | undefined)?.uppercaseCny === true
}

function groupThousands(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    const posFromEnd = digits.length - i
    out += digits[i]
    if (posFromEnd > 1 && posFromEnd % 3 === 1) out += ','
  }
  return out
}

/** Round-half-up a value to `scale` decimals (mirrors the backend total-check's `toScaledInt` /
 *  `amountAutoSum.ts`'s scaled-integer rounding, at display precision rather than minor units).
 *  Non-finite input passes through unchanged (callers that need a finite number check first). */
export function roundToFieldScale(value: unknown, scale: number): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const factor = 10 ** scale
  return Math.round(value * factor) / factor
}

/**
 * Format a number for display with an optional currency prefix + thousands grouping —
 * PRESENTATION ONLY (M10: not exact-money; no change to storage, comparison, or the total-check).
 * `scale` is always the caller-supplied `numberFieldScale(field)` (amountAutoSum.ts) — the SAME
 * declared-precision scale the total-check and the 大写 caption already respect; there is no
 * second default here to drift from that one. Returns '' when neither display key is set (no
 * caption to render) or `value` is not a finite number (honest omission, mirrors
 * `amountToChineseWords`).
 */
export function formatAmountDisplay(value: unknown, spec: AmountDisplayProps, scale: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (!spec.currencySymbol && !spec.thousandsSeparator) return ''
  const rounded = roundToFieldScale(value, scale) as number
  const negative = rounded < 0
  const [intPart, fracPart] = Math.abs(rounded).toString().split('.')
  const grouped = spec.thousandsSeparator ? groupThousands(intPart ?? '0') : (intPart ?? '0')
  const withFrac = fracPart !== undefined ? `${grouped}.${fracPart}` : grouped
  const withCurrency = spec.currencySymbol ? `${spec.currencySymbol}${withFrac}` : withFrac
  return negative ? `-${withCurrency}` : withCurrency
}
