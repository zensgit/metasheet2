/**
 * Exact-anchor restorable scalar validation under the CURRENT schema (W0 L8).
 *
 * Re-runs the same field-codecs validators/coercers the normal write path uses
 * (`validateLongTextValue`, select/multiSelect option membership, numeric/boolean/string/date
 * shape, Batch-1 types, person shape). Exact-anchor semantics FAIL CLOSED when:
 *   - validation/coercion throws, OR
 *   - the canonicalized result differs from the signed historical value
 *     (e.g. rich longText sanitizer would strip XSS; `"5"` coerces to `5`).
 *
 * Never silently transforms history and still claims an exact restore. Links, attachment,
 * and derived/system types are out of scope here (handled by projection / dedicated paths).
 */
import {
  BATCH1_FIELD_TYPES,
  coerceBatch1Value,
  coerceNumericValue,
  isPersonSingleRecord,
  normalizeMultiSelectValue,
  validateDateTimeValue,
  validateLongTextValue,
  validateLocationValue,
  validatePersonValue,
} from './field-codecs'

export class ExactRestoreValueError extends Error {
  readonly code = 'value-invalid' as const
  constructor(message: string) {
    super(message)
    this.name = 'ExactRestoreValueError'
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export type ExactRestoreField = {
  id: string
  type: string
  property?: Record<string, unknown>
  /** select/multiSelect option values from the CURRENT schema (empty = no options allowed except ''). */
  options?: Array<{ value: string } | string>
}

function optionValues(field: ExactRestoreField): string[] {
  const opts = field.options ?? []
  return opts.map((o) => (typeof o === 'string' ? o : String(o.value)))
}

function normalizeSelectValue(value: unknown, fieldId: string, options: string[]): string {
  if (typeof value !== 'string') throw new ExactRestoreValueError(`Select value must be string: ${fieldId}`)
  if (value === '') return value
  if (!new Set(options).has(value)) {
    throw new ExactRestoreValueError(`Invalid select option for ${fieldId}: ${value}`)
  }
  return value
}

/**
 * Canonicalize a historical scalar under current field property/options. Throws
 * {@link ExactRestoreValueError} on reject OR when the canonical form differs from history.
 * Call only for restorable non-link scalar SET values (not unset/null).
 */
export function assertExactRestorableScalarValue(field: ExactRestoreField, historicalValue: unknown): void {
  // Unset paths pass null separately; null/empty string may still be a legitimate stored value for some types.
  let canonical: unknown
  try {
    switch (field.type) {
      case 'longText':
        canonical = validateLongTextValue(historicalValue, field.id, field.property)
        break
      case 'select':
        canonical = normalizeSelectValue(historicalValue, field.id, optionValues(field))
        break
      case 'multiSelect':
        canonical = normalizeMultiSelectValue(historicalValue, field.id, optionValues(field))
        break
      case 'number':
        canonical = coerceNumericValue(historicalValue, field.id, 'Number')
        break
      case 'boolean':
        if (typeof historicalValue !== 'boolean') {
          throw new ExactRestoreValueError(`Boolean value must be boolean: ${field.id}`)
        }
        canonical = historicalValue
        break
      case 'string':
      case 'date':
        if (typeof historicalValue !== 'string') {
          throw new ExactRestoreValueError(`String value must be string: ${field.id}`)
        }
        canonical = historicalValue
        break
      case 'dateTime':
        canonical = validateDateTimeValue(historicalValue, field.id)
        break
      case 'person': {
        // Shape + limitSingleRecord only (membership is plan-auth). Pass the historical ids as the
        // allowed set so membership never rewrites/rejects a well-shaped historical cell here.
        const raw = Array.isArray(historicalValue)
          ? historicalValue.map((v) => String(v).trim()).filter(Boolean)
          : []
        const allowed = new Set(raw)
        canonical = validatePersonValue(
          historicalValue,
          field.id,
          allowed,
          isPersonSingleRecord(field.property),
        )
        break
      }
      case 'location':
        canonical = validateLocationValue(historicalValue, field.id)
        break
      default:
        if (BATCH1_FIELD_TYPES.has(field.type)) {
          canonical = coerceBatch1Value(field.type, field.property, field.id, historicalValue)
        } else if (historicalValue === null || historicalValue === undefined) {
          canonical = null
        } else {
          // Unknown restorable type: accept only if JSON-stable identity (no silent transform).
          canonical = historicalValue
        }
        break
    }
  } catch (e) {
    if (e instanceof ExactRestoreValueError) throw e
    throw new ExactRestoreValueError(e instanceof Error ? e.message : String(e))
  }

  if (!sameValue(canonical, historicalValue)) {
    throw new ExactRestoreValueError(
      `Exact restore refused: current-schema validation would alter historical value for ${field.id}`,
    )
  }
}
