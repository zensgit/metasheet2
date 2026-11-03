import { describe, expect, it } from 'vitest'
import {
  decideAttendanceSelfServiceBackfill,
  parseAttendanceSelfServiceAdmissionRows,
  unavailableAttendanceSelfServiceAdmission,
} from '../../src/auth/attendanceSelfServiceBackfill'

const eligible = {
  supportsProductMode: true,
  role: 'user',
  permissions: ['spreadsheets:read'] as const,
}

describe('decideAttendanceSelfServiceBackfill', () => {
  it('bootstraps eligible never-revoked users with no attendance admission row', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: parseAttendanceSelfServiceAdmissionRows([]),
    })).toBe('bootstrap')
  })

  it('bootstraps when attendance admission is enabled and no attendance permission is present', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: parseAttendanceSelfServiceAdmissionRows([{
        enabled: true,
        source: 'seed_backfill',
      }]),
    })).toBe('bootstrap')
  })

  it('skips explicit disabled admission from role unassign', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: parseAttendanceSelfServiceAdmissionRows([{
        enabled: false,
        source: 'role_unassigned',
      }]),
    })).toBe('skip')
  })

  it('skips a blocked subject with disabled platform_admin admission', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: parseAttendanceSelfServiceAdmissionRows([{
        enabled: false,
        source: 'platform_admin',
      }]),
    })).toBe('skip')
  })

  it('skips role_unassigned even if enabled is still true', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: parseAttendanceSelfServiceAdmissionRows([{
        enabled: true,
        source: 'role_unassigned',
      }]),
    })).toBe('skip')
  })

  it('skips unread/unavailable admission instead of treating it as never-revoked', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      admission: unavailableAttendanceSelfServiceAdmission(),
    })).toBe('skip')
  })

  it('skips admin, product-mode off, and users who already have attendance permissions', () => {
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      supportsProductMode: false,
      admission: parseAttendanceSelfServiceAdmissionRows([]),
    })).toBe('skip')
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      role: 'admin',
      admission: parseAttendanceSelfServiceAdmissionRows([]),
    })).toBe('skip')
    expect(decideAttendanceSelfServiceBackfill({
      ...eligible,
      permissions: ['attendance:read'],
      admission: parseAttendanceSelfServiceAdmissionRows([]),
    })).toBe('skip')
  })
})
