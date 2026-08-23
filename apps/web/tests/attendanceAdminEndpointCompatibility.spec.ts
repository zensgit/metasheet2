import { describe, expect, it } from 'vitest'
import { isAttendanceAdminEndpointUnavailable } from '../src/views/attendance/attendanceAdminEndpointCompatibility'

describe('attendance admin endpoint compatibility', () => {
  it('does not treat a structured tenant-scope denial as an unavailable endpoint', () => {
    expect(isAttendanceAdminEndpointUnavailable(404, {
      ok: false,
      error: { code: 'USER_TARGET_NOT_FOUND' },
    })).toBe(false)
  })

  it('only permits compatibility handling for an unstructured 404', () => {
    expect(isAttendanceAdminEndpointUnavailable(404, null)).toBe(true)
    expect(isAttendanceAdminEndpointUnavailable(404, { message: 'Not Found' })).toBe(true)
    expect(isAttendanceAdminEndpointUnavailable(403, null)).toBe(false)
  })
})
