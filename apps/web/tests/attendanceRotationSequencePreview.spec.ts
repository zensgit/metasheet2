import { describe, expect, it } from 'vitest'
import {
  buildAttendanceRotationSequencePreview,
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
})
