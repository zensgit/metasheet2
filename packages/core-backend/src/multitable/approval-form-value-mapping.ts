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
 *   - date accepts ISO `YYYY-MM-DD` or epoch-ms number, normalized to ISO; number accepts finite numbers or
 *     numeric strings (trimmed); text is stringified from string/number/boolean ONLY (objects rejected).
 *
 * Pure and synchronous — permission rechecks, the same-transaction claim+record+revision+outbox composition,
 * and the config UI are the later FWB-1 slices. No callers yet.
 */
export type FwbTargetFieldType = 'text' | 'number' | 'date' | 'select'

export interface FwbFieldMapping {
  /** template form field id to read from. */
  formFieldId: string
  /** target sheet field id to write. */
  targetFieldId: string
  targetType: FwbTargetFieldType
  /** required for targetType 'select': the CLOSED set of allowed option values. */
  selectOptions?: readonly string[]
}

export type FwbMappingResult =
  | { ok: true; values: Record<string, string | number> }
  | { ok: false; errors: Array<{ formFieldId: string; targetFieldId: string; code: FwbMappingErrorCode }> }

export type FwbMappingErrorCode =
  | 'unsupported_target_type'
  | 'missing_required_value'
  | 'not_a_number'
  | 'not_a_date'
  | 'not_text'
  | 'select_value_not_in_options'
  | 'select_options_missing'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function coerce(mapping: FwbFieldMapping, raw: unknown): { ok: true; v: string | number } | { ok: false; code: FwbMappingErrorCode } {
  switch (mapping.targetType) {
    case 'text': {
      if (typeof raw === 'string') return { ok: true, v: raw }
      if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, v: String(raw) }
      if (typeof raw === 'boolean') return { ok: true, v: raw ? 'true' : 'false' }
      return { ok: false, code: 'not_text' }
    }
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, v: raw }
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw.trim()))) return { ok: true, v: Number(raw.trim()) }
      return { ok: false, code: 'not_a_number' }
    }
    case 'date': {
      if (typeof raw === 'string' && ISO_DATE.test(raw.trim())) {
        const t = Date.parse(raw.trim() + 'T00:00:00Z')
        if (Number.isFinite(t)) return { ok: true, v: raw.trim() }
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const d = new Date(raw)
        if (Number.isFinite(d.getTime())) return { ok: true, v: d.toISOString().slice(0, 10) }
      }
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
