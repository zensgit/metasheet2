import type { FormField, FormFieldVisibilityRule, FormSchema } from '../types/approval'

function isEmptyValue(value: unknown): boolean {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0)
}

function evaluateRule(rule: FormFieldVisibilityRule, formData: Record<string, unknown>): boolean {
  const value = formData[rule.fieldId]

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

  const dependency = formSchema.fields.find((entry) => entry.id === field.visibilityRule?.fieldId)
  if (!dependency) {
    cache.set(field.id, false)
    return false
  }

  stack.add(field.id)
  const dependencyVisible = isFieldVisible(dependency, formSchema, formData, cache, stack)
  stack.delete(field.id)

  const visible = dependencyVisible ? evaluateRule(field.visibilityRule, formData) : false
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
  const dependency = formSchema.fields.find((entry) => entry.id === field.visibilityRule?.fieldId)
  const dependencyLabel = dependency?.label || field.visibilityRule.fieldId
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
