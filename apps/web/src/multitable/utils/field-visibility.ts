// Conditional field-VISIBILITY (form-conditional-fields MVP, 2026-06-14) —
// frontend evaluator. Mirrors the backend `field-visibility-rule.ts` shape and
// REUSES the conditional-formatting `evaluateRule` so the show/hide grammar is
// identical to the cell-styling grammar (one operator vocabulary).
//
// A field's `property.visibilityRule` is a single condition on ANOTHER field's
// value in the SAME record. No rule ⇒ always visible (backward-compatible).
//
// SECURITY: presentation only. A field hidden here is NOT a security boundary —
// the value is still on the wire and masked (or not) by field permissions. This
// is UX, never a substitute for field permissions.

import type {
  ConditionalFormattingOperator,
  MetaField,
} from '../types'
import { evaluateRule, isOperator } from './conditional-formatting'

export interface FieldVisibilityRule {
  fieldId: string
  operator: ConditionalFormattingOperator
  value?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read + lightly validate a field's `property.visibilityRule`. Returns `null`
 * when absent or malformed (⇒ the field is treated as always visible). The
 * backend is canonical; this guards against a hand-built / stale property.
 */
export function getFieldVisibilityRule(field: MetaField): FieldVisibilityRule | null {
  const raw = isPlainObject(field.property) ? field.property.visibilityRule : undefined
  if (!isPlainObject(raw)) return null
  const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId.trim() : ''
  if (!fieldId) return null
  if (!isOperator(raw.operator)) return null
  const rule: FieldVisibilityRule = { fieldId, operator: raw.operator }
  if ('value' in raw) rule.value = raw.value
  return rule
}

export interface VisibilityEvaluateOptions {
  now?: number
}

/**
 * Is `field` visible given the current record data? A field without a
 * visibility rule is always visible. The rule is evaluated by reusing the
 * conditional-formatting evaluator: the *dependency* field (the one named by
 * `rule.fieldId`) is supplied as the `field` arg so type-aware operators
 * (e.g. `eq` over a select) match the same way they do for cell styling.
 *
 * A rule whose dependency field is missing from `fieldsById` resolves to FALSE
 * (hidden) — a dangling reference should not silently force the field visible.
 */
export function isFieldVisible(
  field: MetaField,
  recordData: Record<string, unknown>,
  fieldsById: Record<string, MetaField | undefined>,
  options: VisibilityEvaluateOptions = {},
): boolean {
  const rule = getFieldVisibilityRule(field)
  if (!rule) return true
  const dependency = fieldsById[rule.fieldId]
  if (!dependency) return false
  // Reuse the conditional-formatting evaluator by synthesizing the full rule
  // envelope it expects (id/order/style/enabled are irrelevant to the boolean).
  return evaluateRule(
    { id: '__visibility__', order: 0, fieldId: rule.fieldId, operator: rule.operator, value: rule.value, style: {}, enabled: true },
    recordData,
    dependency,
    options,
  )
}
