import { describe, expect, it } from 'vitest'
import {
  fixedScheduleScopeForbiddenCopy,
  fixedScheduleWritesForCatalog,
  readFixedScheduleWrites,
} from '../src/views/attendance/attendanceFixedScheduleWrites'

const tr = (en: string) => en

describe('fixed schedule write grants', () => {
  it('opens writes only for the org catalog', () => {
    expect(fixedScheduleWritesForCatalog('org')).toEqual({ apply: true, rebuild: true, clear: true })
    expect(fixedScheduleWritesForCatalog('managed')).toEqual({ apply: false, rebuild: false, clear: false })
    expect(fixedScheduleWritesForCatalog('unknown')).toEqual({ apply: false, rebuild: false, clear: false })
  })

  it('reads only exact true grants and fails closed otherwise', () => {
    expect(readFixedScheduleWrites({ apply: true, rebuild: false, clear: true })).toEqual({
      apply: true,
      rebuild: false,
      clear: true,
    })
    expect(readFixedScheduleWrites({ apply: 'true' })).toEqual({ apply: false, rebuild: false, clear: false })
    expect(readFixedScheduleWrites(null)).toEqual({ apply: false, rebuild: false, clear: false })
  })

  it('maps scheduler-scope denial to preview-only copy', () => {
    expect(fixedScheduleScopeForbiddenCopy('apply', tr)).toBe(
      'Preview only. This account does not have permission to apply the fixed schedule.',
    )
    expect(fixedScheduleScopeForbiddenCopy('apply', tr)).not.toContain('Admin permissions required')
    expect(fixedScheduleScopeForbiddenCopy('rebuild', tr)).toContain('rebuild')
    expect(fixedScheduleScopeForbiddenCopy('clear', tr)).toContain('clear')
  })
})
