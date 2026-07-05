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
