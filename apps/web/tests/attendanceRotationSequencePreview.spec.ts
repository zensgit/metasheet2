import { describe, expect, it } from 'vitest'
import {
  buildAttendanceRotationAssignmentCalendarMap,
  buildAttendanceRotationAssignmentPreview,
  buildAttendanceRotationSequencePreview,
  buildAttendanceShiftAssignmentCalendarMap,
  buildAttendanceShiftAssignmentPreview,
  parseAttendanceRotationSequenceInput,
} from '../src/views/attendance/attendanceRotationSequencePreview'

describe('attendance rotation sequence preview', () => {
  it('parses comma and newline separated shift references', () => {
    expect(parseAttendanceRotationSequenceInput(' shift-a,shift-b\nshift-c ,, ')).toEqual([
      'shift-a',
      'shift-b',
      'shift-c',
    ])
  })

  it('maps known shifts to ordered day preview rows', () => {
    const preview = buildAttendanceRotationSequencePreview('shift-a, shift-b, shift-a', [
      {
        id: 'shift-a',
        name: 'Day shift',
        workStartTime: '09:00',
        workEndTime: '18:00',
        isOvernight: false,
      },
      {
        id: 'shift-b',
        name: 'Night shift',
        workStartTime: '22:00',
        workEndTime: '06:00',
        isOvernight: true,
      },
    ])

    expect(preview.missingRefs).toEqual([])
    expect(preview.items).toEqual([
      expect.objectContaining({
        dayIndex: 1,
        shiftRef: 'shift-a',
        label: 'Day shift (shift-a)',
        schedule: '09:00 -> 18:00',
        isKnown: true,
        isOvernight: false,
      }),
      expect.objectContaining({
        dayIndex: 2,
        shiftRef: 'shift-b',
        label: 'Night shift (shift-b)',
        schedule: '22:00 -> 06:00',
        isKnown: true,
        isOvernight: true,
      }),
      expect.objectContaining({
        dayIndex: 3,
        shiftRef: 'shift-a',
      }),
    ])
  })

  it('reports missing references once when the shift catalog is loaded', () => {
    const preview = buildAttendanceRotationSequencePreview('shift-a, missing-shift, missing-shift', [
      {
        id: 'shift-a',
        name: 'Day shift',
        workStartTime: '09:00',
        workEndTime: '18:00',
      },
    ])

    expect(preview.missingRefs).toEqual(['missing-shift'])
    expect(preview.items[1]).toMatchObject({
      dayIndex: 2,
      shiftRef: 'missing-shift',
      label: 'missing-shift',
      schedule: '',
      isKnown: false,
      isOvernight: false,
    })
  })

  it('does not call refs missing until a shift catalog is available', () => {
    const preview = buildAttendanceRotationSequencePreview('legacy-shift-name', [])

    expect(preview.missingRefs).toEqual([])
    expect(preview.items).toEqual([
      expect.objectContaining({
        dayIndex: 1,
        shiftRef: 'legacy-shift-name',
        isKnown: false,
      }),
    ])
  })

  it('projects a selected rotation rule across the assignment date window', () => {
    const preview = buildAttendanceRotationAssignmentPreview({
      rotationRuleId: 'rot-1',
      rotationRules: [
        {
          id: 'rot-1',
          name: 'Two shift',
          shiftSequence: ['shift-a', 'shift-b'],
        },
      ],
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
        {
          id: 'shift-b',
          name: 'Night shift',
          workStartTime: '22:00',
          workEndTime: '06:00',
          isOvernight: true,
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-04',
    })

    expect(preview.ruleName).toBe('Two shift')
    expect(preview.projectedDays).toBe(4)
    expect(preview.isTruncated).toBe(false)
    expect(preview.items.map(item => [item.date, item.dayIndex, item.shiftRef, item.label])).toEqual([
      ['2026-03-01', 1, 'shift-a', 'Day shift (shift-a)'],
      ['2026-03-02', 2, 'shift-b', 'Night shift (shift-b)'],
      ['2026-03-03', 3, 'shift-a', 'Day shift (shift-a)'],
      ['2026-03-04', 4, 'shift-b', 'Night shift (shift-b)'],
    ])
    expect(preview.items[1]?.isOvernight).toBe(true)
  })

  it('caps open-ended rotation assignment previews and reports missing shift refs once', () => {
    const preview = buildAttendanceRotationAssignmentPreview({
      rotationRuleId: 'rot-1',
      rotationRules: [
        {
          id: 'rot-1',
          name: 'Legacy rotation',
          shiftSequence: ['shift-a', 'missing-shift'],
        },
      ],
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
      ],
      startDate: '2026-03-01',
      endDate: null,
      maxDays: 3,
    })

    expect(preview.projectedDays).toBe(3)
    expect(preview.isTruncated).toBe(false)
    expect(preview.missingRefs).toEqual(['missing-shift'])
    expect(preview.items.map(item => [item.date, item.shiftRef, item.isKnown])).toEqual([
      ['2026-03-01', 'shift-a', true],
      ['2026-03-02', 'missing-shift', false],
      ['2026-03-03', 'shift-a', true],
    ])
  })

  it('marks long closed assignment previews as truncated', () => {
    const preview = buildAttendanceRotationAssignmentPreview({
      rotationRuleId: 'rot-1',
      rotationRules: [
        {
          id: 'rot-1',
          name: 'Long rotation',
          shiftSequence: ['shift-a'],
        },
      ],
      shifts: [],
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      maxDays: 4,
    })

    expect(preview.projectedDays).toBe(10)
    expect(preview.items).toHaveLength(4)
    expect(preview.isTruncated).toBe(true)
  })

  it('attaches effective-calendar context by preview date without changing row order', () => {
    const calendarByDate = buildAttendanceRotationAssignmentCalendarMap([
      {
        date: '2026-03-02',
        isWorkingDay: false,
        label: 'Org rest override',
        source: 'org',
        sourceClass: 'calendar-source--org',
        tooltip: '2026-03-02 — Rest day · org',
        hasOverride: true,
      },
      {
        date: 'invalid-date',
        label: 'ignored',
      },
    ])
    const preview = buildAttendanceRotationAssignmentPreview({
      rotationRuleId: 'rot-1',
      rotationRules: [
        {
          id: 'rot-1',
          name: 'Two shift',
          shiftSequence: ['shift-a', 'shift-b'],
        },
      ],
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
        {
          id: 'shift-b',
          name: 'Night shift',
          workStartTime: '22:00',
          workEndTime: '06:00',
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      calendarByDate,
    })

    expect(preview.items.map(item => item.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    expect(preview.items[0]?.calendar).toBeUndefined()
    expect(preview.items[1]?.calendar).toMatchObject({
      label: 'Org rest override',
      source: 'org',
      sourceClass: 'calendar-source--org',
      hasOverride: true,
    })
  })

  it('projects a fixed shift assignment across the assignment date window', () => {
    const preview = buildAttendanceShiftAssignmentPreview({
      shiftId: 'shift-a',
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-03',
    })

    expect(preview.shiftName).toBe('Day shift')
    expect(preview.projectedDays).toBe(3)
    expect(preview.isTruncated).toBe(false)
    expect(preview.missingShiftId).toBeNull()
    expect(preview.items.map(item => [item.date, item.dayIndex, item.shiftId, item.label, item.schedule])).toEqual([
      ['2026-03-01', 1, 'shift-a', 'Day shift (shift-a)', '09:00 -> 18:00'],
      ['2026-03-02', 2, 'shift-a', 'Day shift (shift-a)', '09:00 -> 18:00'],
      ['2026-03-03', 3, 'shift-a', 'Day shift (shift-a)', '09:00 -> 18:00'],
    ])
  })

  it('caps fixed shift assignment previews and reports missing loaded shift refs', () => {
    const preview = buildAttendanceShiftAssignmentPreview({
      shiftId: 'legacy-shift',
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      maxDays: 2,
    })

    expect(preview.projectedDays).toBe(10)
    expect(preview.items).toHaveLength(2)
    expect(preview.isTruncated).toBe(true)
    expect(preview.missingShiftId).toBe('legacy-shift')
    expect(preview.items.map(item => [item.date, item.isKnown, item.label])).toEqual([
      ['2026-03-01', false, 'legacy-shift'],
      ['2026-03-02', false, 'legacy-shift'],
    ])
  })

  it('attaches effective-calendar context to fixed shift assignment rows', () => {
    const calendarByDate = buildAttendanceShiftAssignmentCalendarMap([
      {
        date: '2026-03-02',
        isWorkingDay: false,
        label: 'Manual rest day',
        source: 'manual',
        sourceClass: 'calendar-source--manual',
        tooltip: '2026-03-02 — Rest day · manual',
        hasOverride: true,
      },
    ])
    const preview = buildAttendanceShiftAssignmentPreview({
      shiftId: 'shift-a',
      shifts: [
        {
          id: 'shift-a',
          name: 'Day shift',
          workStartTime: '09:00',
          workEndTime: '18:00',
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      calendarByDate,
    })

    expect(preview.items.map(item => item.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    expect(preview.items[0]?.calendar).toBeUndefined()
    expect(preview.items[1]?.calendar).toMatchObject({
      label: 'Manual rest day',
      source: 'manual',
      sourceClass: 'calendar-source--manual',
      hasOverride: true,
    })
  })
})
