import type { MetaField } from '../types'

export function isPersonField(field?: MetaField | null): boolean {
  return field?.type === 'link' && field.property?.refKind === 'user'
}

function linkEntityLabel(field?: MetaField | null, count?: number): string {
  if (isPersonField(field)) {
    return count === 1 ? 'person' : 'people'
  }
  return 'linked records'
}

export function linkActionLabel(field: MetaField | null | undefined, count: number): string {
  if (count > 0) return `Edit ${linkEntityLabel(field, count)} (${count})`
  return `Choose ${linkEntityLabel(field)}...`
}

export function linkPickerTitle(field?: MetaField | null): string {
  const prefix = isPersonField(field) ? 'Select People' : 'Link Records'
  return field?.name ? `${prefix} — ${field.name}` : prefix
}

export function linkPickerSearchPlaceholder(field?: MetaField | null): string {
  return isPersonField(field) ? 'Search people...' : 'Search records...'
}
