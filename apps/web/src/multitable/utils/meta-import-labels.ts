// Import modal chrome string table (T3C).
//
// Scope: MetaImportModal.vue UI chrome and frontend-owned fallback messages.
// Imported headers, field names, cell values, selected linked-record labels,
// and backend/import failure messages are user data and pass through unchanged.

export type MetaImportLabelKey =
  | 'import.title'
  | 'import.recoveredDraft'
  | 'import.pasteHint'
  | 'import.fileDrop'
  | 'import.textareaPlaceholder'
  | 'import.cancel'
  | 'import.preview'
  | 'import.skip'
  | 'import.reconcileDraft'
  | 'import.back'
  | 'import.cancelImport'
  | 'import.failedReviewRetry'
  | 'import.failedReviewMapping'
  | 'import.skippedDuplicates'
  | 'import.success'
  | 'import.backToMapping'
  | 'import.retryFailedRows'
  | 'import.applyFixes'
  | 'import.close'
  | 'import.emptyRow'
  | 'import.peopleExactHint'
  | 'import.discardConfirm'
  | 'import.errorNeedRows'
  | 'import.errorNoRows'
  | 'import.errorReadFile'
  | 'import.errorSpreadsheetEmpty'
  | 'import.errorReadExcel'

const META_IMPORT_LABELS: Record<MetaImportLabelKey, { en: string; zh: string }> = {
  'import.title': { en: 'Import Records', zh: '导入记录' },
  'import.recoveredDraft': {
    en: 'Recovered your previous import draft for this sheet.',
    zh: '已恢复此表的上次导入草稿。',
  },
  'import.pasteHint': {
    en: 'Paste tab-separated data from Excel or Google Sheets (first row = headers):',
    zh: '粘贴来自 Excel 或 Google Sheets 的制表符分隔数据（第一行为表头）：',
  },
  'import.fileDrop': {
    en: 'Choose a CSV/TSV/Excel file or drop it here',
    zh: '选择 CSV/TSV/Excel 文件，或拖到这里',
  },
  'import.textareaPlaceholder': {
    en: 'Name\tAge\tEmail\nAlice\t30\talice@example.com',
    zh: '姓名\t年龄\t邮箱\n张三\t30\tzhangsan@example.com',
  },
  'import.cancel': { en: 'Cancel', zh: '取消' },
  'import.preview': { en: 'Preview', zh: '预览' },
  'import.skip': { en: '(skip)', zh: '(跳过)' },
  'import.reconcileDraft': { en: 'Reconcile draft', zh: '修复草稿' },
  'import.back': { en: 'Back', zh: '返回' },
  'import.cancelImport': { en: 'Cancel import', zh: '取消导入' },
  'import.failedReviewRetry': {
    en: 'Review the failed rows below, then retry just those rows or return to mapping.',
    zh: '请检查下方失败行，然后仅重试这些行，或返回映射。',
  },
  'import.failedReviewMapping': {
    en: 'Review the failed rows below and return to mapping to fix the source data.',
    zh: '请检查下方失败行，并返回映射以修正源数据。',
  },
  'import.skippedDuplicates': {
    en: 'Some rows were skipped as duplicates.',
    zh: '部分重复行已跳过。',
  },
  'import.success': {
    en: 'The selected records were imported successfully.',
    zh: '所选记录已成功导入。',
  },
  'import.backToMapping': { en: 'Back to mapping', zh: '返回映射' },
  'import.retryFailedRows': { en: 'Retry failed rows', zh: '重试失败行' },
  'import.applyFixes': { en: 'Apply fixes and retry', zh: '应用修正并重试' },
  'import.close': { en: 'Close', zh: '关闭' },
  'import.emptyRow': { en: '(empty row)', zh: '(空行)' },
  'import.peopleExactHint': {
    en: 'Use an exact email address or person record ID for this field.',
    zh: '请为此字段使用精确邮箱地址或人员记录 ID。',
  },
  'import.discardConfirm': {
    en: 'Discard unsaved import changes?',
    zh: '放弃未保存的导入更改吗？',
  },
  'import.errorNeedRows': {
    en: 'Need at least one header row and one data row',
    zh: '至少需要一行表头和一行数据',
  },
  'import.errorNoRows': { en: 'No importable rows found', zh: '未找到可导入的行' },
  'import.errorReadFile': { en: 'Failed to read file', zh: '读取文件失败' },
  'import.errorSpreadsheetEmpty': {
    en: 'No importable rows found in spreadsheet',
    zh: '电子表格中未找到可导入的行',
  },
  'import.errorReadExcel': { en: 'Failed to read Excel file', zh: '读取 Excel 文件失败' },
}

export function importLabel(key: MetaImportLabelKey, isZh: boolean): string {
  const entry = META_IMPORT_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function detectedRows(count: number, isZh: boolean): string {
  return isZh
    ? `已识别 ${count} 条记录。请将列映射到字段：`
    : `${count} record(s) detected. Map columns to fields:`
}

export function moreRows(count: number, isZh: boolean): string {
  return isZh ? `... 另有 ${count} 行` : `... and ${count} more`
}

export function importingRecords(count: number, isZh: boolean): string {
  return isZh ? `正在导入 ${count} 条记录...` : `Importing ${count} record(s)...`
}

export function importRecords(count: number, isZh: boolean): string {
  return isZh ? `导入 ${count} 条记录` : `Import ${count} record(s)`
}

export function importComplete(isZh: boolean): string {
  return isZh ? '导入完成' : 'Import complete'
}

export function importResultSummary(succeeded: number, skipped: number, failed: number, isZh: boolean): string {
  if (failed > 0 && skipped > 0) {
    return isZh
      ? `${succeeded} 条已导入，${skipped} 条已跳过，${failed} 条失败`
      : `${succeeded} imported, ${skipped} skipped, ${failed} failed`
  }
  if (failed > 0) return isZh ? `${succeeded} 条已导入，${failed} 条失败` : `${succeeded} imported, ${failed} failed`
  if (skipped > 0) return isZh ? `${succeeded} 条已导入，${skipped} 条已跳过` : `${succeeded} imported, ${skipped} skipped`
  return isZh ? `已导入 ${succeeded} 条记录` : `Imported ${succeeded} record(s)`
}

export function rowLabel(rowNumber: number, isZh: boolean): string {
  return isZh ? `第 ${rowNumber} 行` : `Row ${rowNumber}`
}

export function fixRowLabel(rowNumber: number, isZh: boolean): string {
  return isZh ? `修正第 ${rowNumber} 行` : `Fix Row ${rowNumber}`
}

export function columnLabel(index: number, isZh: boolean): string {
  return isZh ? `第 ${index + 1} 列` : `Column ${index + 1}`
}

export function moreFailedRows(count: number, isZh: boolean): string {
  return isZh ? `... 另有 ${count} 个失败行` : `... and ${count} more failed row(s)`
}

export function moreDraftIssues(firstMessage: string, restCount: number, isZh: boolean): string {
  if (restCount <= 0) return firstMessage
  return isZh
    ? `${firstMessage} 另有 ${restCount} 个问题需要检查。`
    : `${firstMessage} ${restCount} more issue(s) need review.`
}

export function mappedFieldRemoved(header: string, isZh: boolean): string {
  return isZh
    ? `${header} 映射的字段已在后台被删除。请先修复草稿再导入。`
    : `Mapped field for ${header} was removed in the background. Reconcile the draft before importing.`
}

export function fieldNoLongerImportable(fieldName: string, isZh: boolean): string {
  return isZh
    ? `${fieldName} 不再是可导入字段。请先修复草稿再导入。`
    : `${fieldName} is no longer an importable field. Reconcile the draft before importing.`
}

export function manualRepairFieldRemoved(isZh: boolean): string {
  return isZh
    ? '一个手动修复项指向了后台已删除的字段。请先修复草稿再导入。'
    : 'A manual repair targets a field that was removed in the background. Reconcile the draft before importing.'
}

export function selectedRepairInvalid(fieldName: string, isZh: boolean): string {
  return isZh
    ? `为 ${fieldName} 选择的关联记录修复项已失效，因为该字段类型已变更。请先修复草稿再导入。`
    : `A selected linked-record repair for ${fieldName} is no longer valid because the field changed type. Reconcile the draft before importing.`
}

export function fileTooLarge(maxMegabytes: string, isZh: boolean): string {
  return isZh ? `文件过大（最大 ${maxMegabytes} MB）` : `File too large (max ${maxMegabytes} MB)`
}

export function xlsxTruncated(importedRows: number, maxRows: number, isZh: boolean): string {
  return isZh
    ? `已导入前 ${importedRows} 行；其余行已跳过（上限 ${maxRows}）。`
    : `Imported the first ${importedRows} rows; remaining rows were skipped (limit ${maxRows}).`
}

export function importResolverMissing(fieldName: string, kind: 'person' | 'link', isZh: boolean): string {
  if (kind === 'person') {
    return isZh
      ? `人员字段 ${fieldName} 未配置导入解析器`
      : `No import resolver is configured for people field ${fieldName}`
  }
  return isZh
    ? `关联字段 ${fieldName} 未配置导入解析器`
    : `No import resolver is configured for linked field ${fieldName}`
}

export function importValueResolveFailed(
  fieldName: string,
  rawValue: string,
  kind: 'person' | 'link',
  isZh: boolean,
): string {
  if (kind === 'person') {
    return isZh
      ? `无法解析 ${fieldName} 的人员值：${rawValue}`
      : `Unable to resolve people value for ${fieldName}: ${rawValue}`
  }
  return isZh
    ? `无法解析 ${fieldName} 的关联值：${rawValue}`
    : `Unable to resolve linked value for ${fieldName}: ${rawValue}`
}

export function importCancelled(isZh: boolean): string {
  return isZh ? '导入已取消' : 'Import cancelled'
}

export function duplicateRowSkipped(primaryFieldName: string, rawValue: unknown, isZh: boolean): string {
  const normalizedRaw = String(rawValue).trim()
  return isZh
    ? `已跳过重复行，因为 ${primaryFieldName} 已存在：${normalizedRaw}`
    : `Skipped duplicate row because ${primaryFieldName} already exists: ${normalizedRaw}`
}
