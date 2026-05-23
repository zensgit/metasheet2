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

  it('requires a base rest start date before generating longer group holiday length', () => {
    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '长假班组',
      baseRestDays: 3,
      targetRestDays: 5,
    })).toEqual({ kind: 'unsupported', reason: 'missing_base_rest_start_date' })
  })

  it('creates a date-range rest exception for longer group holiday length', () => {
    const result = buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '长假班组',
      baseRestDays: 3,
      targetRestDays: 5,
      baseRestStartDate: '2026-10-01',
      localizedExtraRestLabel: '国庆延休',
    })

    expect(result).toEqual({
      kind: 'append',
      form: expect.objectContaining({
        name: '',
        match: 'contains',
        date: '',
        from: '2026-10-04',
        to: '2026-10-05',
        dayIndexStart: null,
        dayIndexEnd: null,
        dayIndexList: '',
        source: 'group',
        isWorkingDay: false,
        attendanceGroups: '长假班组',
        label: '国庆延休',
      }),
    })
    if (result.kind !== 'append') throw new Error('expected append result')
    const [wire] = calendarPolicyOverridesFromForm([result.form])
    expect(wire).toMatchObject({
      from: '2026-10-04',
      to: '2026-10-05',
      filters: { attendanceGroups: ['长假班组'] },
      effective: {
        isWorkingDay: false,
        label: '国庆延休',
        source: 'group',
      },
    })
    expect(wire?.name).toBeUndefined()
    expect(wire?.match).toBeUndefined()
    expect(wire?.dayIndexStart).toBeUndefined()
    expect(wire?.dayIndexEnd).toBeUndefined()
    expect(wire?.dayIndexList).toEqual([])
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

    expect(buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '长假班组',
      baseRestDays: 3,
      targetRestDays: 5,
      baseRestStartDate: '2026-02-30',
    })).toEqual({ kind: 'unsupported', reason: 'invalid_input' })
  })

  it('keeps diagnostics behavior for generated and manually incomplete group rows', () => {
    const shorterResult = buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '短假班组',
      baseRestDays: 5,
      targetRestDays: 3,
    })
    if (shorterResult.kind !== 'append') throw new Error('expected append result')
    const longerResult = buildHolidayLengthCalendarPolicyOverride({
      holidayName: '国庆',
      attendanceGroup: '长假班组',
      baseRestDays: 3,
      targetRestDays: 5,
      baseRestStartDate: '2026-10-01',
    })
    if (longerResult.kind !== 'append') throw new Error('expected append result')

    const diagnostics = buildCalendarPolicyOverrideDiagnostics([
      shorterResult.form,
      longerResult.form,
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
        primaryIndex: 2,
        source: 'group',
      }),
    ])
  })
})
