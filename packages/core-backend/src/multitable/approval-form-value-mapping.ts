/**
 * FWB-1 slice ① — approval form values → multitable field values (pure mapping, fail-closed).
 *
 * The `write_approval_form_values` action maps a SAVED mapping config (template form field → target sheet
 * field) over a submitted form's values to produce the record payload. Ratified scope (#4203): first slice
 * supports **text / number / date / select** only. Everything else fails CLOSED:
 *   - an unmapped/unknown target field type → the WHOLE action is rejected (never a silent partial write);
 *   - a value that cannot be coerced to the target type → per-mapping error, action rejected (a form value
 *     is business data — writing a mangled coercion would fabricate audit-adjacent data);
 *   - select values must be in the target field's CURRENT option set (closed vocabulary — no invention;
 *     the execute-time seam re-derives options from the live field metadata, never from the saved mapping);
 *   - date accepts ONLY explicit calendar-date strings `YYYY-MM-DD` that are real Gregorian dates — no
 *     epoch-ms input, no timezone conversion (lock D8: 日历日字面写入，禁止任何隐式时区转换);
 *   - number preserves EXACT decimal semantics as a CANONICAL DECIMAL STRING (lock D7: decimal 定点字符串
 *     规范化流转). STRING lexemes are exact at arbitrary scale and never pass through JS Number; JSON
 *     NUMERIC inputs are accepted only inside a conservative lossless envelope (finite, safe-integer when
 *     integral, plain-decimal `String()` form, ≤15 significant digits) because JSON.parse has already
 *     rounded them before we see them — exponent notation, NaN/Infinity, malformed numbers and any
 *     precision-changing coercion reject. Canonical form strips leading/trailing zeros and collapses
 *     signed zero (`-0` → `0`); scale beyond the execute-time target precision REJECTS the whole step
 *     (§11 Q5 — never rounds);
 *   - text is stringified from string/number/boolean ONLY (objects rejected).
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
  /** execute-time target number-field precision; absent means no configured decimal-place cap. */
  numberPrecision?: number
}

export type FwbMappingResult =
  | { ok: true; values: Record<string, string> }
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// Plain decimal grammar ONLY: optional '-', integer digits, optional fraction. No exponent, no '+',
// no hex/binary, no NaN/Infinity, no bare '.', no '.5'/'5.' — anything else is malformed, never coerced.
const DECIMAL = /^-?\d+(?:\.\d+)?$/

/**
 * Canonicalize a plain-decimal lexeme WITHOUT routing through JS Number (lock D7): strip integer-part
 * leading zeros (keeping a single `0`), strip fraction trailing zeros (dropping the dot when emptied),
 * and collapse signed zero (`-0`, `-0.00` → `0`). Returns the canonical decimal string and its scale
 * (fraction digits after trailing-zero stripping — trailing zeros carry no information, so `12.340`
 * under precision 2 passes as `12.34`, exactly as Q5 intends; excess REAL scale rejects, never rounds).
 */
function canonicalizeDecimal(lexeme: string): { canonical: string; scale: number } {
  const negative = lexeme.startsWith('-')
  const unsigned = negative ? lexeme.slice(1) : lexeme
  const [integerRaw, fractionRaw = ''] = unsigned.split('.')
  const integer = integerRaw.replace(/^0+(?=\d)/, '')
  const fraction = fractionRaw.replace(/0+$/, '')
  const digits = fraction.length > 0 ? `${integer}.${fraction}` : integer
  const isZero = integer === '0' && fraction.length === 0
  return { canonical: isZero ? '0' : `${negative ? '-' : ''}${digits}`, scale: fraction.length }
}

function coerceNumber(
  mapping: FwbFieldMapping,
  raw: unknown,
): { ok: true; value: string } | { ok: false; code: FwbMappingErrorCode } {
  let lexeme: string
  if (typeof raw === 'string') {
    lexeme = raw.trim()
    if (!DECIMAL.test(lexeme)) return { ok: false, code: 'not_a_number' }
  } else if (typeof raw === 'number') {
    // JSON snapshots carry numbers as JS numbers — JSON.parse has ALREADY rounded the source literal to
    // this double before we see it, so provenance is lossless only inside a conservative envelope:
    // finite, safe-integer when integral (an unsafe integer means fabricated digits), a plain-decimal
    // `String(raw)` form (exponent outputs like 1e-7/1e21 have no canonical fixed-point form here), and
    // ≤15 significant digits (beyond the reliably round-trippable decimal envelope the represented value
    // may already differ from the source lexeme — e.g. 9007199254740990.5 parses to the SAFE integer
    // 9007199254740990, its fraction silently destroyed). Anything outside rejects; strings above are
    // the exact arbitrary-precision path.
    if (!Number.isFinite(raw)) return { ok: false, code: 'not_a_number' }
    if (Number.isInteger(raw) && !Number.isSafeInteger(raw)) return { ok: false, code: 'number_not_lossless' }
    lexeme = String(raw)
    if (!DECIMAL.test(lexeme)) return { ok: false, code: 'number_not_lossless' }
    const significantDigits = canonicalizeDecimal(lexeme).canonical.replace(/[-.]/g, '').replace(/^0+/, '').length || 1
    if (significantDigits > 15) return { ok: false, code: 'number_not_lossless' }
  } else {
    return { ok: false, code: 'not_a_number' }
  }
  const { canonical, scale } = canonicalizeDecimal(lexeme)
  const precision = mapping.numberPrecision
  if (
    precision !== undefined
    && (!Number.isSafeInteger(precision) || precision < 0 || scale > precision)
  ) return { ok: false, code: 'number_precision_exceeded' }
  return { ok: true, value: canonical }
}

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}

function coerce(mapping: FwbFieldMapping, raw: unknown): { ok: true; v: string } | { ok: false; code: FwbMappingErrorCode } {
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
      // Lock D8: explicit calendar-date strings ONLY — no epoch-ms input, no Date construction,
      // no timezone conversion. Numbers (and everything else) reject.
      if (typeof raw === 'string') {
        const value = raw.trim()
        if (isValidIsoCalendarDate(value)) return { ok: true, v: value }
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
  const values: Record<string, string> = {}
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
    const r = coerce(m, raw) as { ok: boolean; v?: string; code?: FwbMappingErrorCode }
    if (r.ok && r.v !== undefined) {
      values[m.targetFieldId] = r.v
    } else {
      errors.push({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId, code: r.code ?? 'unsupported_target_type' })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}
