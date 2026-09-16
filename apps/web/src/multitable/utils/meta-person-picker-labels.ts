// Native person (人员, design 2026-06-16) picker modal chrome string table.
//
// Scope: MetaPersonPicker.vue static UI only. Member names/emails are user data and pass
// through unchanged. This is the SOLE i18n extension point for the person picker — add new
// keys to the union AND the record together (no dead keys, no inline UI strings).

export type MetaPersonPickerLabelKey =
  | 'personPicker.title'
  | 'personPicker.searchPlaceholder'
  | 'personPicker.selected'
  | 'personPicker.clear'
  | 'personPicker.loading'
  | 'personPicker.empty'
  // #5781: the directory endpoint is search-required (it answers `requiresQuery` with an empty list
  // instead of the deployment roster) and capped — these two states need their own chrome strings so
  // "type to search" never renders as "no members found" / a silently short list.
  | 'personPicker.typeToSearch'
  | 'personPicker.refineSearch'
  | 'personPicker.cancel'
  | 'personPicker.confirm'
  | 'personPicker.close'
  | 'personPicker.errorLoad'

const META_PERSON_PICKER_LABELS: Record<MetaPersonPickerLabelKey, { en: string; zh: string }> = {
  'personPicker.title': { en: 'Select People', zh: '选择人员' },
  'personPicker.searchPlaceholder': { en: 'Search people...', zh: '搜索人员...' },
  'personPicker.selected': { en: 'Selected', zh: '已选择' },
  'personPicker.clear': { en: 'Clear', zh: '清除' },
  'personPicker.loading': { en: 'Loading...', zh: '正在加载...' },
  'personPicker.empty': { en: 'No members found', zh: '未找到成员' },
  'personPicker.typeToSearch': { en: 'Type a name or email to search', zh: '输入姓名或邮箱以搜索' },
  'personPicker.refineSearch': { en: 'Showing the first matches only — narrow your search', zh: '仅显示前若干条匹配结果,请细化搜索' },
  'personPicker.cancel': { en: 'Cancel', zh: '取消' },
  'personPicker.confirm': { en: 'Confirm', zh: '确认' },
  'personPicker.close': { en: 'Close people picker', zh: '关闭人员选择器' },
  'personPicker.errorLoad': { en: 'Failed to load members', zh: '加载成员失败' },
}

export function personPickerLabel(key: MetaPersonPickerLabelKey, isZh: boolean): string {
  const entry = META_PERSON_PICKER_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function personPickerSelectedCount(count: number, isZh: boolean): string {
  return isZh ? `已选择 ${count} 人` : `${count} selected`
}

// Picker title includes the field name when present (field name = user data).
export function personPickerTitle(fieldName: string | undefined, isZh: boolean): string {
  const prefix = personPickerLabel('personPicker.title', isZh)
  return fieldName ? `${prefix} — ${fieldName}` : prefix
}
