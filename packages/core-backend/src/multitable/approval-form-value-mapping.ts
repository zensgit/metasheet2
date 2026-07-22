/**
 * FWB-1 slice ① — approval form values → multitable field values (pure mapping, fail-closed).
 *
 * The `write_approval_form_values` action maps a SAVED mapping config (template form field → target sheet
 * field) over a submitted form's values to produce the record payload. Ratified scope (#4203): first slice
 * supports **text / number / date / select** only. Everything else fails CLOSED:
 *   - an unmapped/unknown target field type → the WHOLE action is rejected (never a silent partial write);
 *   - a value that cannot be coerced to the target type → per-mapping error, action rejected (a form value
 *     is business data — writing a mangled coercion would fabricate audit-adjacent data);
 *   - select values must be in the target field's option set (closed vocabulary — no invention);
 *   - date accepts ONLY a strict real-calendar `YYYY-MM-DD` string (leap-year validated) and preserves it
 *     BYTE-FOR-BYTE as the multitable value — epoch-ms numbers and datetime strings are rejected rather
 *     than inventing a civil date from an instant; number accepts only decimal
 *     values that remain lossless in JS and fit the execute-time target precision; text is stringified
 *     from string/number/boolean ONLY (objects rejected).
 *
 * Pure and synchronous — permission rechecks, the same-transaction claim+record+revision+outbox composition,
 * and the config UI are the later FWB-1 slices. No callers yet.
 */
import { isValidIsoCalendarDate } from '../utils/calendar-date'

export type FwbTargetFieldType = 'text' | 'number' | 'date' | 'select'

export interface FwbFieldMapping {
  /** template form field id to read from. */
  formFieldId: string
  /** target sheet field id to write. */
  targetFieldId: string
  targetType: FwbTargetFieldType
  /** required for targetType 'select': the CLOSED set of allowed option values. */
  selectOptions?: readonly string[]
  /** execute-time target number-field precision; absent means no configured decimal-place cap. */
  numberPrecision?: number
}

export type FwbMappingResult =
  | { ok: true; values: Record<string, string | number> }
  | { ok: false; errors: Array<{ formFieldId: string; targetFieldId: string; code: FwbMappingErrorCode }> }

export type FwbMappingErrorCode =
  | 'unsupported_target_type'
  | 'missing_required_value'
  | 'not_a_number'
  | 'number_not_lossless'
  | 'number_precision_exceeded'
  | 'not_a_date'
  | 'not_text'
  | 'select_value_not_in_options'
  | 'select_options_missing'

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/

function normalizedDecimal(raw: string): { value: number; scale: number; significantDigits: number } | null {
  const trimmed = raw.trim()
  const match = DECIMAL.exec(trimmed)
  if (!match) return null
  const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
  const [integerPart, fractionPart = ''] = unsigned.split('.')
  const fraction = fractionPart.replace(/0+$/, '')
  const significant = `${integerPart}${fraction}`.replace(/^0+/, '') || '0'
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  return { value, scale: fraction.length, significantDigits: significant.length }
}

function coerceNumber(
  mapping: FwbFieldMapping,
  raw: unknown,
): { ok: true; value: number } | { ok: false; code: FwbMappingErrorCode } {
  const parsed = typeof raw === 'number'
    ? normalizedDecimal(String(raw))
    : (typeof raw === 'string' ? normalizedDecimal(raw) : null)
  if (!parsed) return { ok: false, code: 'not_a_number' }
  if (Number.isInteger(parsed.value)) {
    if (!Number.isSafeInteger(parsed.value)) return { ok: false, code: 'number_not_lossless' }
  } else if (parsed.significantDigits > 15) {
    // JSON/JS has already lost the source lexeme by this point. Reject values whose represented
    // precision exceeds the reliably round-trippable decimal envelope instead of writing an approximation.
    return { ok: false, code: 'number_not_lossless' }
  }
  const precision = mapping.numberPrecision
  if (
    precision !== undefined
    && (!Number.isSafeInteger(precision) || precision < 0 || parsed.scale > precision)
  ) return { ok: false, code: 'number_precision_exceeded' }
  return { ok: true, value: parsed.value }
}

function coerce(mapping: FwbFieldMapping, raw: unknown): { ok: true; v: string | number } | { ok: false; code: FwbMappingErrorCode } {
  switch (mapping.targetType) {
    case 'text': {
      if (typeof raw === 'string') return { ok: true, v: raw }
      if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, v: String(raw) }
      if (typeof raw === 'boolean') return { ok: true, v: raw ? 'true' : 'false' }
      return { ok: false, code: 'not_text' }
    }
    case 'number': {
      const number = coerceNumber(mapping, raw)
      if ('code' in number) return number
      return { ok: true, v: number.value }
    }
    case 'date': {
      // Date-ONLY target: the approved value is already a strict `YYYY-MM-DD` civil-date
      // string (submit-time validation enforced that upstream). Preserve it BYTE-FOR-BYTE —
      // no trim, and no epoch-ms/Date/datetime-string acceptance: deriving a civil date
      // from an instant would invent data (and could shift the day across timezones).
      if (typeof raw === 'string' && isValidIsoCalendarDate(raw)) return { ok: true, v: raw }
      return { ok: false, code: 'not_a_date' }
    }
    case 'select': {
      if (!mapping.selectOptions || mapping.selectOptions.length === 0) return { ok: false, code: 'select_options_missing' }
      if (typeof raw === 'string' && mapping.selectOptions.includes(raw)) return { ok: true, v: raw }
      return { ok: false, code: 'select_value_not_in_options' }
    }
    default:
      return { ok: false, code: 'unsupported_target_type' }
  }
}

/**
 * Map form values through the saved config. ALL-OR-NOTHING: any mapping error rejects the whole action
 * (fail-closed — never a silent partial record). Missing form values are errors (`missing_required_value`)
 * unless the mapping is absent entirely; optionality policy is a config-UI concern in a later slice.
 */
export function mapApprovalFormValues(
  mappings: readonly FwbFieldMapping[],
  formValues: Readonly<Record<string, unknown>>,
): FwbMappingResult {
  const errors: Array<{ formFieldId: string; targetFieldId: string; code: FwbMappingErrorCode }> = []
  const values: Record<string, string | number> = {}
  for (const m of mappings) {
    const supported: readonly string[] = ['text', 'number', 'date', 'select']
    if (!supported.includes(m.targetType)) {
      errors.push({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId, code: 'unsupported_target_type' })
      continue
    }
    const raw = formValues[m.formFieldId]
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      errors.push({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId, code: 'missing_required_value' })
      continue
    }
    const r = coerce(m, raw) as { ok: boolean; v?: string | number; code?: FwbMappingErrorCode }
    if (r.ok && r.v !== undefined) {
      values[m.targetFieldId] = r.v
    } else {
      errors.push({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId, code: r.code ?? 'unsupported_target_type' })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}
