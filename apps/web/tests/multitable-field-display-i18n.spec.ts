import { describe, expect, it } from 'vitest'
import {
  formatAxisDayLabel,
  formatAxisLongDateLabel,
  formatAxisMonthLabel,
  formatAxisWeekRangeLabel,
  formatDateValue,
  formatFieldDisplay,
} from '../src/multitable/utils/field-display'
import type { MetaField } from '../src/multitable/types'

describe('formatFieldDisplay i18n fallbacks', () => {
  it('keeps English boolean labels by default and localizes them when requested', () => {
    const field: MetaField = { id: 'done', name: 'Done', type: 'boolean' }

    expect(formatFieldDisplay({ field, value: true })).toBe('Yes')
    expect(formatFieldDisplay({ field, value: false })).toBe('No')
    expect(formatFieldDisplay({ field, value: true, isZh: true })).toBe('是')
    expect(formatFieldDisplay({ field, value: false, isZh: true })).toBe('否')
  })

  it('localizes link count summaries without translating linked record display names', () => {
    const personField: MetaField = {
      id: 'owner',
      name: 'Owner',
      type: 'link',
      property: { refKind: 'user' } as unknown as MetaField['property'],
    }
    const recordField: MetaField = { id: 'task', name: 'Task', type: 'link' }

    expect(formatFieldDisplay({ field: personField, value: ['u1', 'u2'], isZh: true })).toBe('2 个人员')
    expect(formatFieldDisplay({ field: recordField, value: ['r1'], isZh: true })).toBe('1 条关联记录')
    expect(formatFieldDisplay({
      field: personField,
      value: ['u1'],
      linkSummaries: [{ id: 'u1', display: 'Amy Wong' }],
      isZh: true,
    })).toBe('Amy Wong')
  })

  it('formats date cells as 2026-09-08 in zh and never uses English month names', () => {
    const field: MetaField = { id: 'due', name: 'Due', type: 'date' }
    expect(formatDateValue('2026-08-31', true)).toBe('2026-08-31')
    expect(formatDateValue('2026-09-08', true)).toBe('2026-09-08')
    expect(formatFieldDisplay({ field, value: '2026-08-31', isZh: true })).toBe('2026-08-31')
    expect(formatFieldDisplay({ field, value: '2026-08-31', isZh: true })).not.toMatch(/Aug|Sep|Oct|Jan|Feb|Mar|Apr|May|Jun|Jul|Nov|Dec/)
    expect(formatDateValue('2026-08-31', false)).toBe('Aug 31, 2026')
  })

  it('formats sheet axis labels in zh without English month names', () => {
    const day = new Date(2026, 7, 31)
    expect(formatAxisDayLabel(day, true)).toBe('8月31日')
    expect(formatAxisDayLabel(day, true)).not.toMatch(/Aug|Sep|Oct|Jan|Feb|Mar|Apr|May|Jun|Jul|Nov|Dec/)
    expect(formatAxisDayLabel(day, false)).toBe('Aug 31')
    expect(formatAxisMonthLabel(day, true)).toBe('2026年8月')
    expect(formatAxisMonthLabel(day, true, 'long')).toBe('2026年8月')
    expect(formatAxisMonthLabel(day, false, 'long')).toBe('August 2026')
    expect(formatAxisLongDateLabel(day, true)).toBe('2026年8月31日星期一')
    expect(formatAxisLongDateLabel(day, true)).not.toMatch(/Aug|August|Monday/)
    expect(formatAxisWeekRangeLabel(day, new Date(2026, 8, 6), true)).toBe('8月31日 - 2026年9月6日')
    expect(formatAxisWeekRangeLabel(day, new Date(2026, 8, 6), true)).not.toMatch(/Aug|Sep/)
  })

  it('localizes attachment count summaries without translating file names', () => {
    const field: MetaField = { id: 'files', name: 'Files', type: 'attachment' }

    expect(formatFieldDisplay({ field, value: ['a1', 'a2'], isZh: true })).toBe('2 个附件')
    expect(formatFieldDisplay({
      field,
      value: ['a1'],
      attachmentSummaries: [{ id: 'a1', filename: 'Design Brief.pdf', mimeType: 'application/pdf', size: 1, url: '', thumbnailUrl: null, uploadedAt: '' }],
      isZh: true,
    })).toBe('Design Brief.pdf')
  })
})
