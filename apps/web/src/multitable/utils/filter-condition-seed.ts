import type { MetaField } from '../types'
import type { FilterRule } from '../composables/useMultitableGrid'
import { FILTER_OPERATORS_BY_TYPE, effectiveFilterTypeKey } from '../composables/useMultitableGrid'

// Shared seeding for a brand-new filter condition (used by the toolbar "add condition" + the nested-group
// editor's "add condition"/"add group"). Keeps a single source of truth for the default operator + value
// so the flat and nested authoring paths can't drift.

export function filterOperatorsForField(field: MetaField): Array<{ value: string; label: string }> {
  if (field.type === 'multiSelect') return FILTER_OPERATORS_BY_TYPE.multiSelect ?? FILTER_OPERATORS_BY_TYPE.select
  return FILTER_OPERATORS_BY_TYPE[effectiveFilterTypeKey(field)] ?? FILTER_OPERATORS_BY_TYPE.string
}

export function seedFilterValue(field: MetaField): unknown {
  const t = String(field.type)
  if (t === 'select' || t === 'multiSelect') {
    const opts = field.options ?? (Array.isArray(field.property?.options) ? field.property.options : [])
    const first = opts[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object' && 'value' in first) return String((first as { value?: unknown }).value ?? '')
    return ''
  }
  if (t === 'boolean') return true
  return ''
}

export function seedFilterCondition(field: MetaField | undefined): FilterRule {
  if (!field) return { fieldId: '', operator: 'is', value: '' }
  const ops = filterOperatorsForField(field)
  return { fieldId: field.id, operator: ops[0]?.value ?? 'is', value: seedFilterValue(field) }
}
