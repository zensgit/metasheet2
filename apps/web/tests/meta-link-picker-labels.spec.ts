import { describe, expect, it } from 'vitest'
import {
  linkPickerLabel,
  selectedCount,
  type MetaLinkPickerLabelKey,
} from '../src/multitable/utils/meta-link-picker-labels'

describe('meta-link-picker-labels static keys', () => {
  it('localizes link picker modal chrome', () => {
    const expectations: Array<[MetaLinkPickerLabelKey, string, string]> = [
      ['linkPicker.selected', 'Selected', '已选择'],
      ['linkPicker.clear', 'Clear', '清除'],
      ['linkPicker.loading', 'Loading...', '正在加载...'],
      ['linkPicker.empty', 'No records found', '未找到记录'],
      ['linkPicker.loadMore', 'Load more', '加载更多'],
      ['linkPicker.cancel', 'Cancel', '取消'],
      ['linkPicker.confirm', 'Confirm', '确认'],
      ['linkPicker.close', 'Close link picker', '关闭关联记录选择器'],
      ['linkPicker.errorLoad', 'Failed to load records', '加载记录失败'],
    ]

    for (const [key, en, zh] of expectations) {
      expect(linkPickerLabel(key, false)).toBe(en)
      expect(linkPickerLabel(key, true)).toBe(zh)
    }
  })

  it('formats selected counts with zh-CN neutral count copy', () => {
    expect(selectedCount(0, false)).toBe('0 selected')
    expect(selectedCount(1, false)).toBe('1 selected')
    expect(selectedCount(2, false)).toBe('2 selected')
    expect(selectedCount(0, true)).toBe('已选择 0 条')
    expect(selectedCount(1, true)).toBe('已选择 1 条')
    expect(selectedCount(2, true)).toBe('已选择 2 条')
  })
})
