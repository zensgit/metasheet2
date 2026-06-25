import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceBonusPolicyForTests as {
  normalizeAttendanceBonusPolicySetting: (raw: unknown) => {
    enabled: boolean
    anyLeaveBreaksFullAttendance: boolean
    lateBeyondThresholdBreaksFullAttendance: boolean
  }
}

describe('#加班银行 v1-3a — AttendanceBonusPolicy normalizer (LATENT, 满勤)', () => {
  const norm = helpers.normalizeAttendanceBonusPolicySetting

  it('default dormant: OFF, but the 满勤-breaking toggles default ON (§3 口径)', () => {
    const d = { enabled: false, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true }
    expect(norm(undefined)).toEqual(d)
    expect(norm({})).toEqual(d)
    expect(norm('x')).toEqual(d)
  })

  it('toggles are settable; a customer can relax late-breaks but keep leave-breaks', () => {
    expect(norm({ enabled: true, lateBeyondThresholdBreaksFullAttendance: false })).toEqual({
      enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: false,
    })
    expect(norm({ enabled: true, anyLeaveBreaksFullAttendance: false })).toEqual({
      enabled: true, anyLeaveBreaksFullAttendance: false, lateBeyondThresholdBreaksFullAttendance: true,
    })
  })
})
