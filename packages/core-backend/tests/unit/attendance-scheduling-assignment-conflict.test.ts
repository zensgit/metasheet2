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

  it('evaluates schedule-edit windows from the earliest affected date', () => {
    expect(helpers.evaluateShiftEditWindow(undefined, ['2026-05-01'], '2026-06-01')).toBeNull()
    expect(helpers.evaluateShiftEditWindow({ mode: 'unrestricted' }, ['2026-05-01'], '2026-06-01')).toBeNull()
    expect(helpers.evaluateShiftEditWindow({ mode: 'past_locked' }, ['2026-06-01'], '2026-06-01')).toBeNull()
    expect(helpers.evaluateShiftEditWindow({ mode: 'past_locked' }, ['2026-05-31'], '2026-06-01')).toEqual({
      earliest: '2026-05-31',
      boundary: '2026-06-01',
      mode: 'past_locked',
    })
    expect(helpers.evaluateShiftEditWindow(
      { mode: 'past_within_window', windowDays: 7 },
      ['2026-05-25', '2026-06-10'],
      '2026-06-01',
    )).toBeNull()
    expect(helpers.evaluateShiftEditWindow(
      { mode: 'past_within_window', windowDays: 7 },
      ['2026-05-24', '2026-06-10'],
      '2026-06-01',
    )).toEqual({
      earliest: '2026-05-24',
      boundary: '2026-05-25',
      mode: 'past_within_window',
    })
  })

  it('normalizes and deep-merges schedule-edit policy settings', () => {
    expect(helpers.normalizeShiftEditPolicySetting(undefined)).toEqual({ mode: 'unrestricted', windowDays: 0 })
    expect(helpers.normalizeShiftEditPolicySetting({ mode: 'past_within_window', windowDays: '3.9' }))
      .toEqual({ mode: 'past_within_window', windowDays: 3 })
    expect(helpers.normalizeShiftEditPolicySetting({ mode: 'surprise', windowDays: -1 }))
      .toEqual({ mode: 'unrestricted', windowDays: 0 })

    const merged = helpers.mergeSettings(
      { shiftEditPolicy: { mode: 'past_within_window', windowDays: 14 } },
      { shiftEditPolicy: { mode: 'past_locked' } },
    )
    expect(merged.shiftEditPolicy).toEqual({ mode: 'past_locked', windowDays: 14 })
  })

  it('normalizes and nested-deep-merges punch-policy settings (latent S0 foundation)', () => {
    expect(helpers.normalizePunchPolicySetting(undefined)).toEqual({
      unscheduled: { mode: 'allow' },
      merge: { internalWinsOnIn: false, externalWinsOnOut: false },
      outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
    })
    // invalid unscheduled mode -> default allow (no regression); partial fields filled from defaults
    expect(helpers.normalizePunchPolicySetting({ unscheduled: { mode: 'surprise' } }).unscheduled.mode).toBe('allow')
    expect(helpers.normalizePunchPolicySetting({ unscheduled: { mode: 'block' } }).unscheduled.mode).toBe('block')
    expect(helpers.normalizePunchPolicySetting({ outdoor: { requireApproval: true } }).outdoor.requireApproval).toBe(true)

    // nested 2-level merge: updating only `merge` must NOT clear unscheduled / outdoor
    const merged = helpers.mergeSettings(
      { punchPolicy: { unscheduled: { mode: 'block' }, outdoor: { requireApproval: true } } },
      { punchPolicy: { merge: { internalWinsOnIn: true } } },
    )
    expect(merged.punchPolicy).toEqual({
      unscheduled: { mode: 'block' },
      merge: { internalWinsOnIn: true, externalWinsOnOut: false },
      outdoor: { requireApproval: true, requireNote: false, requirePhoto: false, approvalFlowId: '' },
    })
  })

  it('normalizes and merges shift-compliance settings (latent S0 foundation)', () => {
    expect(helpers.normalizeShiftComplianceSetting(undefined)).toEqual({
      enforcement: 'block',
      dailyMaxMinutes: null,
      weeklyMaxMinutes: null,
      monthlyMaxMinutes: null,
    })
    expect(helpers.normalizeShiftComplianceSetting({
      enforcement: 'warn',
      dailyMaxMinutes: '480.9',
      weeklyMaxMinutes: 0,
      monthlyMaxMinutes: -1,
    })).toEqual({
      enforcement: 'warn',
      dailyMaxMinutes: 480,
      weeklyMaxMinutes: null,
      monthlyMaxMinutes: null,
    })
    expect(helpers.normalizeShiftComplianceSetting({ enforcement: 'surprise', dailyMaxMinutes: '' }))
      .toEqual({ enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null })

    const merged = helpers.mergeSettings(
      { shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: 480, monthlyMaxMinutes: 9600 } },
      { shiftCompliance: { weeklyMaxMinutes: 2400 } },
    )
    expect(merged.shiftCompliance).toEqual({
      enforcement: 'warn',
      dailyMaxMinutes: 480,
      weeklyMaxMinutes: 2400,
      monthlyMaxMinutes: 9600,
    })
  })

  it('isUserScheduledForDate locks the fixed/free applicability guard + scheduled_shift coverage', async () => {
    // 1st db.query -> group-type rows; 2nd (reached only when applicable) -> coverage rows
    const mkDb = (groups: unknown[], coverage: unknown[]) => ({
      query: vi.fn().mockResolvedValueOnce(groups).mockResolvedValueOnce(coverage),
    })
    const fn = helpers.isUserScheduledForDate
    // fixed_shift / free_time / mixed-with-non-scheduled / no-group -> NOT applicable -> scheduled (never blocked)
    expect(await fn(mkDb([{ attendance_type: 'fixed_shift' }], []), 'o', 'u', '2026-06-02')).toBe(true)
    expect(await fn(mkDb([{ attendance_type: 'free_time' }], []), 'o', 'u', '2026-06-02')).toBe(true)
    expect(await fn(mkDb([{ attendance_type: 'scheduled_shift' }, { attendance_type: 'fixed_shift' }], []), 'o', 'u', '2026-06-02')).toBe(true)
    expect(await fn(mkDb([], []), 'o', 'u', '2026-06-02')).toBe(true)
    // EVERY group scheduled_shift + NO schedule/assignment coverage -> unscheduled (false) -> blockable
    expect(await fn(mkDb([{ attendance_type: 'scheduled_shift' }], []), 'o', 'u', '2026-06-02')).toBe(false)
    // EVERY group scheduled_shift + coverage present -> scheduled (true)
    expect(await fn(mkDb([{ attendance_type: 'scheduled_shift' }], [{ ok: 1 }]), 'o', 'u', '2026-06-02')).toBe(true)
    // missing user / invalid date -> scheduled (no block), short-circuits before any DB call
    expect(await fn(mkDb([], []), 'o', '', '2026-06-02')).toBe(true)
    expect(await fn(mkDb([], []), 'o', 'u', 'not-a-date')).toBe(true)
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

  it('builds stable fixed-schedule producer keys for finite and open-ended windows', () => {
    const input = {
      orgId: 'org-a',
      groupId: '11111111-1111-4111-8111-111111111111',
      shiftId: '22222222-2222-4222-8222-222222222222',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    }

    expect(helpers.ATTENDANCE_GROUP_FIXED_SCHEDULE_PRODUCER_TYPE).toBe('attendance_group_fixed_schedule')
    expect(helpers.buildAttendanceGroupFixedScheduleProducerKey(input)).toBe(
      'attendance_group_fixed_schedule:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:2026-06-01:2026-06-30',
    )
    expect(helpers.buildAttendanceGroupFixedScheduleProducerKey({
      ...input,
      endDate: null,
    })).toBe(
      'attendance_group_fixed_schedule:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:2026-06-01:null',
    )
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
        ownership: 'unmanaged',
        producerType: null,
        producerRefId: null,
        producerKey: null,
      },
    ])
    expect(preview.data.skippedManaged).toEqual([])
    expect(preview.data.skippedUnmanaged).toEqual(preview.data.skipped)
    expect(preview.data.skippedExternalManaged).toEqual([])
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
    const pendingRows = [
      [{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }],
      [{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }],
      [{ user_id: 'user-create' }, { user_id: 'user-skip' }],
      [],
      [],
      [
        {
          id: 'assignment-skip',
          user_id: 'user-skip',
          shift_id: 'shift-a',
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          kind: 'shift',
        },
      ],
      [],
    ]
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (/\bINSERT INTO attendance_shift_assignments\b/i.test(String(sql))) {
          return [
            {
              id: 'assignment-created',
              org_id: params[1],
              user_id: params[2],
              shift_id: params[3],
              start_date: params[4],
              end_date: params[5],
              is_active: true,
              producer_type: params[6],
              producer_ref_id: params[7],
              producer_key: params[8],
              producer_run_id: params[9],
            },
          ]
        }
        return pendingRows.shift() ?? []
      }),
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
        producerType: 'attendance_group_fixed_schedule',
        producerRefId: 'group-a',
        producerKey: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
      }),
    ])

    const queries = db.query.mock.calls.map(call => String(call[0]))
    const insertCalls = db.query.mock.calls.filter(call => /\bINSERT INTO attendance_shift_assignments\b/i.test(String(call[0])))
    expect(queries.filter(sql => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0][0]).toContain('producer_type, producer_ref_id, producer_key, producer_run_id')
    expect(insertCalls[0][1]).toEqual(expect.arrayContaining([
      'attendance_group_fixed_schedule',
      'group-a',
      'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
    ]))
    expect(insertCalls[0][1][9]).toMatch(/^[0-9a-f-]{36}$/i)
    expect(queries.join('\n')).not.toMatch(/\bUPDATE attendance_shift_assignments\b/i)
  })

  it('uses one producer run id across multiple fixed-schedule creates without mutating skips', async () => {
    const pendingRows = [
      [{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }],
      [{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }],
      [{ user_id: 'user-a' }, { user_id: 'user-b' }, { user_id: 'user-skip' }],
      [],
      [],
      [],
      [
        {
          id: 'assignment-skip',
          user_id: 'user-skip',
          shift_id: 'shift-a',
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          kind: 'shift',
        },
      ],
      [],
    ]
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (/\bINSERT INTO attendance_shift_assignments\b/i.test(String(sql))) {
          return [
            {
              id: params[0],
              org_id: params[1],
              user_id: params[2],
              shift_id: params[3],
              start_date: params[4],
              end_date: params[5],
              is_active: true,
              producer_type: params[6],
              producer_ref_id: params[7],
              producer_key: params[8],
              producer_run_id: params[9],
            },
          ]
        }
        return pendingRows.shift() ?? []
      }),
    }

    const result = await helpers.applyAttendanceGroupFixedSchedule(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(result.ok).toBe(true)
    expect(result.data.created.map((item: any) => item.userId)).toEqual(['user-a', 'user-b'])
    expect(result.data.skipped.map((item: any) => item.userId)).toEqual(['user-skip'])
    expect(new Set(result.data.created.map((item: any) => item.producerRunId))).toHaveLength(1)
    expect(new Set(result.data.created.map((item: any) => item.producerKey))).toEqual(new Set([
      'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
    ]))

    const queries = db.query.mock.calls.map(call => String(call[0]))
    expect(queries.filter(sql => /\bINSERT INTO attendance_shift_assignments\b/i.test(sql))).toHaveLength(2)
    expect(queries.join('\n')).not.toMatch(/\bUPDATE attendance_shift_assignments\b/i)
  })

  it('leaves open-ended fixed-schedule creates under an explicit null-ended producer key', async () => {
    const pendingRows = [
      [{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }],
      [{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }],
      [{ user_id: 'user-a' }],
      [],
      [],
      [],
      [],
    ]
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (/\bINSERT INTO attendance_shift_assignments\b/i.test(String(sql))) {
          return [
            {
              id: params[0],
              org_id: params[1],
              user_id: params[2],
              shift_id: params[3],
              start_date: params[4],
              end_date: params[5],
              is_active: true,
              producer_type: params[6],
              producer_ref_id: params[7],
              producer_key: params[8],
              producer_run_id: params[9],
            },
          ]
        }
        return pendingRows.shift() ?? []
      }),
    }

    const result = await helpers.applyAttendanceGroupFixedSchedule(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: null,
    })

    expect(result.ok).toBe(true)
    expect(result.data.created).toEqual([
      expect.objectContaining({
        userId: 'user-a',
        endDate: null,
        producerKey: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:null',
      }),
    ])
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

  it('rebuilds managed fixed schedules by creating missing rows and soft-deactivating stale managed rows only', async () => {
    const producerKey = 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30'
    const managedRows = [
      {
        id: '00000000-0000-4000-8000-000000000101',
        user_id: 'user-managed',
        shift_id: 'shift-a',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        is_active: true,
        producer_type: 'attendance_group_fixed_schedule',
        producer_ref_id: 'group-a',
        producer_key: producerKey,
        producer_run_id: '00000000-0000-4000-8000-000000000001',
        kind: 'shift',
      },
      {
        id: '00000000-0000-4000-8000-000000000102',
        user_id: 'user-stale',
        shift_id: 'shift-a',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        is_active: true,
        producer_type: 'attendance_group_fixed_schedule',
        producer_ref_id: 'group-a',
        producer_key: producerKey,
        producer_run_id: '00000000-0000-4000-8000-000000000001',
        kind: 'shift',
      },
    ]
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const text = String(sql)
        if (/FROM attendance_groups/.test(text)) return [{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }]
        if (/FROM attendance_shifts/.test(text)) return [{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }]
        if (/FROM attendance_group_members/.test(text)) return [{ user_id: 'user-create' }, { user_id: 'user-managed' }, { user_id: 'user-unmanaged' }]
        if (/pg_advisory_xact_lock/.test(text)) return []
        if (/\bINSERT INTO attendance_shift_assignments\b/i.test(text)) {
          return [{
            id: '00000000-0000-4000-8000-000000000201',
            org_id: params[1],
            user_id: params[2],
            shift_id: params[3],
            start_date: params[4],
            end_date: params[5],
            is_active: true,
            producer_type: params[6],
            producer_ref_id: params[7],
            producer_key: params[8],
            producer_run_id: params[9],
          }]
        }
        if (/\bUPDATE attendance_shift_assignments\b/i.test(text)) {
          return [{
            ...managedRows[1],
            is_active: false,
          }]
        }
        if (/producer_type = \$2/.test(text) && /producer_key = \$4/.test(text)) return managedRows
        if (/FROM attendance_shift_assignments/.test(text) && /user_id = ANY/.test(text)) {
          return [
            managedRows[0],
            {
              id: '00000000-0000-4000-8000-000000000103',
              user_id: 'user-unmanaged',
              shift_id: 'shift-a',
              start_date: '2026-06-01',
              end_date: '2026-06-30',
              kind: 'shift',
            },
          ]
        }
        if (/FROM attendance_rotation_assignments/.test(text)) return []
        return []
      }),
    }

    const result = await helpers.rebuildAttendanceGroupFixedSchedule(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(result.ok).toBe(true)
    expect(result.data.created.map((item: any) => item.userId)).toEqual(['user-create'])
    expect(result.data.deactivated.map((item: any) => item.id)).toEqual(['00000000-0000-4000-8000-000000000102'])
    expect(result.data.skippedManaged.map((item: any) => item.userId)).toEqual(['user-managed'])
    expect(result.data.skippedUnmanaged.map((item: any) => item.userId)).toEqual(['user-unmanaged'])
    expect(result.data.skippedExternalManaged).toEqual([])

    const queries = db.query.mock.calls.map(call => String(call[0]))
    const updateCalls = db.query.mock.calls.filter(call => /\bUPDATE attendance_shift_assignments\b/i.test(String(call[0])))
    expect(queries.filter(sql => sql.includes('pg_advisory_xact_lock'))).toHaveLength(6)
    expect(queries.filter(sql => /\bINSERT INTO attendance_shift_assignments\b/i.test(sql))).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0][0]).toContain('producer_key = $4')
    expect(updateCalls[0][1][4]).toEqual(['00000000-0000-4000-8000-000000000102'])
    expect(queries.join('\n')).not.toMatch(/\bDELETE FROM attendance_shift_assignments\b/i)
  })

  it('refuses managed fixed-schedule rebuilds when another managed window blocks the target', async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql)
        if (/FROM attendance_groups/.test(text)) return [{ id: 'group-a', org_id: 'org-a', name: 'Operations', timezone: 'UTC' }]
        if (/FROM attendance_shifts/.test(text)) return [{ id: 'shift-a', org_id: 'org-a', name: 'Day shift', timezone: 'UTC' }]
        if (/FROM attendance_group_members/.test(text)) return [{ user_id: 'user-a' }]
        if (/pg_advisory_xact_lock/.test(text)) return []
        if (/producer_type = \$2/.test(text) && /producer_key = \$4/.test(text)) return []
        if (/FROM attendance_shift_assignments/.test(text) && /user_id = ANY/.test(text)) {
          return [{
            id: '00000000-0000-4000-8000-000000000301',
            user_id: 'user-a',
            shift_id: 'shift-a',
            start_date: '2026-05-15',
            end_date: '2026-06-15',
            producer_type: 'attendance_group_fixed_schedule',
            producer_ref_id: 'group-a',
            producer_key: 'attendance_group_fixed_schedule:group-a:shift-a:2026-05-15:2026-06-15',
            producer_run_id: '00000000-0000-4000-8000-000000000003',
            kind: 'shift',
          }]
        }
        if (/FROM attendance_rotation_assignments/.test(text)) return []
        return []
      }),
    }

    const result = await helpers.rebuildAttendanceGroupFixedSchedule(db, {
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
    expect(result.details.blockingConflicts[0]).toEqual(expect.objectContaining({
      userId: 'user-a',
      managedScheduleAction: 'clear_existing_managed_schedule_first',
    }))
    const queries = db.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(queries).not.toMatch(/\bINSERT INTO attendance_shift_assignments\b/i)
    expect(queries).not.toMatch(/\bUPDATE attendance_shift_assignments\b/i)
  })

  it('clears only managed rows for the exact fixed-schedule producer key', async () => {
    const managedRows = [
      {
        id: '00000000-0000-4000-8000-000000000401',
        user_id: 'user-a',
        shift_id: 'shift-a',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        is_active: true,
        producer_type: 'attendance_group_fixed_schedule',
        producer_ref_id: 'group-a',
        producer_key: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
        producer_run_id: '00000000-0000-4000-8000-000000000004',
      },
      {
        id: '00000000-0000-4000-8000-000000000402',
        user_id: 'user-b',
        shift_id: 'shift-a',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        is_active: true,
        producer_type: 'attendance_group_fixed_schedule',
        producer_ref_id: 'group-a',
        producer_key: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
        producer_run_id: '00000000-0000-4000-8000-000000000004',
      },
    ]
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const text = String(sql)
        if (/pg_advisory_xact_lock/.test(text)) return []
        if (/\bUPDATE attendance_shift_assignments\b/i.test(text)) {
          return managedRows
            .filter(row => params[4].includes(row.id))
            .map(row => ({ ...row, is_active: false }))
        }
        if (/producer_type = \$2/.test(text) && /producer_key = \$4/.test(text)) return managedRows
        return []
      }),
    }

    const result = await helpers.clearAttendanceGroupFixedScheduleManagedRows(db, {
      orgId: 'org-a',
      groupId: 'group-a',
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(result.ok).toBe(true)
    expect(result.data.producer).toEqual({
      type: 'attendance_group_fixed_schedule',
      refId: 'group-a',
      key: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
    })
    expect(result.data.deactivated.map((item: any) => item.id)).toEqual([
      '00000000-0000-4000-8000-000000000401',
      '00000000-0000-4000-8000-000000000402',
    ])
    const queries = db.query.mock.calls.map(call => String(call[0]))
    const updateCalls = db.query.mock.calls.filter(call => /\bUPDATE attendance_shift_assignments\b/i.test(String(call[0])))
    expect(queries.filter(sql => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0][0]).toContain('producer_ref_id = $3')
    expect(updateCalls[0][0]).toContain('producer_key = $4')
    expect(updateCalls[0][1][4]).toEqual([
      '00000000-0000-4000-8000-000000000401',
      '00000000-0000-4000-8000-000000000402',
    ])
    expect(queries.join('\n')).not.toMatch(/\bDELETE FROM attendance_shift_assignments\b/i)
  })
})
