import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance scheduling assignment conflict guard', () => {
  it('detects same-kind and cross-kind active assignment overlaps', async () => {
    const sameKindDb = {
      query: vi.fn().mockResolvedValueOnce([
        {
          id: 'shift-existing',
          kind: 'shift',
          start_date: '2026-06-01',
          end_date: '2026-06-10',
        },
      ]),
    }

    const sameKindConflict = await helpers.findAttendanceScheduleAssignmentConflict(sameKindDb, {
      kind: 'shift',
      orgId: 'org-a',
      userId: 'user-a',
      startDate: '2026-06-10',
      endDate: '2026-06-12',
      isActive: true,
    })

    expect(sameKindConflict?.conflictType).toBe('shift_assignment_overlap')
    expect(sameKindConflict?.existingKind).toBe('shift')
    expect(helpers.getAttendanceScheduleAssignmentConflictMessage(sameKindConflict)).toMatch(/shift assignment/i)
    expect(String(sameKindDb.query.mock.calls[0]?.[0] || '')).toContain('attendance_shift_assignments')

    const crossKindDb = {
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'rotation-existing',
            kind: 'rotation',
            start_date: '2026-06-11',
            end_date: null,
          },
        ]),
    }

    const crossKindConflict = await helpers.findAttendanceScheduleAssignmentConflict(crossKindDb, {
      kind: 'shift',
      orgId: 'org-a',
      userId: 'user-a',
      startDate: '2026-06-10',
      endDate: null,
      isActive: true,
      excludeId: 'shift-current',
    })

    expect(crossKindConflict?.conflictType).toBe('rotation_overrides_shift')
    expect(crossKindConflict?.draftKind).toBe('shift')
    expect(crossKindConflict?.existingKind).toBe('rotation')
    expect(crossKindConflict?.existingEndDate).toBeNull()
    expect(String(crossKindDb.query.mock.calls[0]?.[0] || '')).toContain('id <> $5')
    expect(String(crossKindDb.query.mock.calls[1]?.[0] || '')).toContain('attendance_rotation_assignments')
  })

  it('skips inactive drafts before querying for conflicts', async () => {
    const db = { query: vi.fn() }

    const conflict = await helpers.findAttendanceScheduleAssignmentConflict(db, {
      kind: 'rotation',
      orgId: 'org-a',
      userId: 'user-a',
      startDate: '2026-06-10',
      endDate: null,
      isActive: false,
    })

    expect(conflict).toBeNull()
    expect(db.query).not.toHaveBeenCalled()
  })

  it('preserves explicit null endDate on update payloads', () => {
    expect(helpers.resolveAttendanceScheduleAssignmentUpdateEndDate({}, '2026-06-10')).toBe('2026-06-10')
    expect(helpers.resolveAttendanceScheduleAssignmentUpdateEndDate({ endDate: null }, '2026-06-10')).toBeNull()
    expect(helpers.resolveAttendanceScheduleAssignmentUpdateEndDate({ endDate: '' }, '2026-06-10')).toBeNull()
    expect(helpers.resolveAttendanceScheduleAssignmentUpdateEndDate({ endDate: '2026-06-20' }, '2026-06-10')).toBe('2026-06-20')
  })

  it('takes a per-org/user advisory lock before transactional writes', async () => {
    const db = { query: vi.fn().mockResolvedValue([]) }

    await helpers.acquireAttendanceScheduleAssignmentLock(db, 'org-a', 'user-a')

    expect(db.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
      ['attendance-schedule:org-a', 'user-a'],
    )
  })

  it('keeps frontend diagnostic conflict type names stable', () => {
    expect(helpers.getAttendanceScheduleAssignmentConflictType('shift', 'shift')).toBe('shift_assignment_overlap')
    expect(helpers.getAttendanceScheduleAssignmentConflictType('rotation', 'rotation')).toBe('rotation_assignment_overlap')
    expect(helpers.getAttendanceScheduleAssignmentConflictType('rotation', 'shift')).toBe('rotation_overrides_shift')
    expect(helpers.getAttendanceScheduleAssignmentConflictType('shift', 'rotation')).toBe('rotation_overrides_shift')
  })

  it('builds fixed-schedule group previews from the complete member set without writes', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([
          {
            id: 'group-a',
            org_id: 'org-a',
            name: 'Operations',
            code: 'ops',
            timezone: 'Asia/Shanghai',
            rule_set_id: null,
            description: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'shift-a',
            org_id: 'org-a',
            name: 'Day shift',
            timezone: 'Asia/Shanghai',
            work_start_time: '09:00',
            work_end_time: '18:00',
            late_grace_minutes: 10,
            early_grace_minutes: 5,
            rounding_minutes: 5,
            working_days: [1, 2, 3, 4, 5],
          },
        ])
        .mockResolvedValueOnce([
          { user_id: 'user-create' },
          { user_id: 'user-skip' },
          { user_id: 'user-shift-conflict' },
          { user_id: 'user-rotation-conflict' },
        ])
        .mockResolvedValueOnce([
          {
            id: 'assignment-skip',
            user_id: 'user-skip',
            shift_id: 'shift-a',
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            kind: 'shift',
          },
          {
            id: 'assignment-conflict',
            user_id: 'user-shift-conflict',
            shift_id: 'shift-b',
            start_date: '2026-06-10',
            end_date: '2026-06-20',
            kind: 'shift',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'rotation-conflict',
            user_id: 'user-rotation-conflict',
            rotation_rule_id: 'rotation-a',
            start_date: '2026-06-01',
            end_date: null,
            kind: 'rotation',
          },
        ]),
    }

    const preview = await helpers.buildAttendanceGroupFixedSchedulePreview(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(preview.ok).toBe(true)
    expect(preview.data.target).toEqual({
      total: 4,
      userIds: ['user-create', 'user-skip', 'user-shift-conflict', 'user-rotation-conflict'],
    })
    expect(preview.data.wouldCreate).toEqual([
      {
        userId: 'user-create',
        shiftId: 'shift-a',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        isActive: true,
      },
    ])
    expect(preview.data.skipped).toEqual([
      {
        assignmentId: 'assignment-skip',
        userId: 'user-skip',
        shiftId: 'shift-a',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
    ])
    expect(preview.data.blockingConflicts.map((item: any) => item.userId)).toEqual([
      'user-shift-conflict',
      'user-rotation-conflict',
    ])
    expect(preview.data.blockingConflicts.map((item: any) => item.conflictType)).toEqual([
      'shift_assignment_overlap',
      'rotation_overrides_shift',
    ])

    const queries = db.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(queries).toContain('attendance_group_members')
    expect(queries).toContain('attendance_shift_assignments')
    expect(queries).toContain('attendance_rotation_assignments')
    expect(queries).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
  })

  it('rejects fixed-schedule group previews for empty groups', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }])
        .mockResolvedValueOnce([{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }])
        .mockResolvedValueOnce([]),
    }

    const preview = await helpers.buildAttendanceGroupFixedSchedulePreview(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(preview).toEqual({
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Group has no members to schedule',
    })
    expect(db.query).toHaveBeenCalledTimes(3)
  })
})
