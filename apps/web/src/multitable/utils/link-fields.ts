import type { MetaField } from '../types'

// isLinkField — TRUE for a relational link field. NOTE (design 2026-06-16): a NATIVE person
// (`type === 'person'`, value = userId[]) is NO LONGER a link — it has its own picker / import
// resolver / personSummaries display source. A LEGACY person field is stored as `type === 'link'`
// + refKind:'user', so it still matches here (and keeps its link-backed recordId behaviour). This
// decoupling is load-bearing for coexistence: native person must not route through link summaries.
export function isLinkField(field?: MetaField | null): boolean {
  return field?.type === 'link'
}

// isNativePersonField — TRUE only for the native userId[]-backed person (`type === 'person'`).
export function isNativePersonField(field?: MetaField | null): boolean {
  return field?.type === 'person'
}

// isPersonField — TRUE for EITHER representation (coexistence): the native `type === 'person'`
// OR a legacy link-backed person (`type === 'link'` + refKind:'user'). Every person-aware copy /
// chip / picker gate uses this so both kinds render as people.
export function isPersonField(field?: MetaField | null): boolean {
  return isNativePersonField(field) || (isLinkField(field) && field?.property?.refKind === 'user')
}

function linkEntityLabel(field?: MetaField | null, count?: number): string {
  if (isPersonField(field)) return count === 1 ? 'person' : 'people'
  return count === 1 ? 'linked record' : 'linked records'
}

// linkActionLabel: button copy for the link-field action button.
//
// `isZh` is an opt-in third argument (default false): when callers from the
// T3B1 record drawer / form view pass `useLocale().isZh.value`, the helper
// returns the zh form; otherwise existing callers (MetaCellEditor T3A2
// dead-key branch, MetaImportModal) keep their current English output
// unchanged.
//
// Chinese has no singular/plural distinction for the entity noun, so both
// `count === 1` and `count > 1` collapse to the same zh entity word
// (`人员` / `关联记录`); only the EN branch carries the singular/plural fork.
//
// User-confirmed zh choices (T3B1 design MD §6, 2026-05-19): 选择人员... /
// 编辑人员 (n) / 选择关联记录... / 编辑关联记录 (n).
export function linkActionLabel(
  field: MetaField | null | undefined,
  count: number,
  isZh: boolean = false,
): string {
  if (count > 0) {
    if (isZh) {
      const entityZh = isPersonField(field) ? '人员' : '关联记录'
      return `编辑${entityZh} (${count})`
    }
    return `Edit ${linkEntityLabel(field, count)} (${count})`
  }
  if (isZh) {
    const entityZh = isPersonField(field) ? '人员' : '关联记录'
    return `选择${entityZh}...`
  }
  return `Choose ${linkEntityLabel(field)}...`
}

export function linkPickerTitle(field?: MetaField | null, isZh: boolean = false): string {
  const prefix = isPersonField(field)
    ? (isZh ? '选择人员' : 'Select People')
    : (isZh ? '选择关联记录' : 'Link Records')
  return field?.name ? `${prefix} — ${field.name}` : prefix
}

export function linkPickerSearchPlaceholder(field?: MetaField | null, isZh: boolean = false): string {
  if (isPersonField(field)) return isZh ? '搜索人员...' : 'Search people...'
  return isZh ? '搜索记录...' : 'Search records...'
}
