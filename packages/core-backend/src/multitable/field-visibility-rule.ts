// Conditional field-VISIBILITY rule (form-conditional-fields MVP, 2026-06-14).
//
// A field may carry an optional `visibilityRule` on its `property` JSON: a
// condition on ANOTHER field's value in the SAME record. When set, presentation
// surfaces (the form view) show/hide the field dynamically as the record is
// filled. No rule = always visible (backward-compatible).
//
// The rule REUSES the conditional-formatting operator vocabulary
// (`ConditionalFormattingOperator` in `conditional-formatting-service.ts`) so
// authors learn one condition grammar. A visibility rule is a *single* condition
// (`{ fieldId, operator, value }`) — it deliberately drops the formatting rule's
// `id` / `order` / `style` / `enabled` decoration (those are list/styling
// concerns, not relevant to a per-field show/hide gate).
//
// SECURITY: visibility is PRESENTATION ONLY. A field hidden by a rule is NOT a
// security boundary — the value still travels on the wire and is masked (or not)
// by the normal field-permission layer. Never use `visibilityRule` as a
// substitute for field permissions.
//
// This module is the SINGLE normalizer shared by BOTH `sanitizeFieldProperty`
// implementations (`field-codecs.ts` read-serialize path + `univer-meta.ts`
// write path) so the field-property wire stays drift-free (the same discipline
// the `foreignBaseId` / mirror-link keys follow).

import {
  type ConditionalFormattingOperator,
  sanitizeConditionalFormattingRule,
} from './conditional-formatting-service'

export type FieldVisibilityRule = {
  fieldId: string
  operator: ConditionalFormattingOperator
  value?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize an untrusted `visibilityRule` candidate into a canonical shape, or
 * `null` when it is absent / malformed. Operator + value validity (including the
 * operator-specific value requirements, e.g. `between` needs a 2-tuple, the
 * `is_*` operators take no value) is delegated to the conditional-formatting
 * rule sanitizer so the two surfaces can never diverge on what a given operator
 * accepts. A synthetic `id`/`order`/`style`/`enabled` envelope is supplied to
 * reuse that validator, then stripped from the result.
 */
export function sanitizeFieldVisibilityRule(input: unknown): FieldVisibilityRule | null {
  if (!isPlainObject(input)) return null
  const fieldId = typeof input.fieldId === 'string' ? input.fieldId.trim() : ''
  if (!fieldId) return null

  const probe = sanitizeConditionalFormattingRule({
    id: '__visibility__',
    order: 0,
    fieldId,
    operator: input.operator,
    value: input.value,
    style: {},
    enabled: true,
  })
  if (!probe) return null

  const rule: FieldVisibilityRule = { fieldId: probe.fieldId, operator: probe.operator }
  if (probe.value !== undefined) rule.value = probe.value
  return rule
}

/**
 * Merge a sanitized `visibilityRule` into a per-type-sanitized property object.
 * Absent/invalid rule ⇒ the key is omitted (so a field without a rule round-trips
 * as `{ ...property }` with no `visibilityRule` noise). Centralizing the merge
 * means every field type gets the key contractually, not via incidental `...obj`
 * passthrough.
 */
export function withFieldVisibilityRule(
  sanitizedByType: Record<string, unknown>,
  rawProperty: unknown,
): Record<string, unknown> {
  const candidate = isPlainObject(rawProperty) ? rawProperty.visibilityRule : undefined
  const rule = sanitizeFieldVisibilityRule(candidate)
  if (!rule) {
    if ('visibilityRule' in sanitizedByType) {
      const { visibilityRule: _omit, ...rest } = sanitizedByType
      return rest
    }
    return sanitizedByType
  }
  return { ...sanitizedByType, visibilityRule: rule }
}

/**
 * Conditional-REQUIRED rule (`property.requiredWhen`). A field carrying this rule
 * is required in the public form ONLY when the condition holds against the
 * record being filled — the "required-IF" counterpart to `visibilityRule`'s
 * "show-IF". It REUSES the exact `FieldVisibilityRule` shape (same single
 * `{ fieldId, operator, value }` condition + the same conditional-formatting
 * operator vocabulary), so `sanitizeFieldVisibilityRule` is the shared
 * normalizer — there is deliberately no second condition grammar.
 *
 * Absent/invalid rule ⇒ the key is omitted, so a field without a rule behaves
 * exactly as today (static `required` only; backward-compatible). Like
 * `withFieldVisibilityRule`, this is the single cross-cutting merge applied at
 * BOTH `sanitizeFieldProperty` chokepoints (read-serialize + write) so a
 * malformed rule can never leak through a type branch's `...obj` passthrough.
 *
 * NOTE: persistence only. Like static `field.required`, `requiredWhen` is
 * ENFORCED client-side (in the form view's submit validation, visibility-aware);
 * `validateRecord` keys off `property.validation[]`, not these top-level gates.
 * Sanitizing here keeps the authored rule durable on the field property without
 * adding a new server gate that would reject submits existing forms accept.
 */
export function withFieldRequiredWhenRule(
  sanitizedByType: Record<string, unknown>,
  rawProperty: unknown,
): Record<string, unknown> {
  const candidate = isPlainObject(rawProperty) ? rawProperty.requiredWhen : undefined
  const rule = sanitizeFieldVisibilityRule(candidate)
  if (!rule) {
    if ('requiredWhen' in sanitizedByType) {
      const { requiredWhen: _omit, ...rest } = sanitizedByType
      return rest
    }
    return sanitizedByType
  }
  return { ...sanitizedByType, requiredWhen: rule }
}
