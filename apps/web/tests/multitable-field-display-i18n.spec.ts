import { describe, expect, it, vi } from 'vitest'
import { formatDateOnlyValue, formatFieldDisplay } from '../src/multitable/utils/field-display'
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

// R61 上机观察 2026-09-30 (客户反馈 #4c follow-up): a `date` cell is `YYYY-MM-DD`, never the browser locale's
// month name (`18 Sept 2026` under zh-CN). Day-as-written text keeps its day; an instant (the PLM refresh
// writes ISO instants into date columns) is the business-timezone day.
describe('date-only cells show YYYY-MM-DD', () => {
  const field: MetaField = { id: 'due', name: 'Due', type: 'date' }

  it('keeps a day as written, in any accepted spelling', () => {
    expect(formatDateOnlyValue('2026-09-18')).toBe('2026-09-18')
    expect(formatDateOnlyValue('2026/9/8')).toBe('2026-09-08')
    expect(formatDateOnlyValue(' 2026-09-18 ')).toBe('2026-09-18')
    expect(formatFieldDisplay({ field, value: '2026-09-18', isZh: true })).toBe('2026-09-18')
    expect(formatFieldDisplay({ field, value: '2026-09-18' })).toBe('2026-09-18')
  })

  it('shows an instant as the business-timezone (Asia/Shanghai) day on both sides of UTC midnight', () => {
    // 2026-09-17T16:00Z is 2026-09-18 00:00 in Asia/Shanghai — the UTC day (and a browser west of UTC) would be off by one.
    expect(formatDateOnlyValue('2026-09-17T16:00:00.000Z')).toBe('2026-09-18')
    expect(formatDateOnlyValue('2026-09-17T15:59:59.000Z')).toBe('2026-09-17')
    expect(formatDateOnlyValue(Date.UTC(2026, 8, 17, 16, 0, 0))).toBe('2026-09-18')
    expect(formatFieldDisplay({ field, value: '2026-09-18T02:11:09.123Z' })).toBe('2026-09-18')
    expect(formatFieldDisplay({ field, value: '2026-09-18T02:11:09.123Z', isZh: true })).toBe('2026-09-18')
  })

  it('never goes through the browser locale', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString')
    expect(formatFieldDisplay({ field, value: '2026-09-18T02:11:09.123Z' })).toBe('2026-09-18')
    expect(formatFieldDisplay({ field, value: '2026-09-18' })).toBe('2026-09-18')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('falls back to the raw text for non-days and to a dash for empty', () => {
    expect(formatDateOnlyValue('not a day')).toBeNull()
    expect(formatDateOnlyValue('')).toBeNull()
    expect(formatDateOnlyValue(null)).toBeNull()
    expect(formatDateOnlyValue(undefined)).toBeNull()
    expect(formatFieldDisplay({ field, value: 'not a day' })).toBe('not a day')
    expect(formatFieldDisplay({ field, value: null })).toBe('—')
  })
})
