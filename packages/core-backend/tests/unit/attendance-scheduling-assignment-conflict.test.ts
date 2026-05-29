import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

const provenanceMigrationSource = readFileSync(
  new URL('../../src/db/migrations/zzzz20260528200000_add_attendance_shift_assignment_provenance.ts', import.meta.url),
  'utf8',
)

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

  it('maps optional shift-assignment producer metadata without claiming legacy rows', () => {
    expect(helpers.mapAssignmentRow({
      id: 'assignment-legacy',
      org_id: 'org-a',
      user_id: 'user-a',
      shift_id: 'shift-a',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      is_active: true,
    })).toEqual(expect.objectContaining({
      producerType: null,
      producerRefId: null,
      producerKey: null,
      producerRunId: null,
    }))

    expect(helpers.mapAssignmentRow({
      id: 'assignment-managed',
      org_id: 'org-a',
      user_id: 'user-a',
      shift_id: 'shift-a',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      is_active: true,
      producer_type: 'attendance_group_fixed_schedule',
      producer_ref_id: '11111111-1111-4111-8111-111111111111',
      producer_key: 'attendance_group_fixed_schedule:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:2026-06-01:2026-06-30',
      producer_run_id: '33333333-3333-4333-8333-333333333333',
    })).toEqual(expect.objectContaining({
      producerType: 'attendance_group_fixed_schedule',
      producerRefId: '11111111-1111-4111-8111-111111111111',
      producerKey: 'attendance_group_fixed_schedule:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:2026-06-01:2026-06-30',
      producerRunId: '33333333-3333-4333-8333-333333333333',
      producer_type: 'attendance_group_fixed_schedule',
      producer_ref_id: '11111111-1111-4111-8111-111111111111',
      producer_key: 'attendance_group_fixed_schedule:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:2026-06-01:2026-06-30',
      producer_run_id: '33333333-3333-4333-8333-333333333333',
    }))
  })

  it('adds nullable shift-assignment producer metadata without creating a second schedule fact table', () => {
    expect(provenanceMigrationSource).toContain("addColumnIfNotExists(db, TABLE_NAME, 'producer_type', 'text')")
    expect(provenanceMigrationSource).toContain("addColumnIfNotExists(db, TABLE_NAME, 'producer_ref_id', 'uuid')")
    expect(provenanceMigrationSource).toContain("addColumnIfNotExists(db, TABLE_NAME, 'producer_key', 'text')")
    expect(provenanceMigrationSource).toContain("addColumnIfNotExists(db, TABLE_NAME, 'producer_run_id', 'uuid')")
    expect(provenanceMigrationSource).toContain('chk_attendance_shift_assignments_producer_metadata')
    expect(provenanceMigrationSource).toContain('producer_type IS NULL')
    expect(provenanceMigrationSource).toContain('producer_run_id IS NOT NULL')
    expect(provenanceMigrationSource).toContain('idx_attendance_shift_assignments_producer_key')
    expect(provenanceMigrationSource).toContain('idx_attendance_shift_assignments_producer_ref')
    expect(provenanceMigrationSource).not.toContain("createTable('attendance_group")
    expect(provenanceMigrationSource).not.toContain("createTable('attendance_schedule")
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

  it('applies fixed-schedule group plans by locking users, skipping exact matches, and inserting only missing rows', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }])
        .mockResolvedValueOnce([{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }])
        .mockResolvedValueOnce([{ user_id: 'user-create' }, { user_id: 'user-skip' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'assignment-skip',
            user_id: 'user-skip',
            shift_id: 'shift-a',
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            kind: 'shift',
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'assignment-created',
            org_id: 'org-a',
            user_id: 'user-create',
            shift_id: 'shift-a',
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            is_active: true,
          },
        ]),
    }

    const result = await helpers.applyAttendanceGroupFixedSchedule(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(result.ok).toBe(true)
    expect(result.data.wouldCreate.map((item: any) => item.userId)).toEqual(['user-create'])
    expect(result.data.skipped.map((item: any) => item.userId)).toEqual(['user-skip'])
    expect(result.data.blockingConflicts).toEqual([])
    expect(result.data.created).toEqual([
      expect.objectContaining({
        id: 'assignment-created',
        orgId: 'org-a',
        userId: 'user-create',
        shiftId: 'shift-a',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        isActive: true,
      }),
    ])

    const queries = db.query.mock.calls.map(call => String(call[0]))
    expect(queries.filter(sql => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2)
    expect(queries.filter(sql => /\bINSERT INTO attendance_shift_assignments\b/i.test(sql))).toHaveLength(1)
  })

  it('refuses fixed-schedule group applies without inserting when a blocking conflict exists', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }])
        .mockResolvedValueOnce([{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }])
        .mockResolvedValueOnce([{ user_id: 'user-conflict' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'assignment-conflict',
            user_id: 'user-conflict',
            shift_id: 'shift-b',
            start_date: '2026-06-10',
            end_date: '2026-06-20',
            kind: 'shift',
          },
        ])
        .mockResolvedValueOnce([]),
    }

    const result = await helpers.applyAttendanceGroupFixedSchedule(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: 'ATTENDANCE_GROUP_FIXED_SCHEDULE_BLOCKING_CONFLICT',
    })
    expect(result.details.blockingConflicts.map((item: any) => item.userId)).toEqual(['user-conflict'])
    const queries = db.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(queries).not.toMatch(/\bINSERT INTO attendance_shift_assignments\b/i)
  })
})
