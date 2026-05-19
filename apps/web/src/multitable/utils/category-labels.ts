// Multitable template category translation map.
//
// Data layer keeps English category strings (Sales / Project management / etc.)
// so existing template-library.ts and any test assertions on category names
// stay stable. UI displays Chinese labels via this lookup; un-mapped categories
// fall through to the original string (safe default, never fails).

const CATEGORY_LABELS_ZH: Record<string, string> = {
  'Project management': '项目管理',
  Sales: 'CRM',
  Engineering: '工程',
  Contract: '合同管理',
  Inspection: '巡检',
  Recruitment: '招聘',
  Operations: '运营',
  General: '通用',
}

export function categoryLabel(category: string, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (locale !== 'zh-CN') return category
  return CATEGORY_LABELS_ZH[category] ?? category
}

export function listCategoryLabels(categories: string[], locale: 'zh-CN' | 'en' = 'zh-CN'): Array<{ value: string; label: string }> {
  return categories.map((value) => ({ value, label: categoryLabel(value, locale) }))
}
