import { describe, expect, it } from 'vitest'
import {
  buildHolidayLengthCalendarPolicyOverride,
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

describe('attendance calendar policy holiday length quick add', () => {
  it('creates a group-scoped workday exception for shorter group holiday length', () => {
    const result = buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '短假班组',
      baseRestDays: 5,
      targetRestDays: 3,
      localizedDefaultLabel: '国庆调班',
    })

    expect(result).toEqual({
      kind: 'append',
      form: expect.objectContaining({
        name: '国庆',
        match: 'contains',
        dayIndexStart: 4,
        dayIndexEnd: 5,
        source: 'group',
        isWorkingDay: true,
        attendanceGroups: '短假班组',
        label: '国庆调班',
      }),
    })
    if (result.kind !== 'append') throw new Error('expected append result')
    expect(calendarPolicyOverridesFromForm([result.form])).toEqual([
      expect.objectContaining({
        name: '国庆',
        match: 'contains',
        dayIndexStart: 4,
        dayIndexEnd: 5,
        filters: { attendanceGroups: ['短假班组'] },
        effective: {
          isWorkingDay: true,
          label: '国庆调班',
          source: 'group',
        },
      }),
    ])
  })

  it('returns a no-op when target rest length equals the base length', () => {
    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '常规班组',
      baseRestDays: 5,
      targetRestDays: 5,
    })).toEqual({ kind: 'noop', reason: 'same_length' })
  })

  it('does not generate longer-than-base holiday spans automatically', () => {
    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '长假班组',
      baseRestDays: 3,
      targetRestDays: 5,
    })).toEqual({ kind: 'unsupported', reason: 'target_longer_than_base' })
  })

  it('rejects invalid quick-add inputs', () => {
    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '',
      attendanceGroup: '短假班组',
      baseRestDays: 5,
      targetRestDays: 3,
    })).toEqual({ kind: 'unsupported', reason: 'invalid_input' })

    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '',
      baseRestDays: 5,
      targetRestDays: 3,
    })).toEqual({ kind: 'unsupported', reason: 'invalid_input' })

    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '短假班组',
      baseRestDays: 5.5,
      targetRestDays: 3,
    })).toEqual({ kind: 'unsupported', reason: 'invalid_input' })
  })

  it('keeps diagnostics behavior for generated and manually incomplete group rows', () => {
    const result = buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '短假班组',
      baseRestDays: 5,
      targetRestDays: 3,
    })
    if (result.kind !== 'append') throw new Error('expected append result')

    const diagnostics = buildCalendarPolicyOverrideDiagnostics([
      result.form,
      overrideForm({
        source: 'group',
        attendanceGroups: '',
        dayIndexStart: 4,
        dayIndexEnd: 5,
        isWorkingDay: true,
        label: 'Bare group row',
      }),
    ])

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'missing_scope',
        primaryIndex: 1,
        source: 'group',
      }),
    ])
  })
})
