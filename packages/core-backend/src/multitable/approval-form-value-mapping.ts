/**
 * FWB-1 mapping core — form/decision values → multitable field values (pure, fail-closed).
 *
 * targetType / selectOptions / numberPrecision MUST come from server-resolved meta_fields
 * (see approval-fwb-target-fields). Config-supplied types are never authority.
 *
 * D7/Q5: number values use exact fixed-decimal string validation (no Number() float loss,
 * never round — over-precision REJECT).
 */
import {
  canonicalizeDatetimeToUtcIso,
  coerceExactDecimal,
  isStrictCalendarDate,
} from './approval-fwb-target-fields'
import { sanitizeRichLongText } from './field-codecs'

export type FwbTargetFieldType = 'text' | 'number' | 'date' | 'dateTime' | 'select'

export interface FwbFieldMapping {
  formFieldId: string
  targetFieldId: string
  targetType: FwbTargetFieldType
  /** Server-derived rich-longText marker; never accepted from action config as authority. */
  richLongText?: boolean
  selectOptions?: readonly string[]
  /** Server-derived fractional digit cap for number fields (Q5). */
  numberPrecision?: number
}

export type FwbMappingResult =
  | { ok: true; values: Record<string, string | number> }
  | { ok: false; errors: Array<{ formFieldId: string; targetFieldId: string; code: FwbMappingErrorCode }> }

export type FwbMappingErrorCode =
  | 'unsupported_target_type'
  | 'missing_required_value'
  | 'not_a_number'
  | 'not_a_date'
  | 'not_a_datetime'
  | 'not_text'
  | 'select_value_not_in_options'
  | 'select_options_missing'
  | 'number_precision_exceeded'

function coerce(mapping: FwbFieldMapping, raw: unknown): { ok: true; v: string | number } | { ok: false; code: FwbMappingErrorCode } {
  switch (mapping.targetType) {
    case 'text': {
      if (typeof raw === 'string') {
        return { ok: true, v: mapping.richLongText ? sanitizeRichLongText(raw) : raw }
      }
      if (typeof raw === 'boolean') return { ok: true, v: raw ? 'true' : 'false' }
      // integers only as text (no float toString drift)
      if (typeof raw === 'number' && Number.isSafeInteger(raw)) return { ok: true, v: String(raw) }
      return { ok: false, code: 'not_text' }
    }
    case 'number': {
      const r = coerceExactDecimal(raw, mapping.numberPrecision)
      if (!r.ok) return r
      // Store as decimal string (D7 fixed-point). Callers write into jsonb as-is.
      return { ok: true, v: r.v }
    }
    case 'date': {
      if (typeof raw === 'string' && isStrictCalendarDate(raw)) {
        return { ok: true, v: raw.trim() }
      }
      return { ok: false, code: 'not_a_date' }
    }
    case 'dateTime': {
      if (typeof raw !== 'string') return { ok: false, code: 'not_a_datetime' }
      const datetime = canonicalizeDatetimeToUtcIso(raw)
      return datetime.ok
        ? { ok: true, v: datetime.v }
        : { ok: false, code: 'not_a_datetime' }
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

export function mapApprovalFormValues(
  mappings: readonly FwbFieldMapping[],
  formValues: Readonly<Record<string, unknown>>,
): FwbMappingResult {
  const errors: Array<{ formFieldId: string; targetFieldId: string; code: FwbMappingErrorCode }> = []
  const values: Record<string, string | number> = {}
  for (const m of mappings) {
    const supported: readonly string[] = ['text', 'number', 'date', 'dateTime', 'select']
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
