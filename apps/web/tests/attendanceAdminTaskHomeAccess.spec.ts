import { describe, expect, it } from 'vitest'
import {
  attendanceGroupEmptyListCopy,
  filterAdminTaskHomeGroupsForCatalogScope,
  resolveAttendanceGroupCatalogScope,
} from '../src/views/attendance/attendanceAdminTaskHomeAccess'

const FOUR_GROUPS = [
  {
    key: 'daily-operations',
    actions: [{ key: 'daily-import' }, { key: 'audit-follow-up' }],
  },
  {
    key: 'people-groups',
    actions: [
      { key: 'setup-readiness' },
      { key: 'attendance-groups' },
      { key: 'user-access' },
      { key: 'team-availability' },
    ],
  },
  {
    key: 'work-time-policies',
    actions: [{ key: 'shifts' }],
  },
  {
    key: 'reporting-payroll',
    actions: [{ key: 'payroll-cycles' }],
  },
]

describe('attendanceAdminTaskHomeAccess', () => {
  it('treats unrecognized catalog scope as unknown (fail-closed, not org)', () => {
    expect(resolveAttendanceGroupCatalogScope('org')).toBe('org')
    expect(resolveAttendanceGroupCatalogScope('managed')).toBe('managed')
    expect(resolveAttendanceGroupCatalogScope('unknown')).toBe('unknown')
    expect(resolveAttendanceGroupCatalogScope('admin')).toBe('unknown')
    expect(resolveAttendanceGroupCatalogScope(undefined)).toBe('unknown')
  })

  it('keeps the four-group catalog for org and unknown viewers', () => {
    expect(filterAdminTaskHomeGroupsForCatalogScope(FOUR_GROUPS, 'org').map((group) => group.key))
      .toEqual(['daily-operations', 'people-groups', 'work-time-policies', 'reporting-payroll'])
    expect(filterAdminTaskHomeGroupsForCatalogScope(FOUR_GROUPS, 'unknown').map((group) => group.key))
      .toEqual(['daily-operations', 'people-groups', 'work-time-policies', 'reporting-payroll'])
  })

  it('keeps only people-groups attendance-groups + availability for managed viewers', () => {
    const filtered = filterAdminTaskHomeGroupsForCatalogScope(FOUR_GROUPS, 'managed')
    expect(filtered.map((group) => group.key)).toEqual(['people-groups'])
    expect(filtered[0]?.actions.map((action) => action.key)).toEqual([
      'attendance-groups',
      'team-availability',
    ])
    expect(filtered.some((group) => group.actions.some((action) => action.key === 'setup-readiness'))).toBe(false)
    expect(filtered.some((group) => group.actions.some((action) => action.key === 'daily-import'))).toBe(false)
  })

  it('distinguishes managed empty copy from org-has-no-groups copy', () => {
    const tr = (en: string) => en
    expect(attendanceGroupEmptyListCopy('managed', tr)).toBe('You are not the owner of any attendance group.')
    expect(attendanceGroupEmptyListCopy('org', tr)).toBe(
      'No attendance groups yet. Create one to start configuring members.',
    )
    expect(attendanceGroupEmptyListCopy('unknown', tr)).toBe(
      'No attendance groups yet. Create one to start configuring members.',
    )
    expect(attendanceGroupEmptyListCopy('managed', tr)).not.toBe(
      attendanceGroupEmptyListCopy('org', tr),
    )
  })
})
