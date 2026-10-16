/**
 * #5982 — approved leave cancel must rewrite the legacy/shadow live attendance
 * row from remaining approved minutes and punches, without statusOverride.
 * Authoritative projection stays on P14 and is not recalculated here.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const {
  recalculateLiveAttendanceRecordAfterApprovedLeaveCancel,
  shouldRecalculateLiveRecordAfterApprovedLeaveCancel,
} = attendancePlugin.__attendanceLeaveCancellationForTests as {
  recalculateLiveAttendanceRecordAfterApprovedLeaveCancel: (
    trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
    args: { orgId: string; userId: string; workDate: string },
  ) => Promise<{ rewritten: boolean; reason: string; record?: { status?: string } }>
  shouldRecalculateLiveRecordAfterApprovedLeaveCancel: (posture: string | undefined) => boolean
}

const resetAttendanceSettingsCacheForTests = attendancePlugin.resetAttendanceSettingsCacheForTests as () => void

const PLUGIN_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../plugins/plugin-attendance/index.cjs'),
  'utf8',
)

const ORG = 'default'
const USER = 'user-5982'
const WORKDAY = '2026-09-21' // Monday
const WEEKEND = '2026-09-20' // Sunday

type Row = Record<string, unknown>

function legacyRow(overrides: Row = {}): Row {
  return {
    user_id: USER,
    org_id: ORG,
    work_date: WORKDAY,
    timezone: 'UTC',
    first_in_at: null,
    last_out_at: null,
    work_minutes: 0,
    late_minutes: 0,
    early_leave_minutes: 0,
    status: 'adjusted',
    is_workday: true,
    meta: {},
    source_batch_id: null,
    projection_owner: 'legacy_untracked',
    current_calculation_id: null,
    visibility_state: 'active',
    visibility_reason: 'active',
    ...overrides,
  }
}

function makeTrx(options: {
  existing?: Row | null
  approved?: Array<{ request_type: string; total_minutes: number }>
}) {
  const writes: unknown[][] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM attendance_records WHERE user_id/.test(sql)) {
      return options.existing ? [options.existing] : []
    }
    if (/FROM attendance_rules/.test(sql)) return []
    if (/FROM attendance_holidays/.test(sql)) return []
    if (/FROM attendance_rotation_assignments/.test(sql)) return []
    if (/FROM attendance_shift_assignments/.test(sql)) return []
    if (/FROM system_configs/.test(sql)) return []
    if (/FROM attendance_requests/.test(sql) && /status = 'approved'/.test(sql)) {
      return options.approved ?? []
    }
    if (/INSERT INTO attendance_records/.test(sql)) {
      writes.push(params ?? [])
      return [{ status: params?.[9], work_minutes: params?.[6], late_minutes: params?.[7], early_leave_minutes: params?.[8] }]
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 240)}`)
  })
  return { trx: { query }, writes }
}

function writtenStatus(writes: unknown[][]) {
  expect(writes).toHaveLength(1)
  return {
    status: writes[0][9],
    workMinutes: writes[0][6],
    lateMinutes: writes[0][7],
    earlyLeaveMinutes: writes[0][8],
    isWorkday: writes[0][10],
  }
}

describe('approved leave cancel live-record recalculation (#5982)', () => {
  beforeEach(() => {
    resetAttendanceSettingsCacheForTests()
  })

  it('recalculates legacy and shadow, and leaves authoritative to P14', () => {
    expect(shouldRecalculateLiveRecordAfterApprovedLeaveCancel('legacy_projection_only')).toBe(true)
    expect(shouldRecalculateLiveRecordAfterApprovedLeaveCancel('shadow')).toBe(true)
    expect(shouldRecalculateLiveRecordAfterApprovedLeaveCancel(undefined)).toBe(true)
    expect(shouldRecalculateLiveRecordAfterApprovedLeaveCancel('authoritative')).toBe(false)
  })

  it('wires the helper into executeRequestCancel after the balance reverse, and only off the authoritative posture', () => {
    const start = PLUGIN_SOURCE.indexOf('execute: async function executeRequestCancel')
    const end = PLUGIN_SOURCE.indexOf('function resolveRequestDecisionExpectedValue', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = PLUGIN_SOURCE.slice(start, end)
    const reverseAt = body.indexOf('reverseLeaveBalanceDeduction')
    const recalcAt = body.indexOf('recalculateLiveAttendanceRecordAfterApprovedLeaveCancel')
    expect(reverseAt).toBeGreaterThan(0)
    expect(recalcAt).toBeGreaterThan(reverseAt)
    expect(body).toContain(
      'if (approvedLeave && shouldRecalculateLiveRecordAfterApprovedLeaveCancel(operation.acceptedWritePosture))',
    )
    expect(body).not.toMatch(/statusOverride:\s*'adjusted'/)
  })

  it('full-day leave with no punch: adjusted → absent once remaining leave minutes are 0', async () => {
    const { trx, writes } = makeTrx({ existing: legacyRow(), approved: [] })
    const result = await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })
    expect(result).toMatchObject({ rewritten: true, reason: 'recalculated' })
    expect(writtenStatus(writes)).toMatchObject({
      status: 'absent',
      workMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      isWorkday: true,
    })
  })

  it('keeps adjusted when another approved leave still covers the day', async () => {
    const { trx, writes } = makeTrx({
      existing: legacyRow(),
      approved: [{ request_type: 'leave', total_minutes: 120 }],
    })
    await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })
    expect(writtenStatus(writes).status).toBe('adjusted')
  })

  it('on-time punches drop from adjusted back to normal after the leave is gone', async () => {
    const { trx, writes } = makeTrx({
      existing: legacyRow({
        first_in_at: new Date('2026-09-21T09:00:00.000Z'),
        last_out_at: new Date('2026-09-21T18:00:00.000Z'),
      }),
      approved: [],
    })
    await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })
    expect(writtenStatus(writes)).toMatchObject({
      status: 'normal',
      workMinutes: 540,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    })
  })

  it('late punches return to late instead of staying adjusted', async () => {
    const { trx, writes } = makeTrx({
      existing: legacyRow({
        first_in_at: new Date('2026-09-21T09:30:00.000Z'),
        last_out_at: new Date('2026-09-21T18:00:00.000Z'),
      }),
      approved: [],
    })
    await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })
    expect(writtenStatus(writes)).toMatchObject({
      status: 'late',
      lateMinutes: 20,
      earlyLeaveMinutes: 0,
    })
  })

  it('a non-workday with no punch settles on off, not absent', async () => {
    const { trx, writes } = makeTrx({
      existing: legacyRow({ work_date: WEEKEND, is_workday: false, status: 'off' }),
      approved: [],
    })
    await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WEEKEND,
    })
    expect(writtenStatus(writes)).toMatchObject({ status: 'off', isWorkday: false, workMinutes: 0 })
  })

  it('does not insert a row, touch a retired parent, or overwrite a W4-owned parent', async () => {
    const missing = makeTrx({ existing: null })
    await expect(recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(missing.trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })).resolves.toEqual({ rewritten: false, reason: 'missing' })
    expect(missing.writes).toEqual([])

    const retired = makeTrx({
      existing: legacyRow({ visibility_state: 'retired', visibility_reason: 'operator_retirement' }),
    })
    await expect(recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(retired.trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })).resolves.toEqual({ rewritten: false, reason: 'retired' })
    expect(retired.writes).toEqual([])

    const owned = makeTrx({
      existing: legacyRow({ projection_owner: 'w4', current_calculation_id: '11111111-1111-1111-1111-111111111111' }),
    })
    await expect(recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(owned.trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })).resolves.toEqual({ rewritten: false, reason: 'w4_owned' })
    expect(owned.writes).toEqual([])
  })

  it('preserves a manual result edit instead of treating it as the leave override', async () => {
    const correctedAgainst = {
      workDate: WORKDAY,
      firstInAt: null,
      lastOutAt: null,
      isWorkday: true,
    }
    const { trx, writes } = makeTrx({
      existing: legacyRow({
        status: 'normal',
        meta: {
          manual_result_edit: {
            version: 1,
            correctedAgainst,
            reviewConflict: null,
          },
        },
      }),
      approved: [],
    })
    await recalculateLiveAttendanceRecordAfterApprovedLeaveCancel(trx, {
      orgId: ORG,
      userId: USER,
      workDate: WORKDAY,
    })
    expect(writtenStatus(writes).status).toBe('normal')
  })
})
