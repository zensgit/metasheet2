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
