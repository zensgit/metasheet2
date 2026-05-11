import type { MetaField } from '../types'
import { isSystemField } from './system-fields'

export function isPropertyHiddenField(field: Pick<MetaField, 'property'>): boolean {
  return field.property?.hidden === true || field.property?.visible === false
}

export function filterPropertyVisibleFields<T extends Pick<MetaField, 'property'>>(fields: T[]): T[] {
  return fields.filter((field) => !isPropertyHiddenField(field))
}

const NON_BULK_EDITABLE_TYPES = new Set<string>([
  'formula',
  'lookup',
  'rollup',
  'attachment',
  'link',
])

export function isFieldBulkEditable(args: {
  field: MetaField
  canEdit: boolean
  fieldPermission?: { readOnly?: boolean }
}): boolean {
  if (!args.canEdit) return false
  if (args.fieldPermission?.readOnly === true) return false
  if (isSystemField(args.field)) return false
  const property = args.field.property as Record<string, unknown> | undefined
  if (property?.readonly === true || property?.readOnly === true) return false
  if (NON_BULK_EDITABLE_TYPES.has(args.field.type)) return false
  if (isPropertyHiddenField(args.field)) return false
  return true
}
