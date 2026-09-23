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
  appendAttendanceExportNotice: (csv: string, input: {
    matchedTotal: number
    returned: number
    limit: number
    truncated: boolean
    status: string
  }) => string
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
    const csv = disclosure.appendAttendanceExportNotice('work_date,status\n2026-04-01,late', capped)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('work_date,status')
    expect(lines[1]).toBe('2026-04-01,late')
    expect(lines[2]).toBe('# META attendance_export returned=5000 total=6200 limit=5000 truncated=true status=late')
  })
})
