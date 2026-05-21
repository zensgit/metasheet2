import { describe, expect, it } from 'vitest'
import {
  buildCalendarPolicyOverrideDiagnostics,
  calendarPolicyOverridesFromForm,
  type CalendarPolicyOverrideFormState,
} from '../src/views/attendance/attendanceCalendarPolicyOverrides'

function overrideForm(overrides: Partial<CalendarPolicyOverrideFormState> = {}): CalendarPolicyOverrideFormState {
  return {
    name: '',
    match: 'contains',
    date: '',
    from: '2026-10-01',
    to: '2026-10-07',
    dayIndexStart: null,
    dayIndexEnd: null,
    dayIndexList: '',
    source: 'org',
    isWorkingDay: false,
    label: '',
    attendanceGroups: '',
    roles: '',
    roleTags: '',
    userIds: '',
    userNames: '',
    excludeUserIds: '',
    excludeUserNames: '',
    ...overrides,
  }
}

describe('attendance calendar policy override diagnostics', () => {
  it('warns when a scoped override would be dropped by save normalization', () => {
    const diagnostics = buildCalendarPolicyOverrideDiagnostics([
      overrideForm({ source: 'role', roles: '', roleTags: '', label: 'Role rest day' }),
    ])

    expect(calendarPolicyOverridesFromForm([
      overrideForm({ source: 'role', roles: '', roleTags: '', label: 'Role rest day' }),
    ])).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'missing_scope',
        primaryIndex: 0,
        source: 'role',
      }),
    ])
  })

  it('warns when a date range is inverted', () => {
    expect(buildCalendarPolicyOverrideDiagnostics([
      overrideForm({ from: '2026-10-07', to: '2026-10-01' }),
    ])).toEqual([
      expect.objectContaining({
        code: 'invalid_date_range',
        primaryIndex: 0,
      }),
    ])
  })

  it('warns when a later same-source rule shadows an earlier overlapping target', () => {
    const diagnostics = buildCalendarPolicyOverrideDiagnostics([
      overrideForm({
        source: 'group',
        attendanceGroups: 'day-shift',
        from: '2026-10-01',
        to: '2026-10-07',
        isWorkingDay: false,
        label: 'Rest',
      }),
      overrideForm({
        source: 'group',
        attendanceGroups: 'day-shift',
        from: '2026-10-03',
        to: '2026-10-04',
        isWorkingDay: true,
        label: 'Make-up',
      }),
    ])

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'shadowed_same_source',
        primaryIndex: 0,
        secondaryIndex: 1,
        source: 'group',
      }),
    ])
  })

  it('does not warn for non-overlapping or equivalent same-source rules', () => {
    const diagnostics = buildCalendarPolicyOverrideDiagnostics([
      overrideForm({
        source: 'group',
        attendanceGroups: 'day-shift',
        from: '2026-10-01',
        to: '2026-10-02',
        isWorkingDay: false,
        label: 'Rest',
      }),
      overrideForm({
        source: 'group',
        attendanceGroups: 'day-shift',
        from: '2026-10-03',
        to: '2026-10-04',
        isWorkingDay: true,
        label: 'Make-up',
      }),
      overrideForm({
        source: 'group',
        attendanceGroups: 'night-shift',
        from: '2026-10-01',
        to: '2026-10-02',
        isWorkingDay: true,
        label: 'Make-up',
      }),
      overrideForm({
        source: 'group',
        attendanceGroups: 'day-shift',
        from: '2026-10-01',
        to: '2026-10-02',
        isWorkingDay: false,
        label: 'Rest',
      }),
    ])

    expect(diagnostics).toEqual([])
  })
})
