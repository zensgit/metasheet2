/**
 * Exact-anchor restorable validation under the CURRENT schema (W0 L8).
 *
 * 1) Per-scalar exactness: re-run write-path codecs (`validateLongTextValue`, select/multiSelect,
 *    numeric/boolean/string/date shape, Batch-1, person shape). FAIL CLOSED when validation/coercion
 *    throws OR the canonicalized result differs from the signed historical value (no silent sanitize).
 * 2) Whole projected record: `validateRecord` with the same rule precedence as record-service
 *    (`property.validation` explicit list ?? `getDefaultValidationRules`). A newly-required field
 *    omitted/unset by the at-anchor projection ⇒ value-invalid before mint/write.
 *
 * Links / attachment / derived / system are out of scope for (1) (projection / dedicated paths).
 */
import {
  BATCH1_FIELD_TYPES,
  coerceBatch1Value,
  coerceNumericValue,
  isPersonSingleRecord,
  mapFieldType,
  normalizeMultiSelectValue,
  validateDateTimeValue,
  validateLongTextValue,
  validateLocationValue,
  validatePersonValue,
} from './field-codecs'
import type { FieldValidationConfig } from './field-validation'
import { getDefaultValidationRules, validateRecord } from './field-validation-engine'

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

/**
 * Whole projected-record validation under CURRENT field definitions (record-service precedence):
 * `explicit property.validation[] ?? getDefaultValidationRules(type, property)`.
 * Call with the FULL projected data (not just the patch) so newly-required fields that the historical
 * snapshot omits/unsets are still checked.
 */
export function assertExactRestorableRecordValid(
  fields: Array<{
    id: string
    name: string
    type: string
    property?: Record<string, unknown>
  }>,
  projectedData: Record<string, unknown>,
): void {
  const validationFields = fields.map((f) => {
    const fieldType = String(mapFieldType(f.type))
    const property = f.property ?? {}
    const explicitRules = Array.isArray(property.validation)
      ? (property.validation as FieldValidationConfig)
      : undefined
    const defaultRules = getDefaultValidationRules(fieldType, property)
    const mergedRules = explicitRules ?? defaultRules
    return {
      id: f.id,
      name: f.name || f.id,
      type: fieldType,
      config: mergedRules.length > 0 ? { validation: mergedRules } : undefined,
    }
  })
  const result = validateRecord(validationFields, projectedData)
  if (!result.valid) {
    throw new ExactRestoreValueError(
      `Exact restore refused: projected record fails CURRENT validation (${result.errors.map((e) => e.rule).join(',')})`,
    )
  }
}
