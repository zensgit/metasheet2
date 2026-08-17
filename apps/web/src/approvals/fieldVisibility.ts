import type { FormField, FormFieldVisibilityRule, FormSchema } from '../types/approval'

// Exported (UX B2-15) so `detailField.ts`'s `validateDetailRows` can reuse the exact same
// empty-value semantics as visibility's `isEmpty`/`notEmpty` operators instead of redefining a
// third copy alongside `formRules`' own inline version in `ApprovalNewView.vue`.
export function isEmptyValue(value: unknown): boolean {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0)
}

/**
 * Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-5(a)) — FE mirror of the
 * backend resolver (`ApprovalGraphExecutor.ts` `resolveVisibilityFieldReference`; duplicated here
 * because the web app does not import backend sources, mirroring `prefillFromSnapshot.ts`'s own
 * precedent). A visibility rule's `fieldId` may reference a field's whole value directly, OR — for
 * a `date_range` field ONLY — one endpoint via the dotted address `${fieldId}.start` /
 * `${fieldId}.end`. A bare reference to a date_range field's own id is refused (never as one
 * comparable value); `null` on any unresolvable input.
 */
export interface VisibilityFieldReference {
  field: FormField
  endpoint?: 'start' | 'end'
}

export function resolveVisibilityFieldReference(
  rawFieldId: string,
  fields: readonly FormField[],
): VisibilityFieldReference | null {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  const direct = fieldMap.get(rawFieldId)
  if (direct) {
    return direct.type === 'date_range' ? null : { field: direct }
  }
  const dot = rawFieldId.lastIndexOf('.')
  if (dot <= 0 || dot === rawFieldId.length - 1) return null
  const suffix = rawFieldId.slice(dot + 1)
  if (suffix !== 'start' && suffix !== 'end') return null
  const base = fieldMap.get(rawFieldId.slice(0, dot))
  if (!base || base.type !== 'date_range') return null
  return { field: base, endpoint: suffix }
}

/** Read the value a resolved visibility reference points at (whole field, or one date_range endpoint). */
export function readVisibilityReferenceValue(
  reference: VisibilityFieldReference,
  formData: Record<string, unknown>,
): unknown {
  const raw = formData[reference.field.id]
  if (!reference.endpoint) return raw
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[reference.endpoint]
    : undefined
}

function evaluateRule(
  rule: FormFieldVisibilityRule,
  formData: Record<string, unknown>,
  fields: readonly FormField[],
): boolean {
  const reference = resolveVisibilityFieldReference(rule.fieldId, fields)
  const value = reference ? readVisibilityReferenceValue(reference, formData) : undefined

  switch (rule.operator) {
    case 'eq':
      return value === rule.value
    case 'neq':
      return value !== rule.value
    case 'in':
      return Array.isArray(rule.values)
        ? (Array.isArray(value)
          ? value.some((entry) => rule.values!.includes(entry))
          : rule.values.includes(value))
        : false
    case 'isEmpty':
      return isEmptyValue(value)
    case 'notEmpty':
      return !isEmptyValue(value)
    default:
      return false
  }
}

export function isFieldVisible(
  field: FormField,
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  cache: Map<string, boolean> = new Map(),
  stack: Set<string> = new Set(),
): boolean {
  if (cache.has(field.id)) {
    return cache.get(field.id) as boolean
  }

  if (!field.visibilityRule) {
    cache.set(field.id, true)
    return true
  }

  if (stack.has(field.id)) {
    cache.set(field.id, false)
    return false
  }

  // OD-L8-5(a): a dotted `${id}.start`/`${id}.end` endpoint address resolves to the date_range
  // field itself for "is the dependency visible" purposes — there is no separate endpoint field.
  const reference = resolveVisibilityFieldReference(field.visibilityRule.fieldId, formSchema.fields)
  if (!reference) {
    cache.set(field.id, false)
    return false
  }
  const dependency = reference.field

  stack.add(field.id)
  const dependencyVisible = isFieldVisible(dependency, formSchema, formData, cache, stack)
  stack.delete(field.id)

  const visible = dependencyVisible ? evaluateRule(field.visibilityRule, formData, formSchema.fields) : false
  cache.set(field.id, visible)
  return visible
}

export function getVisibleFormFields(formSchema: FormSchema, formData: Record<string, unknown>): FormField[] {
  const cache = new Map<string, boolean>()
  return formSchema.fields.filter((field) => isFieldVisible(field, formSchema, formData, cache))
}

export function pruneHiddenFormData(formSchema: FormSchema, formData: Record<string, unknown>): Record<string, unknown> {
  const visibleFieldIds = new Set(getVisibleFormFields(formSchema, formData).map((field) => field.id))
  return Object.fromEntries(
    Object.entries(formData).filter(([fieldId]) => visibleFieldIds.has(fieldId)),
  )
}

export function describeFieldVisibilityRule(
  field: FormField,
  formSchema: FormSchema,
): string | null {
  if (!field.visibilityRule) return null
  // OD-L8-5(a): a dotted endpoint address labels as "<字段名>(起始/结束)" rather than leaking the
  // raw `${id}.start` internal address into ordinary-user copy (M8 honesty).
  const reference = resolveVisibilityFieldReference(field.visibilityRule.fieldId, formSchema.fields)
  const dependencyLabel = reference
    ? `${reference.field.label || reference.field.id}${
        reference.endpoint === 'start' ? '(起始)' : reference.endpoint === 'end' ? '(结束)' : ''
      }`
    : field.visibilityRule.fieldId
  const rule = field.visibilityRule

  switch (rule.operator) {
    case 'eq':
      return `当 ${dependencyLabel} 等于 ${formatVisibilityValue(rule.value)} 时显示`
    case 'neq':
      return `当 ${dependencyLabel} 不等于 ${formatVisibilityValue(rule.value)} 时显示`
    case 'in':
      return `当 ${dependencyLabel} 属于 ${formatVisibilityValues(rule.values)} 时显示`
    case 'isEmpty':
      return `当 ${dependencyLabel} 为空时显示`
    case 'notEmpty':
      return `当 ${dependencyLabel} 不为空时显示`
    default:
      return null
  }
}

function formatVisibilityValue(value: unknown): string {
  if (value === null || value === undefined) return '空值'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function formatVisibilityValues(values: unknown[] | undefined): string {
  if (!values || values.length === 0) return '[]'
  return values.map((value) => formatVisibilityValue(value)).join(', ')
}
