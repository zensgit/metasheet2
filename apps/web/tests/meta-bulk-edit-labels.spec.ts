import { describe, expect, it } from 'vitest'

import {
  bulkClearHintPrefix,
  bulkClearHintSuffix,
  bulkEditLabel,
  bulkFailure,
  bulkPartialSuccess,
  bulkSuccess,
  bulkSummary,
  bulkVersionConflict,
} from '../src/multitable/utils/meta-bulk-edit-labels'

describe('meta-bulk-edit-labels', () => {
  it('returns static bulk edit labels in en and zh', () => {
    expect(bulkEditLabel('bulk.titleSet', false)).toBe('Set field for selected records')
    expect(bulkEditLabel('bulk.titleSet', true)).toBe('为所选记录设置字段')
    expect(bulkEditLabel('bulk.noEditableFields', true)).toBe('当前选择没有可批量编辑的字段。')
  })

  it('formats set and clear summaries with real English pluralization', () => {
    expect(bulkSummary('set', 1, false)).toBe('Pick a field and a value to set on 1 selected record.')
    expect(bulkSummary('clear', 3, false)).toBe('Pick a field to clear on 3 selected records.')
    expect(bulkSummary('set', 3, true)).toBe('选择字段和值，应用到 3 条所选记录。')
    expect(bulkSummary('clear', 3, true)).toBe('选择要在 3 条所选记录中清空的字段。')
  })

  it('keeps clear-hint prefix and suffix whitespace byte-exact', () => {
    expect(bulkClearHintPrefix(3, false)).toBe('Will clear ')
    expect(bulkClearHintSuffix(3, false)).toBe(' on 3 records.')
    expect(bulkClearHintPrefix(3, true)).toBe('将在 3 条记录中清空 ')
    expect(bulkClearHintSuffix(3, true)).toBe('。')
  })

  it('formats success and partial-success messages', () => {
    expect(bulkSuccess(1, 'set', false)).toBe('1 record updated')
    expect(bulkSuccess(3, 'clear', false)).toBe('3 records cleared')
    expect(bulkSuccess(3, 'clear', true)).toBe('已清空 3 条记录')
    expect(bulkPartialSuccess(2, 3, 'set', false)).toBe('2 of 3 records updated')
    expect(bulkPartialSuccess(2, 3, 'clear', true)).toBe('3 条记录中已清空 2 条')
  })

  it('formats failure details without empty parentheses', () => {
    expect(bulkFailure(1, 3, 'rec_1: conflict', false)).toBe('1 of 3 records failed (rec_1: conflict)')
    expect(bulkFailure(1, 3, '', false)).toBe('1 of 3 records failed')
    expect(bulkFailure(1, 3, 'rec_1: conflict', true)).toBe('3 条记录中有 1 条失败（rec_1: conflict）')
    expect(bulkFailure(1, 3, '', true)).toBe('3 条记录中有 1 条失败')
  })

  it('formats version conflicts without empty parentheses', () => {
    expect(bulkVersionConflict('v2', false)).toBe('Some records were modified elsewhere. Reload and retry. (v2)')
    expect(bulkVersionConflict('', false)).toBe('Some records were modified elsewhere. Reload and retry.')
    expect(bulkVersionConflict('v2', true)).toBe('部分记录已在其他位置修改。请重新加载后重试。（v2）')
    expect(bulkVersionConflict('', true)).toBe('部分记录已在其他位置修改。请重新加载后重试。')
  })
})
