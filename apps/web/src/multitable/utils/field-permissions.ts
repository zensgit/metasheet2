import type { MetaField } from '../types'

export function isPropertyHiddenField(field: Pick<MetaField, 'property'>): boolean {
  return field.property?.hidden === true || field.property?.visible === false
}

export function filterPropertyVisibleFields<T extends Pick<MetaField, 'property'>>(fields: T[]): T[] {
  return fields.filter((field) => !isPropertyHiddenField(field))
}
