/**
 * Field Validation Rule Types
 *
 * Defines the validation rule contracts for multitable fields.
 * Rules are stored per-field in field.property.validation (FieldValidationConfig).
 */

import { MultitableRecordValidationError } from './record-errors'

function rejectNulJsonEntry(key: string, value: unknown): unknown {
  if (key.includes('\u0000') || (typeof value === 'string' && value.includes('\u0000'))) {
    throw new MultitableRecordValidationError('Record JSON keys and string values must not contain NUL')
  }
  return value
}

export function assertNoNulInRecordValue(value: unknown): void {
  JSON.stringify(value, rejectNulJsonEntry)
}

export function serializeRecordData(data: Record<string, unknown>): string {
  return JSON.stringify(data, rejectNulJsonEntry)
}

// --- Rule types ---

export interface FieldValidationRule {
  type: 'required' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'enum' | 'custom'
  message?: string
  params?: Record<string, unknown>
}

export interface RequiredRule extends FieldValidationRule {
  type: 'required'
}

export interface RangeRule extends FieldValidationRule {
  type: 'min' | 'max'
  params: { value: number }
}

export interface LengthRule extends FieldValidationRule {
  type: 'minLength' | 'maxLength'
  params: { value: number }
}

export interface PatternRule extends FieldValidationRule {
  type: 'pattern'
  params: { regex: string; flags?: string }
}

export interface EnumRule extends FieldValidationRule {
  type: 'enum'
  params: { values: string[] }
}

// --- Validation result ---

export interface FieldValidationError {
  fieldId: string
  fieldName?: string
  rule: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: FieldValidationError[]
}

// --- Config stored per-field ---

export type FieldValidationConfig = FieldValidationRule[]
