import { describe, expect, it } from 'vitest'
import {
  buildAttendanceScheduleConflictDiagnostics,
  formatAttendanceScheduleConflictDiagnostic,
} from '../src/views/attendance/attendanceScheduleConflictDiagnostics'

describe('attendance schedule conflict diagnostics', () => {
  it('detects overlapping shift assignments for the same user', () => {
    const diagnostics = buildAttendanceScheduleConflictDiagnostics({
      assignments: [
        {
          assignment: {
            id: 'assignment-1',
            userId: 'user-1',
            shiftId: 'shift-day',
            startDate: '2026-06-01',
            endDate: '2026-06-10',
            isActive: true,
          },
          shift: { id: 'shift-day', name: 'Day shift' },
        },
        {
          assignment: {
            id: 'assignment-2',
            userId: 'user-1',
            shiftId: 'shift-night',
            startDate: '2026-06-05',
            endDate: null,
            isActive: true,
          },
          shift: { id: 'shift-night', name: 'Night shift' },
        },
      ],
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'shift_assignment_overlap',
        userId: 'user-1',
        primaryLabel: 'Day shift',
        secondaryLabel: 'Night shift',
        overlapStart: '2026-06-05',
        overlapEnd: '2026-06-10',
      }),
    ])
  })

  it('detects overlapping rotation assignments for the same user', () => {
    const diagnostics = buildAttendanceScheduleConflictDiagnostics({
      rotationAssignments: [
        {
          assignment: {
            id: 'rotation-assignment-1',
            userId: 'user-1',
            rotationRuleId: 'rot-a',
            startDate: '2026-06-01',
            endDate: null,
            isActive: true,
          },
          rotation: { id: 'rot-a', name: 'Two shift' },
        },
        {
          assignment: {
            id: 'rotation-assignment-2',
            userId: 'user-1',
            rotationRuleId: 'rot-b',
            startDate: '2026-06-03',
            endDate: '2026-06-12',
            isActive: true,
          },
          rotation: { id: 'rot-b', name: 'Weekend rotation' },
        },
      ],
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'rotation_assignment_overlap',
        primaryLabel: 'Two shift',
        secondaryLabel: 'Weekend rotation',
        overlapStart: '2026-06-03',
        overlapEnd: '2026-06-12',
      }),
    ])
  })

  it('reports that rotation assignments override overlapping fixed shift assignments', () => {
    const diagnostics = buildAttendanceScheduleConflictDiagnostics({
      assignments: [
        {
          assignment: {
            id: 'assignment-1',
            userId: 'user-1',
            shiftId: 'shift-day',
            startDate: '2026-06-01',
            endDate: null,
            isActive: true,
          },
          shift: { id: 'shift-day', name: 'Day shift' },
        },
      ],
      rotationAssignments: [
        {
          assignment: {
            id: 'rotation-assignment-1',
            userId: 'user-1',
            rotationRuleId: 'rot-a',
            startDate: '2026-06-05',
            endDate: null,
            isActive: true,
          },
          rotation: { id: 'rot-a', name: 'Two shift' },
        },
      ],
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'rotation_overrides_shift',
        primaryLabel: 'Day shift',
        secondaryLabel: 'Two shift',
        overlapStart: '2026-06-05',
        overlapEnd: null,
      }),
    ])
    expect(formatAttendanceScheduleConflictDiagnostic(diagnostics[0]!, (en) => en)).toContain('rotation wins')
  })

  it('includes valid drafts and ignores inactive or invalid rows', () => {
    const diagnostics = buildAttendanceScheduleConflictDiagnostics({
      assignments: [
        {
          assignment: {
            id: 'assignment-1',
            userId: 'user-1',
            shiftId: 'shift-day',
            startDate: '2026-06-01',
            endDate: '2026-06-10',
            isActive: true,
          },
          shift: { id: 'shift-day', name: 'Day shift' },
        },
        {
          assignment: {
            id: 'assignment-inactive',
            userId: 'user-1',
            shiftId: 'shift-off',
            startDate: '2026-06-01',
            endDate: '2026-06-10',
            isActive: false,
          },
          shift: { id: 'shift-off', name: 'Inactive shift' },
        },
      ],
      assignmentDraft: {
        id: null,
        userId: 'user-1',
        refId: 'shift-draft',
        refLabel: 'Draft shift',
        startDate: '2026-06-03',
        endDate: '',
        isActive: true,
      },
      rotationAssignmentDraft: {
        id: null,
        userId: 'user-1',
        refId: 'rot-invalid',
        refLabel: 'Invalid rotation',
        startDate: '2026-06-12',
        endDate: '2026-06-01',
        isActive: true,
      },
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      code: 'shift_assignment_overlap',
      primaryLabel: 'Day shift',
      secondaryLabel: 'Draft shift',
    })
  })
})
