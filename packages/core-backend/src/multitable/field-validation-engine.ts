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
import { runUserRegex, describeUserRegexRefusal } from '../formula/regex-safety'

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
 * Outcome of a stored `pattern` rule. `refused` is deliberately NOT the same
 * thing as `matched: false`: round 1 of this slice made a refusal report the
 * ordinary "does not match the required format" message, which left a field
 * administrator unable to tell "the value really is malformed" from "the guard
 * declined to run this check" — byte-identical wording for two different causes.
 */
type PatternRuleOutcome =
  | { kind: 'checked'; matched: boolean }
  | { kind: 'refused'; reason: string }

function evaluatePatternRule(value: unknown, regex: string, flags?: string): PatternRuleOutcome {
  if (typeof value !== 'string') return { kind: 'checked', matched: false }
  // PROPOSED (H-3, round 2): a stored `pattern` rule compiles this caller-authored
  // regex on EVERY record write / public form submission. A nested-quantifier
  // pattern (e.g. "^(a+)+$") was measured blocking the event loop ~20s at a
  // 33-character record value.
  //
  // `runUserRegex` applies (a) a hard subject-length ceiling that does NOT depend
  // on this field's own rule list — the two call sites merge rules as
  // `explicitRules ?? defaultRules`, a REPLACEMENT, so a field that declares any
  // explicit validation loses the built-in `maxLength: 10000` and had no length
  // bound at all; and (b) a bounded timing ladder that refuses only a MEASURED
  // super-quadratic cost curve. Round 1's static shape detector is deleted: it
  // refused six common linear patterns (slug / version / dotted identifier /
  // comma list / e-mail / path segment, each <=0.06ms measured) and still let a
  // 22-second `^(a|a)*$` through. MITIGATION, not a class fix — see
  // docs/development/input-regex-redos-census-*.md.
  const outcome = runUserRegex(regex, flags, value, (re, subject) => re.test(subject))
  if (outcome.status === 'ok') return { kind: 'checked', matched: outcome.value }
  // An invalid regex keeps the pre-existing contract (failed validation, ordinary
  // message); only the capacity refusals get their own wording.
  if (outcome.refusal.kind === 'invalid-pattern') return { kind: 'checked', matched: false }
  return { kind: 'refused', reason: describeUserRegexRefusal(outcome.refusal) }
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
        if (outcome.kind === 'refused') {
          // Deliberately NOT `rule.message`: that string describes a format
          // mismatch, and this is not one.
          errors.push({
            fieldId,
            fieldName,
            rule: rule.type,
            message: `${fieldName}: ${outcome.reason}`,
          })
          continue
        }
        valid = outcome.matched
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
        message: rule.message ?? defaultMessage(rule, fieldName),
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
