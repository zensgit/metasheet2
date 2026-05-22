import { describe, it, expect } from 'vitest'
import {
  metaCoreLabel,
  rowCount,
  selectedCount,
  commentForRow,
  commentForField,
  groupNoValue,
  fieldTypeLabel,
  filterValuePlaceholder,
  attachmentActionHint,
  attachmentActivityLabel,
} from '../src/multitable/utils/meta-core-labels'

describe('meta-core-labels static keys', () => {
  it('returns zh for isZh=true and en for isZh=false', () => {
    expect(metaCoreLabel('presence.collaboratingNow', true)).toBe('正在协作')
    expect(metaCoreLabel('presence.collaboratingNow', false)).toBe('Collaborating now')
    expect(metaCoreLabel('toolbar.fields', true)).toBe('字段')
    expect(metaCoreLabel('toolbar.fields', false)).toBe('Fields')
    expect(metaCoreLabel('grid.aria', true)).toBe('数据表格')
    expect(metaCoreLabel('grid.aria', false)).toBe('Data grid')
    expect(metaCoreLabel('toolbar.aria', true)).toBe('表格工具栏')
    expect(metaCoreLabel('grid.errorLoadViewData', true)).toBe('加载视图数据失败')
    expect(metaCoreLabel('grid.errorPatchCell', false)).toBe('Failed to patch cell')
    expect(metaCoreLabel('grid.errorPatchFailed', true)).toBe('更新失败')
  })

  it('F1: sort-direction options — en keeps alphabet arrows, zh is 升序/降序', () => {
    expect(metaCoreLabel('toolbar.sortAsc', false)).toBe('A → Z')
    expect(metaCoreLabel('toolbar.sortDesc', false)).toBe('Z → A')
    expect(metaCoreLabel('toolbar.sortAsc', true)).toBe('升序')
    expect(metaCoreLabel('toolbar.sortDesc', true)).toBe('降序')
  })

  it('F3: undo/redo title keeps the physical-key shortcut literal in both locales', () => {
    expect(metaCoreLabel('toolbar.undo', true)).toBe('撤销')
    expect(metaCoreLabel('toolbar.undoTitle', true)).toBe('撤销 (Ctrl+Z)')
    expect(metaCoreLabel('toolbar.undoTitle', false)).toBe('Undo (Ctrl+Z)')
    expect(metaCoreLabel('toolbar.redoTitle', true)).toBe('重做 (Ctrl+Y)')
    expect(metaCoreLabel('toolbar.redoTitle', false)).toBe('Redo (Ctrl+Y)')
  })

  it('F4: filter-control aria labels are present', () => {
    expect(metaCoreLabel('toolbar.filterField', true)).toBe('筛选字段')
    expect(metaCoreLabel('toolbar.filterOperator', true)).toBe('筛选运算符')
    expect(metaCoreLabel('toolbar.filterValue', true)).toBe('筛选值')
    expect(metaCoreLabel('toolbar.filterField', false)).toBe('Filter field')
  })

  it('user-confirmed: Rows density button zh=行高, en stays Rows; distinct from rowHeight key', () => {
    expect(metaCoreLabel('toolbar.rows', false)).toBe('Rows')
    expect(metaCoreLabel('toolbar.rows', true)).toBe('行高')
    expect(metaCoreLabel('toolbar.rowHeight', false)).toBe('Row height')
    expect(metaCoreLabel('toolbar.rowHeight', true)).toBe('行高')
  })

  it('checkbox / boolean filter option labels keep the literal true/false token', () => {
    expect(metaCoreLabel('toolbar.checkedTrue', true)).toBe('已勾选 / true')
    expect(metaCoreLabel('toolbar.uncheckedFalse', true)).toBe('未勾选 / false')
  })
})

describe('meta-core-labels helpers', () => {
  it('rowCount fixes en pluralization; zh has no plural', () => {
    expect(rowCount(1, false)).toBe('1 row')
    expect(rowCount(2, false)).toBe('2 rows')
    expect(rowCount(0, false)).toBe('0 rows')
    expect(rowCount(1, true)).toBe('1 行')
    expect(rowCount(2, true)).toBe('2 行')
  })

  it('selectedCount: en "selected" does not inflect; zh uses 已选择 N 条', () => {
    expect(selectedCount(1, false)).toBe('1 selected')
    expect(selectedCount(2, false)).toBe('2 selected')
    expect(selectedCount(1, true)).toBe('已选择 1 条')
    expect(selectedCount(3, true)).toBe('已选择 3 条')
  })

  it('commentForRow uses the UI-generated 1-based row number', () => {
    expect(commentForRow(3, false)).toBe('Comments for row 3')
    expect(commentForRow(3, true)).toBe('第 3 行评论')
  })

  it('commentForField interpolates the field name raw — never translated', () => {
    expect(commentForField('Status', false)).toBe('Comments for Status')
    expect(commentForField('Status', true)).toBe('Status 的评论')
    // a Chinese-authored field name also passes through unchanged
    expect(commentForField('负责人', true)).toBe('负责人 的评论')
  })

  it('groupNoValue localizes only the synthetic fallback label', () => {
    expect(groupNoValue(false)).toBe('(No value)')
    expect(groupNoValue(true)).toBe('(无值)')
  })

  it('fieldTypeLabel translates known types and falls back to the raw type', () => {
    expect(fieldTypeLabel('longText', false)).toBe('long text')
    expect(fieldTypeLabel('longText', true)).toBe('长文本')
    expect(fieldTypeLabel('multiSelect', true)).toBe('多选')
    expect(fieldTypeLabel('boolean', true)).toBe('复选框')
    expect(fieldTypeLabel('formula', false)).toBe('formula')
    expect(fieldTypeLabel('formula', true)).toBe('公式')
    expect(fieldTypeLabel('autoNumber', false)).toBe('auto number')
    expect(fieldTypeLabel('createdTime', true)).toBe('创建时间')
    // unknown / custom type: returned unchanged in BOTH locales
    expect(fieldTypeLabel('customType', false)).toBe('customType')
    expect(fieldTypeLabel('customType', true)).toBe('customType')
  })

  it('filterValuePlaceholder is keyed by field type with a text fallback', () => {
    expect(filterValuePlaceholder('number', false)).toBe('Enter a number')
    expect(filterValuePlaceholder('number', true)).toBe('输入数字')
    expect(filterValuePlaceholder('date', true)).toBe('选择日期')
    expect(filterValuePlaceholder('string', true)).toBe('输入筛选文本')
    expect(filterValuePlaceholder('whatever', false)).toBe('Enter filter text')
  })
})

describe('meta-core-labels MetaCellEditor static keys (T3A2)', () => {
  it('localizes cell.editing / barcode / location / yes / no / clear / noAttachments / clearAll', () => {
    expect(metaCoreLabel('cell.editing', true)).toBe('正在编辑')
    expect(metaCoreLabel('cell.editing', false)).toBe('Editing')
    expect(metaCoreLabel('cell.barcodePlaceholder', true)).toBe('扫描或输入条码')
    expect(metaCoreLabel('cell.locationPlaceholder', true)).toBe('输入地址')
    expect(metaCoreLabel('cell.yes', true)).toBe('是')
    expect(metaCoreLabel('cell.no', true)).toBe('否')
    expect(metaCoreLabel('cell.clear', true)).toBe('清除')
    expect(metaCoreLabel('cell.noAttachments', true)).toBe('无附件')
    expect(metaCoreLabel('cell.clearAll', true)).toBe('全部清除')
  })

  it('localizes attachment fallback error strings (frontend ?? branch only)', () => {
    expect(metaCoreLabel('cell.uploadFailed', true)).toBe('附件上传失败')
    expect(metaCoreLabel('cell.removeFailed', true)).toBe('附件移除失败')
    expect(metaCoreLabel('cell.clearFailed', true)).toBe('附件清空失败')
    // en preserved exactly to keep the existing `?? 'Failed to ...'` semantics
    expect(metaCoreLabel('cell.uploadFailed', false)).toBe('Failed to upload attachment')
    expect(metaCoreLabel('cell.removeFailed', false)).toBe('Failed to remove attachment')
    expect(metaCoreLabel('cell.clearFailed', false)).toBe('Failed to clear attachments')
  })

  it('cell.clearAll is namespaced separately from toolbar.clearAll (same en/zh, different surface)', () => {
    expect(metaCoreLabel('cell.clearAll', true)).toBe('全部清除')
    expect(metaCoreLabel('toolbar.clearAll', true)).toBe('全部清除')
    expect(metaCoreLabel('cell.clearAll', false)).toBe('Clear all')
    expect(metaCoreLabel('toolbar.clearAll', false)).toBe('Clear all')
  })
})

describe('meta-core-labels MetaCellEditor helpers (T3A2)', () => {
  it('attachmentActionHint picks the multi-file copy when allowsMultiple', () => {
    expect(attachmentActionHint(true, false, false)).toBe('Drop files or click to browse')
    expect(attachmentActionHint(true, true, false)).toBe('Drop files or click to browse')
    expect(attachmentActionHint(true, false, true)).toBe('拖拽文件或点击选择')
  })

  it('attachmentActionHint distinguishes single-file empty vs has-existing', () => {
    expect(attachmentActionHint(false, false, false)).toBe('Upload a file')
    expect(attachmentActionHint(false, false, true)).toBe('上传文件')
    expect(attachmentActionHint(false, true, false)).toBe('Upload a new file to replace the current one')
    expect(attachmentActionHint(false, true, true)).toBe('上传新文件以替换当前文件')
  })

  it('attachmentActivityLabel covers all three states matching MetaCellEditor activity ref', () => {
    expect(attachmentActivityLabel('uploading', false)).toBe('Uploading...')
    expect(attachmentActivityLabel('uploading', true)).toBe('正在上传...')
    expect(attachmentActivityLabel('removing', false)).toBe('Removing...')
    expect(attachmentActivityLabel('removing', true)).toBe('正在移除...')
    expect(attachmentActivityLabel('clearing', false)).toBe('Clearing...')
    expect(attachmentActivityLabel('clearing', true)).toBe('正在清空...')
  })
})

describe('meta-core-labels attachmentActionHint mode extension (T3B1)', () => {
  it('default mode (no 4th arg) keeps T3A2 behavior exactly — backwards compatible', () => {
    // multi-file
    expect(attachmentActionHint(true, false, false)).toBe('Drop files or click to browse')
    expect(attachmentActionHint(true, false, true)).toBe('拖拽文件或点击选择')
    // single + existing
    expect(attachmentActionHint(false, true, false)).toBe('Upload a new file to replace the current one')
    expect(attachmentActionHint(false, true, true)).toBe('上传新文件以替换当前文件')
    // single + empty
    expect(attachmentActionHint(false, false, false)).toBe('Upload a file')
    expect(attachmentActionHint(false, false, true)).toBe('上传文件')
  })

  it("explicit mode='drop' equals the legacy default (regression guard)", () => {
    expect(attachmentActionHint(true, false, false, 'drop')).toBe('Drop files or click to browse')
    expect(attachmentActionHint(true, false, true, 'drop')).toBe('拖拽文件或点击选择')
    expect(attachmentActionHint(false, true, false, 'drop')).toBe('Upload a new file to replace the current one')
    expect(attachmentActionHint(false, false, true, 'drop')).toBe('上传文件')
  })

  it("mode='add' changes only the multi-file copy to Add files / 添加文件", () => {
    // multi-file → distinct add copy
    expect(attachmentActionHint(true, false, false, 'add')).toBe('Add files')
    expect(attachmentActionHint(true, false, true, 'add')).toBe('添加文件')
    // multi-file + has existing still picks the multi-file branch (allowsMultiple guards)
    expect(attachmentActionHint(true, true, false, 'add')).toBe('Add files')
    expect(attachmentActionHint(true, true, true, 'add')).toBe('添加文件')
  })

  it("mode='add' does NOT affect single-file branches (mode only matters when allowsMultiple)", () => {
    // single + existing
    expect(attachmentActionHint(false, true, false, 'add')).toBe('Upload a new file to replace the current one')
    expect(attachmentActionHint(false, true, true, 'add')).toBe('上传新文件以替换当前文件')
    // single + empty
    expect(attachmentActionHint(false, false, false, 'add')).toBe('Upload a file')
    expect(attachmentActionHint(false, false, true, 'add')).toBe('上传文件')
  })
})
