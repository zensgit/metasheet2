/**
 * Field Validation Engine
 *
 * Runs validation rules against field values for multitable records.
 * Used by both internal record editing and public form submission.
 */

import type {
  FieldValidationConfig,
  FieldValidationError,
  FieldValidationRule,
  ValidationResult,
} from './field-validation'
import {
  describeUserRegexRefusal,
  runUserRegex,
  type UserRegexLengthRefusal,
} from '../formula/regex-safety'

// ---------------------------------------------------------------------------
// Default messages
// ---------------------------------------------------------------------------

function defaultMessage(rule: FieldValidationRule, fieldName: string): string {
  switch (rule.type) {
    case 'required':
      return `${fieldName} is required`
    case 'min':
      return `${fieldName} must be at least ${(rule.params as any)?.value}`
    case 'max':
      return `${fieldName} must be at most ${(rule.params as any)?.value}`
    case 'minLength':
      return `${fieldName} must have at least ${(rule.params as any)?.value} characters`
    case 'maxLength':
      return `${fieldName} must have at most ${(rule.params as any)?.value} characters`
    case 'pattern':
      return `${fieldName} does not match the required format`
    case 'enum':
      return `${fieldName} must be one of the allowed values`
    case 'custom':
      return `${fieldName} is invalid`
    default:
      return `${fieldName} failed validation (${rule.type})`
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function toLength(value: unknown): number | null {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.length
  return null
}

// ---------------------------------------------------------------------------
// Single-rule validators
// ---------------------------------------------------------------------------

function validateRequired(value: unknown): boolean {
  return !isEmpty(value)
}

function validateMin(value: unknown, min: number): boolean {
  const n = toNumber(value)
  if (n === null) return false
  return n >= min
}

function validateMax(value: unknown, max: number): boolean {
  const n = toNumber(value)
  if (n === null) return false
  return n <= max
}

function validateMinLength(value: unknown, minLen: number): boolean {
  const len = toLength(value)
  if (len === null) return false
  return len >= minLen
}

function validateMaxLength(value: unknown, maxLen: number): boolean {
  const len = toLength(value)
  if (len === null) return false
  return len <= maxLen
}

/**
 * The `pattern` rule compiles a caller-supplied regex and runs it on the record
 * value. Both go through the shared length gate in `../formula/regex-safety.ts`
 * (the constants there name the product limits they are taken from). Inside the
 * limits the outcome is the same `re.test(value)` as before; an invalid regex is
 * still a failed validation. A value or pattern over the limits is ALSO a failed
 * validation, but it is reported through `refusal` so the caller can give it a
 * message that says the check declined to run, rather than the format message.
 */
function evaluatePatternRule(
  value: unknown,
  regex: string,
  flags?: string,
): { valid: boolean; refusal?: UserRegexLengthRefusal } {
  if (typeof value !== 'string') return { valid: false }
  const outcome = runUserRegex(regex, flags, value, (re, subject) => re.test(subject), {
    site: 'field-validation:pattern',
  })
  if (outcome.status === 'ok') return { valid: outcome.value }
  if (outcome.refusal.kind === 'invalid-pattern') {
    // If the regex is invalid, treat as failed validation (unchanged behaviour)
    return { valid: false }
  }
  return { valid: false, refusal: outcome.refusal }
}

function validateEnum(value: unknown, values: string[]): boolean {
  if (Array.isArray(value)) return value.every((item) => values.includes(String(item)))
  if (typeof value === 'string') return values.includes(value)
  if (typeof value === 'number') return values.includes(String(value))
  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a single field value against its validation rules.
 * Returns an array of errors (empty if valid).
 */
export function validateFieldValue(
  fieldId: string,
  fieldName: string,
  _fieldType: string,
  value: unknown,
  rules: FieldValidationConfig,
): FieldValidationError[] {
  const errors: FieldValidationError[] = []
  const hasRequired = rules.some((r) => r.type === 'required')

  // If value is empty and no required rule, skip all other rules
  if (isEmpty(value) && !hasRequired) {
    return errors
  }

  for (const rule of rules) {
    let valid = true
    let refusalMessage: string | null = null
    const params = rule.params as Record<string, unknown> | undefined

    switch (rule.type) {
      case 'required':
        valid = validateRequired(value)
        break
      case 'min':
        // Skip range checks when value is empty (will be caught by required if present)
        if (isEmpty(value)) continue
        valid = validateMin(value, Number(params?.value))
        break
      case 'max':
        if (isEmpty(value)) continue
        valid = validateMax(value, Number(params?.value))
        break
      case 'minLength':
        if (isEmpty(value)) continue
        valid = validateMinLength(value, Number(params?.value))
        break
      case 'maxLength':
        if (isEmpty(value)) continue
        valid = validateMaxLength(value, Number(params?.value))
        break
      case 'pattern': {
        if (isEmpty(value)) continue
        const outcome = evaluatePatternRule(
          value,
          String(params?.regex ?? ''),
          typeof params?.flags === 'string' ? params.flags : undefined,
        )
        valid = outcome.valid
        if (outcome.refusal) refusalMessage = describeUserRegexRefusal(outcome.refusal, fieldName)
        break
      }
      case 'enum':
        if (isEmpty(value)) continue
        valid = validateEnum(value, Array.isArray(params?.values) ? params.values as string[] : [])
        break
      case 'custom':
        // Custom rules are not evaluated engine-side; they need external handlers.
        // Treat as pass-through for now.
        continue
      default:
        continue
    }

    if (!valid) {
      errors.push({
        fieldId,
        fieldName,
        rule: rule.type,
        // A length refusal is not a format mismatch: it gets its own message so a
        // reader can tell "the value did not match" from "the check did not run".
        message: refusalMessage ?? rule.message ?? defaultMessage(rule, fieldName),
      })
    }
  }

  return errors
}

/**
 * Validate an entire record against all field validation configs.
 * Returns all errors at once so the frontend can highlight every issue.
 */
export function validateRecord(
  fields: Array<{
    id: string
    name: string
    type: string
    config?: { validation?: FieldValidationConfig }
  }>,
  data: Record<string, unknown>,
): ValidationResult {
  const errors: FieldValidationError[] = []

  for (const field of fields) {
    const rules = field.config?.validation
    if (!rules || rules.length === 0) continue

    const value = data[field.id]
    const fieldErrors = validateFieldValue(field.id, field.name, field.type, value, rules)
    errors.push(...fieldErrors)
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Default validation rules for built-in field types
// ---------------------------------------------------------------------------

/**
 * Returns default validation rules for a given field type.
 * These can be overridden by per-field config.
 */
export function getDefaultValidationRules(
  fieldType: string,
  fieldProperty?: Record<string, unknown>,
): FieldValidationConfig {
  switch (fieldType) {
    case 'string':
    case 'longText':
      return [{ type: 'maxLength', params: { value: 10000 } }]
    case 'barcode':
      return [{ type: 'maxLength', params: { value: 256 } }]
    case 'location':
      return []
    case 'dateTime':
      return []
    case 'select':
    case 'multiSelect': {
      const options = fieldProperty?.options
      if (Array.isArray(options)) {
        const values = options.map((opt: unknown) => {
          if (typeof opt === 'string') return opt
          if (opt && typeof opt === 'object' && 'value' in opt) return String((opt as any).value)
          return String(opt)
        })
        return [{ type: 'enum', params: { values } }]
      }
      return []
    }
    default:
      return []
  }
}
