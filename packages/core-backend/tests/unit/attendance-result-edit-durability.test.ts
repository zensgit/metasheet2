import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

const {
  buildManualResultEditFactFingerprint,
  computeAttendanceRecordUpsertValues,
} = helpers as {
  buildManualResultEditFactFingerprint: (value: Record<string, unknown>) => Record<string, unknown>
  computeAttendanceRecordUpsertValues: (options: Record<string, unknown>) => {
    firstInAt: Date | null
    lastOutAt: Date | null
    workMinutes: number
    lateMinutes: number
    earlyLeaveMinutes: number
    status: string
    metaJson: string
  }
}

const rule = {
  orgId: 'org-ae1b',
  timezone: 'UTC',
  workStartTime: '09:00',
  workEndTime: '18:00',
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  severeLateThresholdMinutes: 30,
  absenceLateThresholdMinutes: 60,
  roundingMinutes: 5,
  isOvernight: false,
}

function existingCorrectedRecord(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 'record-ae1b',
    user_id: 'user-ae1b',
    org_id: 'org-ae1b',
    work_date: '2026-09-21',
    first_in_at: new Date('2026-09-21T09:35:00.000Z'),
    last_out_at: new Date('2026-09-21T18:00:00.000Z'),
    work_minutes: 480,
    late_minutes: 0,
    early_leave_minutes: 0,
    status: 'normal',
    is_workday: true,
  }
  return {
    ...base,
    meta: {
      severe_late_count: 0,
      severe_late_minutes: 0,
      absence_late_count: 0,
      manual_result_edit: {
        version: 1,
        auditId: 'audit-ae1b',
        idempotencyKey: 'idem-ae1b',
        targetStatus: 'normal',
        correctedMetrics: {
          workMinutes: 480,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
        },
        correctedAgainst: buildManualResultEditFactFingerprint(base),
        editedAt: '2026-09-21T19:00:00.000Z',
        actorUserId: 'admin-ae1b',
        reviewConflict: null,
      },
    },
    ...overrides,
  }
}

function computeFromExisting(existingRow: Record<string, unknown>, updateFirstInAt: Date, statusOverride: string | null = null) {
  return computeAttendanceRecordUpsertValues({
    existingRow,
    updateFirstInAt,
    updateLastOutAt: new Date('2026-09-21T18:00:00.000Z'),
    workDate: '2026-09-21',
    mode: 'override',
    statusOverride,
    isWorkday: true,
    meta: { source: { source: 'unit-recompute' } },
    rule,
    leaveMinutes: 0,
    overtimeMinutes: 0,
  })
}

describe('AE-1b corrected-fact durability marker', () => {
  it('preserves a corrected result on no-statusOverride recompute when material facts are unchanged', () => {
    const values = computeFromExisting(
      existingCorrectedRecord(),
      new Date('2026-09-21T09:35:00.000Z'),
    )
    const meta = JSON.parse(values.metaJson)

    expect(values.status).toBe('normal')
    expect(values.workMinutes).toBe(480)
    expect(values.lateMinutes).toBe(0)
    expect(values.earlyLeaveMinutes).toBe(0)
    expect(meta.manual_result_edit.targetStatus).toBe('normal')
    expect(meta.manual_result_edit.reviewConflict).toBeNull()
    expect(meta.severe_late_count).toBe(0)
    expect(meta.absence_late_count).toBe(0)
  })

  it('preserves the correction but flags reviewConflict when no-statusOverride recompute changes material facts', () => {
    const values = computeFromExisting(
      existingCorrectedRecord(),
      new Date('2026-09-21T09:55:00.000Z'),
    )
    const meta = JSON.parse(values.metaJson)

    expect(values.firstInAt?.toISOString()).toBe('2026-09-21T09:55:00.000Z')
    expect(values.status).toBe('normal')
    expect(values.workMinutes).toBe(480)
    expect(values.lateMinutes).toBe(0)
    expect(values.earlyLeaveMinutes).toBe(0)
    expect(meta.manual_result_edit.reviewConflict).toMatchObject({
      state: 'needs_review',
      source: 'derived_recompute',
      attemptedDerivedStatus: 'late',
      latestFacts: {
        workDate: '2026-09-21',
        firstInAt: '2026-09-21T09:55:00.000Z',
        lastOutAt: '2026-09-21T18:00:00.000Z',
        isWorkday: true,
      },
    })
    expect(typeof meta.manual_result_edit.reviewConflict.detectedAt).toBe('string')
  })

  it('treats explicit statusOverride as intentional and clears the stale manual marker', () => {
    const values = computeFromExisting(
      existingCorrectedRecord(),
      new Date('2026-09-21T09:55:00.000Z'),
      'adjusted',
    )
    const meta = JSON.parse(values.metaJson)

    expect(values.status).toBe('adjusted')
    expect(values.lateMinutes).toBe(45)
    expect(meta.manual_result_edit).toBeUndefined()
  })
})
