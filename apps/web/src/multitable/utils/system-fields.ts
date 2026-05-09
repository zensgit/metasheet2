import type { MetaField, MetaFieldCreateType, MetaFieldType } from '../types'

export const SYSTEM_FIELD_TYPES = [
  'autoNumber',
  'createdTime',
  'modifiedTime',
  'createdBy',
  'modifiedBy',
] as const satisfies readonly MetaFieldType[]

export type SystemFieldType = typeof SYSTEM_FIELD_TYPES[number]

const SYSTEM_FIELD_TYPE_SET = new Set<string>(SYSTEM_FIELD_TYPES)

export function isSystemFieldType(type: string | null | undefined): type is SystemFieldType {
  return typeof type === 'string' && SYSTEM_FIELD_TYPE_SET.has(type)
}

export function isSystemField(field: Pick<MetaField, 'type'> | null | undefined): boolean {
  return isSystemFieldType(field?.type)
}

export function isSystemFieldCreateType(type: MetaFieldCreateType | string | null | undefined): type is SystemFieldType {
  return isSystemFieldType(type)
}

export function systemFieldHint(type: MetaFieldCreateType | string | null | undefined): string {
  switch (type) {
    case 'createdTime':
      return 'Created time is generated from the record creation timestamp and is read-only.'
    case 'autoNumber':
      return 'Auto number is generated when a record is created and is read-only.'
    case 'modifiedTime':
      return 'Modified time is generated from the last record update timestamp and is read-only.'
    case 'createdBy':
      return 'Created by is generated from the record creator and is read-only.'
    case 'modifiedBy':
      return 'Modified by is generated from the last modifying actor and is read-only.'
    default:
      return 'System fields are generated from record metadata and are read-only.'
  }
}
