import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const disclosure = require('../../../../plugins/plugin-attendance/lib/attendance-export-disclosure.cjs') as {
  ATTENDANCE_EXPORT_MAX_ROWS: number
  resolveAttendanceExportLimit: (raw: unknown) => number
  normalizeAttendanceExportStatus: (raw: unknown) => { ok: boolean; value: string | null; message?: string }
  buildAttendanceExportDisclosure: (input: {
    matchedTotal: number
    returned: number
    limit: number
    status?: string | null
  }) => { matchedTotal: number; returned: number; limit: number; truncated: boolean; status: string }
  applyAttendanceExportDisclosureHeaders: (res: { setHeader: (name: string, value: string) => void }, disclosure: {
    matchedTotal: number
    returned: number
    limit: number
    truncated: boolean
    status: string
  }) => void
}

describe('attendance export disclosure', () => {
  it('uses the 5000 cap when limit is omitted and clamps anything above it', () => {
    expect(disclosure.ATTENDANCE_EXPORT_MAX_ROWS).toBe(5000)
    expect(disclosure.resolveAttendanceExportLimit(undefined)).toBe(5000)
    expect(disclosure.resolveAttendanceExportLimit('')).toBe(5000)
    expect(disclosure.resolveAttendanceExportLimit('9000')).toBe(5000)
    expect(disclosure.resolveAttendanceExportLimit('0')).toBe(1)
    expect(disclosure.resolveAttendanceExportLimit('1200')).toBe(1200)
  })

  it('accepts a status token and rejects anything else', () => {
    expect(disclosure.normalizeAttendanceExportStatus(undefined)).toEqual({ ok: true, value: null })
    expect(disclosure.normalizeAttendanceExportStatus(' ALL ')).toEqual({ ok: true, value: null })
    expect(disclosure.normalizeAttendanceExportStatus('Late')).toEqual({ ok: true, value: 'late' })
    expect(disclosure.normalizeAttendanceExportStatus('late;drop').ok).toBe(false)
    expect(disclosure.normalizeAttendanceExportStatus('late early').ok).toBe(false)
  })

  it('marks truncation only when matched rows exceed the rows written', () => {
    expect(disclosure.buildAttendanceExportDisclosure({
      matchedTotal: 1200,
      returned: 1200,
      limit: 5000,
      status: null,
    })).toMatchObject({ truncated: false, status: 'all', matchedTotal: 1200, returned: 1200 })

    const capped = disclosure.buildAttendanceExportDisclosure({
      matchedTotal: 6200,
      returned: 5000,
      limit: 5000,
      status: 'late',
    })
    expect(capped).toMatchObject({
      truncated: true,
      matchedTotal: 6200,
      returned: 5000,
      limit: 5000,
      status: 'late',
    })
    const headers = new Map<string, string>()
    disclosure.applyAttendanceExportDisclosureHeaders({
      setHeader(name: string, value: string) {
        headers.set(name, value)
      },
    }, capped)
    expect(headers.get('X-Attendance-Export-Total')).toBe('6200')
    expect(headers.get('X-Attendance-Export-Returned')).toBe('5000')
    expect(headers.get('X-Attendance-Export-Limit')).toBe('5000')
    expect(headers.get('X-Attendance-Export-Truncated')).toBe('true')
    expect(headers.get('X-Attendance-Export-Status')).toBe('late')
    expect(disclosure).not.toHaveProperty('appendAttendanceExportNotice')
  })
})
