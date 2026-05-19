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
} from '../src/multitable/utils/meta-core-labels'

describe('meta-core-labels static keys', () => {
  it('returns zh for isZh=true and en for isZh=false', () => {
    expect(metaCoreLabel('toolbar.fields', true)).toBe('字段')
    expect(metaCoreLabel('toolbar.fields', false)).toBe('Fields')
    expect(metaCoreLabel('grid.aria', true)).toBe('数据表格')
    expect(metaCoreLabel('grid.aria', false)).toBe('Data grid')
    expect(metaCoreLabel('toolbar.aria', true)).toBe('表格工具栏')
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
    // unknown / custom type: returned unchanged in BOTH locales
    expect(fieldTypeLabel('formula', false)).toBe('formula')
    expect(fieldTypeLabel('formula', true)).toBe('formula')
  })

  it('filterValuePlaceholder is keyed by field type with a text fallback', () => {
    expect(filterValuePlaceholder('number', false)).toBe('Enter a number')
    expect(filterValuePlaceholder('number', true)).toBe('输入数字')
    expect(filterValuePlaceholder('date', true)).toBe('选择日期')
    expect(filterValuePlaceholder('string', true)).toBe('输入筛选文本')
    expect(filterValuePlaceholder('whatever', false)).toBe('Enter filter text')
  })
})
