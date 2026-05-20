// Link picker modal chrome string table (T3B3).
//
// Scope: MetaLinkPicker.vue static UI only. Field names and linked-record
// display values are user data and pass through unchanged.

export type MetaLinkPickerLabelKey =
  | 'linkPicker.selected'
  | 'linkPicker.clear'
  | 'linkPicker.loading'
  | 'linkPicker.empty'
  | 'linkPicker.loadMore'
  | 'linkPicker.cancel'
  | 'linkPicker.confirm'
  | 'linkPicker.close'
  | 'linkPicker.errorLoad'

const META_LINK_PICKER_LABELS: Record<MetaLinkPickerLabelKey, { en: string; zh: string }> = {
  'linkPicker.selected': { en: 'Selected', zh: '已选择' },
  'linkPicker.clear': { en: 'Clear', zh: '清除' },
  'linkPicker.loading': { en: 'Loading...', zh: '正在加载...' },
  'linkPicker.empty': { en: 'No records found', zh: '未找到记录' },
  'linkPicker.loadMore': { en: 'Load more', zh: '加载更多' },
  'linkPicker.cancel': { en: 'Cancel', zh: '取消' },
  'linkPicker.confirm': { en: 'Confirm', zh: '确认' },
  'linkPicker.close': { en: 'Close link picker', zh: '关闭关联记录选择器' },
  'linkPicker.errorLoad': { en: 'Failed to load records', zh: '加载记录失败' },
}

export function linkPickerLabel(key: MetaLinkPickerLabelKey, isZh: boolean): string {
  const entry = META_LINK_PICKER_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function selectedCount(count: number, isZh: boolean): string {
  return isZh ? `已选择 ${count} 条` : `${count} selected`
}
