// Core table chrome string table — single source for MetaToolbar.vue and
// MetaGridTable.vue (T3A1) localization.
//
// EN + ZH both explicit (same convention as workbench-labels.ts; unlike
// category-labels.ts where the data layer is English and we only translate).
// Components read `useLocale().isZh` and call `metaCoreLabel(key, isZh)` for
// static strings, or the interpolation helpers below for strings with
// counts / field names / type-driven variants.
//
// Scope: see docs/development/multitable-t3a-core-table-i18n-development-20260519.md.
// T3A1 = core table chrome only (toolbar + grid). Cell-editor strings are
// T3A2 and are intentionally absent here (no dead keys, per MD §7.6).
//
// NOT translated (user/data values): field names, option values, group
// values, view names, record values, ids, URLs, emails, phone examples,
// backend free-form errors. The only group label localized is the synthetic
// "(No value)" fallback (see groupNoValue / MetaGridTable __ungrouped__).

export type MetaCoreLabelKey =
  // --- MetaToolbar static ---
  | 'toolbar.aria'
  | 'toolbar.fields'
  | 'toolbar.sort'
  | 'toolbar.sortAsc' | 'toolbar.sortDesc'        // F1: sort-direction options
  | 'toolbar.addSort' | 'toolbar.apply'
  | 'toolbar.filter' | 'toolbar.where' | 'toolbar.all' | 'toolbar.any'
  | 'toolbar.conditionsMatch'
  | 'toolbar.filterField' | 'toolbar.filterOperator' | 'toolbar.filterValue'  // F4: filter aria
  | 'toolbar.noValueNeeded' | 'toolbar.chooseOption' | 'toolbar.noOptions'
  | 'toolbar.checkedTrue' | 'toolbar.uncheckedFalse'
  | 'toolbar.addFilter' | 'toolbar.clearAll'
  | 'toolbar.applyFilterChanges' | 'toolbar.applyFilters' | 'toolbar.stagedHint'
  | 'toolbar.group' | 'toolbar.none'
  | 'toolbar.undo' | 'toolbar.undoTitle'          // F3: aria vs shortcut-bearing title
  | 'toolbar.redo' | 'toolbar.redoTitle'
  | 'toolbar.searchPlaceholder' | 'toolbar.searchAria' | 'toolbar.clearSearch'
  | 'toolbar.rowHeight' | 'toolbar.rows'
  | 'toolbar.autoFitColumns' | 'toolbar.fit'
  | 'toolbar.print' | 'toolbar.printGrid'
  | 'toolbar.importRecords' | 'toolbar.import'
  | 'toolbar.exportCsv' | 'toolbar.exportExcel' | 'toolbar.exportExcelXlsx' | 'toolbar.exportXlsx'
  | 'toolbar.newRecord'
  // --- Row density ---
  | 'density.compact' | 'density.normal' | 'density.expanded'
  // --- MetaGridTable static ---
  | 'grid.aria'
  | 'grid.setField' | 'grid.setFieldAria'
  | 'grid.clearField' | 'grid.clearFieldAria'
  | 'grid.deleteSelected' | 'grid.deleteSelectedAria'
  | 'grid.clear' | 'grid.clearSelection'
  | 'grid.noRecordsTitle'
  | 'grid.noRecordsHintPrefix' | 'grid.noRecordsHintAction' | 'grid.noRecordsHintSuffix'
  | 'grid.noMatchingTitle' | 'grid.noMatchingHint'
  | 'grid.collapseRow' | 'grid.expandRow'
  | 'grid.prev' | 'grid.next' | 'grid.loading'

const META_CORE_LABELS: Record<MetaCoreLabelKey, { en: string; zh: string }> = {
  'toolbar.aria': { en: 'Grid toolbar', zh: '表格工具栏' },
  'toolbar.fields': { en: 'Fields', zh: '字段' },
  'toolbar.sort': { en: 'Sort', zh: '排序' },
  // F1 + user-confirmed: en keeps the alphabet arrows, zh uses 升序/降序.
  'toolbar.sortAsc': { en: 'A → Z', zh: '升序' },
  'toolbar.sortDesc': { en: 'Z → A', zh: '降序' },
  'toolbar.addSort': { en: '+ Add sort', zh: '+ 添加排序' },
  'toolbar.apply': { en: 'Apply', zh: '应用' },
  'toolbar.filter': { en: 'Filter', zh: '筛选' },
  'toolbar.where': { en: 'Where', zh: '当' },
  'toolbar.all': { en: 'all', zh: '全部' },
  'toolbar.any': { en: 'any', zh: '任一' },
  'toolbar.conditionsMatch': { en: 'conditions match', zh: '条件匹配' },
  // F4: filter-control aria labels (§3.1 in-scope; absent from §5.1 key table).
  'toolbar.filterField': { en: 'Filter field', zh: '筛选字段' },
  'toolbar.filterOperator': { en: 'Filter operator', zh: '筛选运算符' },
  'toolbar.filterValue': { en: 'Filter value', zh: '筛选值' },
  'toolbar.noValueNeeded': { en: 'no value needed', zh: '无需填写值' },
  'toolbar.chooseOption': { en: 'Choose option...', zh: '选择选项...' },
  'toolbar.noOptions': { en: 'No options', zh: '无可用选项' },
  'toolbar.checkedTrue': { en: 'checked / true', zh: '已勾选 / true' },
  'toolbar.uncheckedFalse': { en: 'unchecked / false', zh: '未勾选 / false' },
  'toolbar.addFilter': { en: '+ Add filter', zh: '+ 添加筛选' },
  'toolbar.clearAll': { en: 'Clear all', zh: '全部清除' },
  'toolbar.applyFilterChanges': { en: 'Apply filter changes', zh: '应用筛选更改' },
  'toolbar.applyFilters': { en: 'Apply filters', zh: '应用筛选' },
  'toolbar.stagedHint': {
    en: 'Filter changes are staged until applied.',
    zh: '筛选更改将在应用后生效。',
  },
  'toolbar.group': { en: 'Group', zh: '分组' },
  'toolbar.none': { en: 'None', zh: '无' },
  'toolbar.undo': { en: 'Undo', zh: '撤销' },
  // F3: keep the physical-key shortcut literal (workbench-labels.ts kbd.* convention).
  'toolbar.undoTitle': { en: 'Undo (Ctrl+Z)', zh: '撤销 (Ctrl+Z)' },
  'toolbar.redo': { en: 'Redo', zh: '重做' },
  'toolbar.redoTitle': { en: 'Redo (Ctrl+Y)', zh: '重做 (Ctrl+Y)' },
  'toolbar.searchPlaceholder': { en: 'Search records...', zh: '搜索记录...' },
  'toolbar.searchAria': { en: 'Search records', zh: '搜索记录' },
  'toolbar.clearSearch': { en: 'Clear search', zh: '清除搜索' },
  'toolbar.rowHeight': { en: 'Row height', zh: '行高' },
  // user-confirmed: button text en stays "Rows"; zh uses 行高 (单字 "行" 歧义).
  'toolbar.rows': { en: 'Rows', zh: '行高' },
  'toolbar.autoFitColumns': { en: 'Auto-fit columns', zh: '自动适应列宽' },
  'toolbar.fit': { en: 'Fit', zh: '适应' },
  'toolbar.print': { en: 'Print', zh: '打印' },
  'toolbar.printGrid': { en: 'Print grid', zh: '打印表格' },
  'toolbar.importRecords': { en: 'Import records', zh: '导入记录' },
  'toolbar.import': { en: 'Import', zh: '导入' },
  'toolbar.exportCsv': { en: 'Export CSV', zh: '导出 CSV' },
  'toolbar.exportExcel': { en: 'Export Excel', zh: '导出 Excel' },
  'toolbar.exportExcelXlsx': { en: 'Export Excel (.xlsx)', zh: '导出 Excel (.xlsx)' },
  'toolbar.exportXlsx': { en: 'Export XLSX', zh: '导出 XLSX' },
  'toolbar.newRecord': { en: '+ New Record', zh: '+ 新建记录' },

  'density.compact': { en: 'Compact', zh: '紧凑' },
  'density.normal': { en: 'Normal', zh: '标准' },
  'density.expanded': { en: 'Expanded', zh: '宽松' },

  'grid.aria': { en: 'Data grid', zh: '数据表格' },
  'grid.setField': { en: 'Set field', zh: '设置字段' },
  'grid.setFieldAria': { en: 'Set field on selected records', zh: '为所选记录设置字段' },
  'grid.clearField': { en: 'Clear field', zh: '清空字段' },
  'grid.clearFieldAria': { en: 'Clear field on selected records', zh: '清空所选记录的字段' },
  'grid.deleteSelected': { en: 'Delete selected', zh: '删除所选' },
  'grid.deleteSelectedAria': { en: 'Delete selected records', zh: '删除所选记录' },
  'grid.clear': { en: 'Clear', zh: '清除' },
  'grid.clearSelection': { en: 'Clear selection', zh: '清除选择' },
  'grid.noRecordsTitle': { en: 'No records yet', zh: '暂无记录' },
  // Empty hint is split so the inline <strong>+ New Record</strong> emphasis
  // is preserved while the surrounding sentence is localized (MD §5.5 note).
  'grid.noRecordsHintPrefix': { en: 'Click', zh: '点击' },
  'grid.noRecordsHintAction': { en: '+ New Record', zh: '+ 新建记录' },
  'grid.noRecordsHintSuffix': { en: 'to add your first row', zh: '添加第一行' },
  'grid.noMatchingTitle': { en: 'No matching records', zh: '没有匹配的记录' },
  'grid.noMatchingHint': { en: 'Try a different search term', zh: '试试其他搜索词' },
  'grid.collapseRow': { en: 'Collapse row', zh: '收起行' },
  'grid.expandRow': { en: 'Expand row', zh: '展开行' },
  'grid.prev': { en: 'Prev', zh: '上一页' },
  'grid.next': { en: 'Next', zh: '下一页' },
  'grid.loading': { en: 'Loading data', zh: '正在加载数据' },
}

export function metaCoreLabel(key: MetaCoreLabelKey, isZh: boolean): string {
  const entry = META_CORE_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation helpers (not keys) ---

// rowCount: toolbar row-count badge. Source was English-only `{n} rows`
// (no singular). en is fixed to be plural-correct; zh has no plural.
export function rowCount(n: number, isZh: boolean): string {
  if (isZh) return `${n} 行`
  return `${n} row${n === 1 ? '' : 's'}`
}

// selectedCount: bulk-bar count. en "selected" does not inflect; zh uses 条.
export function selectedCount(n: number, isZh: boolean): string {
  return isZh ? `已选择 ${n} 条` : `${n} selected`
}

// commentForRow: row-comment aria label. Row number is UI-generated (1-based).
export function commentForRow(rowNumber: number, isZh: boolean): string {
  return isZh ? `第 ${rowNumber} 行评论` : `Comments for row ${rowNumber}`
}

// commentForField: field-comment aria label. The field name is user data and
// is interpolated raw — never translated.
export function commentForField(fieldName: string, isZh: boolean): string {
  return isZh ? `${fieldName} 的评论` : `Comments for ${fieldName}`
}

// groupNoValue: the synthetic "(No value)" group label only. Real group
// values are user data and must remain exactly as stored.
export function groupNoValue(isZh: boolean): string {
  return isZh ? '(无值)' : '(No value)'
}

// fieldTypeLabel: stable field-type display labels. F2 — used by BOTH the
// filter panel and the group panel so the two stay consistent (before T3A1
// the group panel showed the raw `f.type`; reusing this helper there also
// normalizes its English, e.g. `longText` → `long text`). Unknown/custom
// types fall back to the raw type string unchanged, in both locales.
const FIELD_TYPE_LABELS: Record<string, { en: string; zh: string }> = {
  string: { en: 'text', zh: '文本' },
  longText: { en: 'long text', zh: '长文本' },
  number: { en: 'number', zh: '数字' },
  boolean: { en: 'checkbox', zh: '复选框' },
  select: { en: 'select', zh: '单选' },
  multiSelect: { en: 'multi-select', zh: '多选' },
  date: { en: 'date', zh: '日期' },
}
export function fieldTypeLabel(type: string, isZh: boolean): string {
  const entry = FIELD_TYPE_LABELS[type]
  if (!entry) return type
  return isZh ? entry.zh : entry.en
}

// filterValuePlaceholder: stable frontend placeholders for the filter value
// input, keyed by field type.
export function filterValuePlaceholder(type: string, isZh: boolean): string {
  if (type === 'number') return isZh ? '输入数字' : 'Enter a number'
  if (type === 'date') return isZh ? '选择日期' : 'Pick a date'
  return isZh ? '输入筛选文本' : 'Enter filter text'
}
