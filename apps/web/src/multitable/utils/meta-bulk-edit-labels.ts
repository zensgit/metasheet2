// Bulk-edit dialog chrome string table (T3E-3).
//
// Scope: MetaBulkEditDialog.vue and Workbench-owned bulk edit result fallbacks.
// Field names, record ids, backend/runtime errors, and failure reasons stay raw.

export type BulkEditMode = 'set' | 'clear'

export type MetaBulkEditLabelKey =
  | 'bulk.titleSet'
  | 'bulk.titleClear'
  | 'bulk.field'
  | 'bulk.fieldAria'
  | 'bulk.chooseField'
  | 'bulk.noEditableFields'
  | 'bulk.value'
  | 'bulk.action'
  | 'bulk.close'
  | 'bulk.cancel'
  | 'bulk.submitSet'
  | 'bulk.submitClear'
  | 'bulk.errorFailed'

const LABELS: Record<MetaBulkEditLabelKey, { en: string; zh: string }> = {
  'bulk.titleSet': { en: 'Set field for selected records', zh: '为所选记录设置字段' },
  'bulk.titleClear': { en: 'Clear field for selected records', zh: '清空所选记录的字段' },
  'bulk.field': { en: 'Field', zh: '字段' },
  'bulk.fieldAria': { en: 'Field to update', zh: '要更新的字段' },
  'bulk.chooseField': { en: '(choose a field)', zh: '（选择字段）' },
  'bulk.noEditableFields': {
    en: 'No bulk-editable fields are available for the current selection.',
    zh: '当前选择没有可批量编辑的字段。',
  },
  'bulk.value': { en: 'Value', zh: '值' },
  'bulk.action': { en: 'Action', zh: '操作' },
  'bulk.close': { en: 'Close', zh: '关闭' },
  'bulk.cancel': { en: 'Cancel', zh: '取消' },
  'bulk.submitSet': { en: 'Set value', zh: '设置值' },
  'bulk.submitClear': { en: 'Clear', zh: '清空' },
  'bulk.errorFailed': { en: 'Bulk edit failed', zh: '批量编辑失败' },
}

export function bulkEditLabel(key: MetaBulkEditLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

function recordWord(count: number): string {
  return count === 1 ? 'record' : 'records'
}

function modePast(mode: BulkEditMode): string {
  return mode === 'clear' ? 'cleared' : 'updated'
}

export function bulkSummary(mode: BulkEditMode, count: number, isZh: boolean): string {
  if (mode === 'clear') {
    return isZh
      ? `选择要在 ${count} 条所选记录中清空的字段。`
      : `Pick a field to clear on ${count} selected ${recordWord(count)}.`
  }
  return isZh
    ? `选择字段和值，应用到 ${count} 条所选记录。`
    : `Pick a field and a value to set on ${count} selected ${recordWord(count)}.`
}

export function bulkClearHintPrefix(count: number, isZh: boolean): string {
  return isZh ? `将在 ${count} 条记录中清空 ` : 'Will clear '
}

export function bulkClearHintSuffix(count: number, isZh: boolean): string {
  return isZh ? '。' : ` on ${count} ${recordWord(count)}.`
}

export function bulkSuccess(count: number, mode: BulkEditMode, isZh: boolean): string {
  if (isZh) return mode === 'clear' ? `已清空 ${count} 条记录` : `已更新 ${count} 条记录`
  return `${count} ${recordWord(count)} ${modePast(mode)}`
}

export function bulkPartialSuccess(updated: number, requested: number, mode: BulkEditMode, isZh: boolean): string {
  if (isZh) return `${requested} 条记录中已${mode === 'clear' ? '清空' : '更新'} ${updated} 条`
  return `${updated} of ${requested} ${recordWord(requested)} ${modePast(mode)}`
}

export function bulkFailure(failed: number, requested: number, sampleFailures: string, isZh: boolean): string {
  const detail = sampleFailures ? (isZh ? `（${sampleFailures}）` : ` (${sampleFailures})`) : ''
  return isZh
    ? `${requested} 条记录中有 ${failed} 条失败${detail}`
    : `${failed} of ${requested} ${recordWord(requested)} failed${detail}`
}

export function bulkVersionConflict(message: string, isZh: boolean): string {
  const detail = message ? (isZh ? `（${message}）` : ` (${message})`) : ''
  return isZh
    ? `部分记录已在其他位置修改。请重新加载后重试。${detail}`
    : `Some records were modified elsewhere. Reload and retry.${detail}`
}
