import { describe, expect, it } from 'vitest'
import { presentRecordInstantClock, presentRecordReportCell } from '../src/views/attendance/recordReportPresentation'

describe('record report presentation', () => {
  it('formats an instant as HH:mm in the record timezone and leaves a missing zone alone', () => {
    expect(presentRecordInstantClock('2026-06-10T01:18:00.000Z', 'Asia/Shanghai')).toBe('09:18')
    expect(presentRecordInstantClock('2026-06-10T01:18:00.000Z', null)).toBeNull()
  })

  it('truncates a uuid and keeps the full value as the title', () => {
    const id = '00000000-0000-4000-8000-000000000abc'
    expect(presentRecordReportCell(id, null)).toEqual({ text: '00000000…', title: id })
    expect(presentRecordReportCell('--', 'Asia/Shanghai')).toEqual({ text: '--' })
  })
})