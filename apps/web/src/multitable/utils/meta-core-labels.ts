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
  // --- Shared presence chrome (T3E-1) ---
  | 'presence.collaboratingNow'
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
  // --- Export options dialog (A2: column/row selection) ---
  | 'export.title' | 'export.close' | 'export.columns' | 'export.selectAll' | 'export.clearAll'
  | 'export.rowScope' | 'export.allRows' | 'export.selectedRows'
  | 'export.format' | 'export.formatCsv' | 'export.formatXlsx'
  | 'export.noColumns' | 'export.cancel' | 'export.confirm' | 'export.openAria'
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
  | 'grid.addRecordInline'
  | 'grid.freezeUpToColumn' | 'grid.unfreezeColumns'
  | 'grid.aggregateTooLarge'
  | 'grid.noMatchingTitle' | 'grid.noMatchingHint'
  | 'grid.collapseRow' | 'grid.expandRow'
  // --- Record locking (design #2278 follow-up) ---
  | 'grid.lockRow' | 'grid.unlockRow' | 'grid.lockedIndicator'
  | 'grid.errorLockRow' | 'grid.errorUnlockRow'
  | 'grid.prev' | 'grid.next' | 'grid.loading'
  | 'grid.errorLoadViewData'
  | 'grid.errorEditRowBlocked' | 'grid.errorDeleteRowBlocked'
  | 'grid.errorContextRequired'
  | 'grid.errorCreateRecord' | 'grid.errorDeleteRecord'
  | 'grid.errorCellUpdatedElsewhere' | 'grid.errorPatchCell'
  | 'grid.errorRecordVersionUnavailable' | 'grid.errorPatchFailed'
  // --- MetaCellEditor static (T3A2) ---
  | 'cell.editing'
  | 'cell.barcodePlaceholder' | 'cell.qrcodePlaceholder' | 'cell.locationPlaceholder'
  | 'cell.yes' | 'cell.no' | 'cell.clear'
  | 'cell.noAttachments' | 'cell.clearAll'
  | 'cell.uploadFailed' | 'cell.removeFailed' | 'cell.clearFailed'
  // --- MetaCellEditor AI shortcut run button (A3-T6) ---
  | 'cell.aiRun' | 'cell.aiRunning'
  // --- Linked-record popover (A3): clickable link chip → foreign record peek ---
  | 'linkedRecord.title'
  | 'linkedRecord.loading'
  | 'linkedRecord.error'
  | 'linkedRecord.close'
  | 'linkedRecord.empty'
  // --- Rich-longText in-cell @mention (B5) ---
  | 'mention.suggestionsAria'
  // --- Auth chrome (file-location closure tightening per #1803) ---
  | 'auth.notAuthenticated'

const META_CORE_LABELS: Record<MetaCoreLabelKey, { en: string; zh: string }> = {
  'presence.collaboratingNow': { en: 'Collaborating now', zh: '正在协作' },

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
  'export.title': { en: 'Export options', zh: '导出选项' },
  'export.close': { en: 'Close', zh: '关闭' },
  'export.columns': { en: 'Columns', zh: '列' },
  'export.selectAll': { en: 'Select all', zh: '全选' },
  'export.clearAll': { en: 'Clear all', zh: '清空' },
  'export.rowScope': { en: 'Rows', zh: '行' },
  'export.allRows': { en: 'All loaded rows', zh: '全部已加载行' },
  'export.selectedRows': { en: 'Selected rows only', zh: '仅选中行' },
  'export.format': { en: 'Format', zh: '格式' },
  'export.formatCsv': { en: 'CSV', zh: 'CSV' },
  'export.formatXlsx': { en: 'Excel (.xlsx)', zh: 'Excel (.xlsx)' },
  'export.noColumns': { en: 'Select at least one column to export.', zh: '请至少选择一列导出。' },
  'export.cancel': { en: 'Cancel', zh: '取消' },
  'export.confirm': { en: 'Export', zh: '导出' },
  'export.openAria': { en: 'Export options', zh: '导出选项' },
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
  'grid.addRecordInline': { en: 'New record', zh: '新建记录' },
  'grid.freezeUpToColumn': { en: 'Freeze up to this column', zh: '冻结到此列' },
  'grid.aggregateTooLarge': { en: 'Too many rows to aggregate', zh: '数据量过大，无法聚合' },
  'grid.unfreezeColumns': { en: 'Unfreeze columns', zh: '取消冻结' },
  'grid.noMatchingTitle': { en: 'No matching records', zh: '没有匹配的记录' },
  'grid.noMatchingHint': { en: 'Try a different search term', zh: '试试其他搜索词' },
  'grid.collapseRow': { en: 'Collapse row', zh: '收起行' },
  'grid.expandRow': { en: 'Expand row', zh: '展开行' },
  'grid.lockRow': { en: 'Lock row', zh: '锁定此行' },
  'grid.unlockRow': { en: 'Unlock row', zh: '解锁此行' },
  'grid.lockedIndicator': { en: 'Row is locked', zh: '该行已锁定' },
  'grid.errorLockRow': { en: 'Failed to lock row', zh: '锁定行失败' },
  'grid.errorUnlockRow': { en: 'Failed to unlock row', zh: '解锁行失败' },
  'grid.prev': { en: 'Prev', zh: '上一页' },
  'grid.next': { en: 'Next', zh: '下一页' },
  'grid.loading': { en: 'Loading data', zh: '正在加载数据' },
  // Frontend-owned composable fallbacks. Backend/user messages still win via `e.message ?? fallback`.
  'grid.errorLoadViewData': { en: 'Failed to load view data', zh: '加载视图数据失败' },
  'grid.errorEditRowBlocked': {
    en: 'Record editing is not allowed for this row.',
    zh: '该行不允许编辑记录。',
  },
  'grid.errorDeleteRowBlocked': {
    en: 'Record deletion is not allowed for this row.',
    zh: '该行不允许删除记录。',
  },
  'grid.errorContextRequired': { en: 'sheetId or viewId is required', zh: '需要 sheetId 或 viewId' },
  'grid.errorCreateRecord': { en: 'Failed to create record', zh: '创建记录失败' },
  'grid.errorDeleteRecord': { en: 'Failed to delete record', zh: '删除记录失败' },
  'grid.errorCellUpdatedElsewhere': {
    en: 'This cell was updated elsewhere. Reload and retry.',
    zh: '该单元格已在别处更新。请重新加载后重试。',
  },
  'grid.errorPatchCell': { en: 'Failed to patch cell', zh: '更新单元格失败' },
  'grid.errorRecordVersionUnavailable': {
    en: 'The latest record version is not available on this page anymore.',
    zh: '此页面已无法获取该记录的最新版本。',
  },
  'grid.errorPatchFailed': { en: 'Patch failed', zh: '更新失败' },

  // Auth chrome (#1803 file-location closure tightening).
  // Used by useYjsDocument.ts:126 when local auth.getToken() returns falsy.
  // Catch-time isZh capture (event-time semantics matching Slice E composables).
  'auth.notAuthenticated': { en: 'Not authenticated', zh: '未登录' },

  // MetaCellEditor (T3A2): shallow chrome inside the grid cell editor.
  // Excludes user data (option values, format examples like https://example.com),
  // backend free-form errors, and link-button labels driven by formatLinkActionLabel
  // (those are queued for T3B).
  'cell.editing': { en: 'Editing', zh: '正在编辑' },
  'cell.barcodePlaceholder': { en: 'Scan or enter barcode', zh: '扫描或输入条码' },
  'cell.qrcodePlaceholder': { en: 'Enter text or URL for QR code', zh: '输入二维码文本或网址' },
  'cell.locationPlaceholder': { en: 'Enter address', zh: '输入地址' },
  'cell.yes': { en: 'Yes', zh: '是' },
  'cell.no': { en: 'No', zh: '否' },
  'cell.clear': { en: 'Clear', zh: '清除' },
  'cell.noAttachments': { en: 'No attachments', zh: '无附件' },
  // Same en/zh as toolbar.clearAll but kept namespaced — different surface,
  // different reviewer audit path.
  'cell.clearAll': { en: 'Clear all', zh: '全部清除' },
  // Fallback-only: backend error.message is preferred when present (kept raw,
  // since it is user data); these are the frontend fallback for the `??` branch.
  'cell.uploadFailed': { en: 'Failed to upload attachment', zh: '附件上传失败' },
  'cell.removeFailed': { en: 'Failed to remove attachment', zh: '附件移除失败' },
  'cell.clearFailed': { en: 'Failed to clear attachments', zh: '附件清空失败' },
  // A3-T6: in-cell AI run trigger (host opt-in; RBAC rides the editor-open invariant).
  'cell.aiRun': { en: 'Run AI', zh: '运行 AI' },
  'cell.aiRunning': { en: 'Running AI...', zh: 'AI 处理中...' },

  // A3 linked-record popover: a clickable link chip expands the foreign record
  // read-only in a popover. Title is static chrome; `error` is a frontend
  // fallback only — a backend error.message wins via `e.message ?? fallback`.
  'linkedRecord.title': { en: 'Linked record', zh: '关联记录' },
  'linkedRecord.loading': { en: 'Loading record...', zh: '正在加载记录...' },
  'linkedRecord.error': { en: 'Failed to load linked record', zh: '加载关联记录失败' },
  'linkedRecord.close': { en: 'Close', zh: '关闭' },
  'linkedRecord.empty': { en: 'No fields to show', zh: '没有可显示的字段' },
  'mention.suggestionsAria': { en: 'Mention people', zh: '提及成员' },
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

// percentGaugeAria: accessible label for the read-only percent progress bar
// in MetaCellRenderer (r13 UI parity). `text` is the already-formatted percent
// string (e.g. "65%") — user-facing data, interpolated raw.
export function percentGaugeAria(text: string, isZh: boolean): string {
  return isZh ? `进度 ${text}` : `Progress ${text}`
}

// ratingGaugeAria: accessible label for the read-only rating segment display
// in MetaCellRenderer (r13 UI parity). Both numbers are UI-derived counts.
export function ratingGaugeAria(filled: number, max: number, isZh: boolean): string {
  return isZh ? `评分 ${filled} / ${max}` : `Rating ${filled} of ${max}`
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
  dateTime: { en: 'date time', zh: '日期时间' },
  link: { en: 'link', zh: '关联' },
  person: { en: 'person', zh: '人员' },
  lookup: { en: 'lookup', zh: '查找' },
  rollup: { en: 'rollup', zh: '汇总' },
  formula: { en: 'formula', zh: '公式' },
  attachment: { en: 'attachment', zh: '附件' },
  currency: { en: 'currency', zh: '货币' },
  percent: { en: 'percent', zh: '百分比' },
  rating: { en: 'rating', zh: '评分' },
  duration: { en: 'duration', zh: '时长' },
  url: { en: 'URL', zh: '网址' },
  email: { en: 'email', zh: '邮箱' },
  phone: { en: 'phone', zh: '电话' },
  barcode: { en: 'barcode', zh: '条码' },
  qrcode: { en: 'QR code', zh: '二维码' },
  location: { en: 'location', zh: '位置' },
  autoNumber: { en: 'auto number', zh: '自动编号' },
  createdTime: { en: 'created time', zh: '创建时间' },
  modifiedTime: { en: 'modified time', zh: '修改时间' },
  createdBy: { en: 'created by', zh: '创建人' },
  modifiedBy: { en: 'modified by', zh: '修改人' },
  button: { en: 'button', zh: '按钮' },
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

// --- T3A2: MetaCellEditor attachment helpers ---

// AttachmentActionMode (T3B1): selects the multi-file copy variant.
//   - `drop`  → "Drop files or click to browse" (MetaCellEditor — drop target chrome)
//   - `add`   → "Add files" (MetaRecordDrawer / MetaFormView — add-action chrome)
// Single-file branches are identical across modes (the mode only matters
// when allowsMultiple is true). Backwards compatible: legacy callers
// without an explicit mode keep T3A2 behavior via the default.
export type AttachmentActionMode = 'drop' | 'add'

// attachmentActionHint: drop-target hint for the MetaCellEditor attachment
// trigger (mode='drop', T3A2 default) or the add-files trigger used by
// MetaRecordDrawer / MetaFormView (mode='add', T3B1). Three variants chosen
// by capability + existing-attachment state:
//   multi-file allowed → mode='drop' "Drop files or click to browse" /
//                        mode='add'  "Add files"
//   single-file + already has an attachment → "Upload a new file to replace the current one"
//   single-file + empty → "Upload a file"
// `hasExisting` is a boolean — only >0-ness matters to copy, not the count.
// User-confirmed zh choices (T3A2 AskUserQuestion, 2026-05-19): 拖拽文件或点击选择 /
// 上传新文件以替换当前文件 / 上传文件. T3B1 add-mode zh: 添加文件.
export function attachmentActionHint(
  allowsMultiple: boolean,
  hasExisting: boolean,
  isZh: boolean,
  mode: AttachmentActionMode = 'drop',
): string {
  if (allowsMultiple) {
    if (mode === 'add') return isZh ? '添加文件' : 'Add files'
    return isZh ? '拖拽文件或点击选择' : 'Drop files or click to browse'
  }
  if (hasExisting) return isZh ? '上传新文件以替换当前文件' : 'Upload a new file to replace the current one'
  return isZh ? '上传文件' : 'Upload a file'
}

// attachmentActivityLabel: in-progress label below the attachment trigger.
// Source enum matches MetaCellEditor's `attachmentActivity` ref union.
export function attachmentActivityLabel(
  activity: 'uploading' | 'removing' | 'clearing',
  isZh: boolean,
): string {
  if (activity === 'removing') return isZh ? '正在移除...' : 'Removing...'
  if (activity === 'clearing') return isZh ? '正在清空...' : 'Clearing...'
  return isZh ? '正在上传...' : 'Uploading...'
}

// --- A3: AI shortcut per-run tokens (§2.4 user visibility) ---
// Shared by MetaRecordDrawer (run/preview result) and MetaFieldManager
// (config-time preview result). Lives HERE once — never redeclared in
// meta-record-labels / meta-manager-labels (cross-module reuse, documented).
export function aiTokensConsumed(tokens: number, isZh: boolean): string {
  return isZh ? `本次消耗 ~${tokens} tokens` : `~${tokens} tokens used`
}
