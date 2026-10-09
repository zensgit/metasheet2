import { describe, expect, it, vi } from 'vitest'
import { dateTimeExportText, formatDateOnlyValue, formatFieldDisplay } from '../src/multitable/utils/field-display'
import { resetLookupTargetFields, setLookupTargetFields } from '../src/multitable/utils/lookup-target-fields'
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

  it('a value outside the Date range names no day and never throws out of a renderer', () => {
    expect(formatDateOnlyValue(1e20)).toBeNull()
    expect(formatDateOnlyValue(-1e20)).toBeNull()
    expect(formatFieldDisplay({ field, value: 1e20 })).toBe(String(1e20))
  })
})

// #6204 (#6181 edges 2–4): ONE rule with the server's formatDateOnlyValue (core-backend date-time-wall-clock.ts) —
// the server spec (multitable-datetime-wall-clock.test.ts) carries the same inputs with the same expectations.
describe('date-only edge inputs: the same day (or no day) as the server', () => {
  const field: MetaField = { id: 'due', name: 'Due', type: 'date' }

  it('an ISO-ish day with a designator glued on (`2026-09-18Z`) names no day — never the browser day', () => {
    // Date.parse reads it as UTC midnight; the old fallback then took the BROWSER's calendar day of that instant
    // (09-17 west of UTC). No time part, so it is not an instant either: the cell shows the raw text.
    expect(formatDateOnlyValue('2026-09-18Z')).toBeNull()
    expect(formatDateOnlyValue('2026-09-18z')).toBeNull()
    expect(formatFieldDisplay({ field, value: '2026-09-18Z' })).toBe('2026-09-18Z')
    // With a time it IS an instant (both sides): its business day.
    expect(formatDateOnlyValue('2026-09-17T16:00Z')).toBe('2026-09-18')
  })

  it('PostgreSQL text form with an hour-only offset is an instant on its business day', () => {
    expect(formatDateOnlyValue('2026-09-17 16:00:00+00')).toBe('2026-09-18')
    expect(formatDateOnlyValue('2026-09-17 15:59:59+00')).toBe('2026-09-17')
    expect(formatDateOnlyValue('2026-09-17 16:00:00.123456+00')).toBe('2026-09-18')
    expect(formatDateOnlyValue('2026-09-18 00:00:00+08')).toBe('2026-09-18')
  })

  it('a string that is just a number names no day (never a year, a 2001 month, a yyyymmdd or an epoch)', () => {
    for (const text of ['2026', '5', '0', '-1', '+5', '20260918', '1758211200000', '46283.5', '2026.9']) {
      expect(formatDateOnlyValue(text)).toBeNull()
    }
    expect(formatFieldDisplay({ field, value: '2026' })).toBe('2026')
  })

  it('an epoch-ms NUMBER stays an instant (both sides): its business day', () => {
    expect(formatDateOnlyValue(Date.parse('2026-09-17T16:00:00.000Z'))).toBe('2026-09-18')
  })
})

// The same `YYYY-MM-DD` on the text surfaces that do not go through formatFieldDisplay: group header / client
// export (dateTimeExportText) and a lookup of a `date` column (display + export).
describe('date-only text surfaces beyond the cell', () => {
  const field: MetaField = { id: 'due', name: 'Due', type: 'date' }

  it('a Date.parse-only spelling keeps its day as written instead of echoing the raw text', () => {
    expect(formatDateOnlyValue('9/18/2026 16:00')).toBe('2026-09-18')
  })

  it('group header / export text of a date cell is its YYYY-MM-DD, empty stays null', () => {
    expect(dateTimeExportText(field, '2026-09-17T16:00:00.000Z')).toBe('2026-09-18')
    expect(dateTimeExportText(field, '2026-09-18')).toBe('2026-09-18')
    expect(dateTimeExportText(field, '')).toBeNull()
    expect(dateTimeExportText(field, null)).toBeNull()
  })

  it('a lookup of a date column shows and exports the same YYYY-MM-DD as the column itself', () => {
    const lookup: MetaField = { id: 'lk_due', name: 'Due (lookup)', type: 'lookup', property: { foreignSheetId: 'sheet_x', targetFieldId: 'due' } }
    setLookupTargetFields({ lk_due: { type: 'date' } })
    try {
      expect(formatFieldDisplay({ field: lookup, value: ['2026-09-17T16:00:00.000Z', '2026-09-18', ''] })).toBe('2026-09-18, 2026-09-18')
      expect(dateTimeExportText(lookup, ['2026-09-17T16:00:00.000Z', '2026-09-18'])).toBe('2026-09-18; 2026-09-18')
      expect(formatFieldDisplay({ field: lookup, value: [] })).toBe('—')
    } finally {
      resetLookupTargetFields()
    }
  })
})
