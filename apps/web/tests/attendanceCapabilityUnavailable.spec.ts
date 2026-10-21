import { describe, expect, it } from 'vitest'
import {
  buildAttendanceCapabilityUnavailableCopy,
  resolveAttendanceCapabilityInfo,
} from '../src/views/attendance/attendanceCapabilityUnavailable'

describe('resolveAttendanceCapabilityInfo', () => {
  it('resolves the admin tab to the attendanceAdmin flag', () => {
    expect(resolveAttendanceCapabilityInfo('admin')).toEqual({
      tab: 'admin',
      flagKey: 'attendanceAdmin',
      nameEn: 'Admin Center',
      nameZh: '管理中心',
    })
  })

  it('resolves the import tab to the SAME attendanceAdmin flag (import has no separate gate)', () => {
    expect(resolveAttendanceCapabilityInfo('import')).toEqual({
      tab: 'import',
      flagKey: 'attendanceAdmin',
      nameEn: 'Import',
      nameZh: '导入',
    })
  })

  it('resolves the workflow tab to the workflow flag', () => {
    expect(resolveAttendanceCapabilityInfo('workflow')).toEqual({
      tab: 'workflow',
      flagKey: 'workflow',
      nameEn: 'Workflow Designer',
      nameZh: '流程设计',
    })
  })

  it('returns null for tabs that never gate (overview/reports)', () => {
    expect(resolveAttendanceCapabilityInfo('overview')).toBeNull()
    expect(resolveAttendanceCapabilityInfo('reports')).toBeNull()
  })

  it('returns null for unknown/garbage input (enum-strict, no silent fallback)', () => {
    expect(resolveAttendanceCapabilityInfo('admin ')).toBeNull()
    expect(resolveAttendanceCapabilityInfo('')).toBeNull()
    expect(resolveAttendanceCapabilityInfo(undefined)).toBeNull()
    expect(resolveAttendanceCapabilityInfo(null)).toBeNull()
    expect(resolveAttendanceCapabilityInfo(42)).toBeNull()
  })
})

describe('buildAttendanceCapabilityUnavailableCopy', () => {
  const adminInfo = resolveAttendanceCapabilityInfo('admin')!
  const workflowInfo = resolveAttendanceCapabilityInfo('workflow')!

  it('names the capability in the English heading and detail', () => {
    const copy = buildAttendanceCapabilityUnavailableCopy(adminInfo, false)
    expect(copy.heading).toBe('Admin Center is not available')
    expect(copy.detail).toBe('The "Admin Center" capability is not enabled for this account or session.')
  })

  it('names the capability in the Chinese heading and detail', () => {
    const copy = buildAttendanceCapabilityUnavailableCopy(workflowInfo, true)
    expect(copy.heading).toBe('流程设计当前不可用')
    expect(copy.detail).toBe('此账号 / 当前会话未启用「流程设计」所需的能力。')
  })

  it('never leaks a raw org/user identifier into the copy (values-free)', () => {
    const copy = buildAttendanceCapabilityUnavailableCopy(adminInfo, false)
    expect(copy.heading + copy.detail).not.toMatch(/org[-_]?id|user[-_]?id/i)
  })
})
